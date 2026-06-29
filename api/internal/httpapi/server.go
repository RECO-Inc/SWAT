package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

const (
	defaultMaxUploadBytes = 100 << 10
	maxRequestBodySize    = 2 << 20
	auditQueueSize        = 4096
)

type Server struct {
	mux *http.ServeMux

	mu          sync.RWMutex
	weighings   []WeighingRecord
	testResults []TestResult

	uploadJobs chan UploadJob
	auditJobs  chan AuditJob
	metrics    *serverMetrics

	maxUploadBytes int64

	ocr           *ocrClient
	ocrMu         sync.RWMutex
	ocrResults    map[string]*OCRResult
	ocrOrder      []string
	maxOCRResults int
}

type UploadResponse struct {
	UploadID  string         `json:"uploadId"`
	FileName  string         `json:"fileName"`
	SizeBytes int64          `json:"sizeBytes"`
	Status    string         `json:"status"`
	Trace     TestRequestIDs `json:"trace"`
}

type TestResult struct {
	TestRunID      string    `json:"testRunId"`
	TestType       string    `json:"testType"`
	TargetTPS      int       `json:"targetTps"`
	WorkerCount    int       `json:"workerCount"`
	WorkerTPS      int       `json:"workerTps"`
	DurationSec    int       `json:"durationSec"`
	SentCount      int64     `json:"sentCount"`
	SuccessCount   int64     `json:"successCount"`
	FailCount      int64     `json:"failCount"`
	AverageLatency float64   `json:"averageLatencyMs"`
	P95Latency     float64   `json:"p95LatencyMs"`
	P99Latency     float64   `json:"p99LatencyMs"`
	SubmittedAt    time.Time `json:"submittedAt"`
}

type TestRequestIDs struct {
	TestRunID     string `json:"testRunId,omitempty"`
	ClientType    string `json:"clientType,omitempty"`
	DeviceID      string `json:"deviceId,omitempty"`
	WorkerID      string `json:"workerId,omitempty"`
	RequestSeq    string `json:"requestSeq,omitempty"`
	RequestID     string `json:"requestId"`
	ReceivedAtUTC string `json:"receivedAtUtc"`
}

type UploadJob struct {
	UploadID  string
	FileName  string
	Data      []byte
	SizeBytes int64
	Trace     TestRequestIDs
	QueuedAt  time.Time
}

// OCRResult tracks the outcome of forwarding one upload to the OCR service.
type OCRResult struct {
	UploadID      string          `json:"uploadId"`
	FileName      string          `json:"fileName"`
	SizeBytes     int64           `json:"sizeBytes"`
	Mode          string          `json:"mode"`
	Status        string          `json:"status"`
	OCRStatusCode int             `json:"ocrStatusCode,omitempty"`
	Provider      string          `json:"provider,omitempty"`
	Parsed        json.RawMessage `json:"parsed,omitempty"`
	Final         json.RawMessage `json:"final,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
	Error         string          `json:"error,omitempty"`
	Trace         TestRequestIDs  `json:"trace"`
	QueuedAt      time.Time       `json:"queuedAt"`
	StartedAt     *time.Time      `json:"startedAt,omitempty"`
	FinishedAt    *time.Time      `json:"finishedAt,omitempty"`
	LatencyMs     float64         `json:"latencyMs,omitempty"`
}

// SyncUploadResponse is returned by the synchronous OCR upload endpoint.
type SyncUploadResponse struct {
	UploadID      string          `json:"uploadId"`
	FileName      string          `json:"fileName"`
	SizeBytes     int64           `json:"sizeBytes"`
	Status        string          `json:"status"`
	OCRStatusCode int             `json:"ocrStatusCode"`
	LatencyMs     float64         `json:"latencyMs"`
	Provider      string          `json:"provider,omitempty"`
	Parsed        json.RawMessage `json:"parsed,omitempty"`
	Final         json.RawMessage `json:"final,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
	Trace         TestRequestIDs  `json:"trace"`
}

// OCRStatusItem is a lightweight view of an OCRResult for the live status list
// (it omits the full OCR result body to keep the payload small).
type OCRStatusItem struct {
	UploadID      string          `json:"uploadId"`
	FileName      string          `json:"fileName"`
	SizeBytes     int64           `json:"sizeBytes"`
	Mode          string          `json:"mode"`
	Status        string          `json:"status"`
	OCRStatusCode int             `json:"ocrStatusCode,omitempty"`
	LatencyMs     float64         `json:"latencyMs,omitempty"`
	Error         string          `json:"error,omitempty"`
	Provider      string          `json:"provider,omitempty"`
	Parsed        json.RawMessage `json:"parsed,omitempty"`
	Final         json.RawMessage `json:"final,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
	QueuedAt      time.Time       `json:"queuedAt"`
	StartedAt     *time.Time      `json:"startedAt,omitempty"`
	FinishedAt    *time.Time      `json:"finishedAt,omitempty"`
}

// OCRStatusSummary aggregates the live OCR pipeline counters.
type OCRStatusSummary struct {
	Enabled       bool   `json:"enabled"`
	QueueDepth    int    `json:"queueDepth"`
	QueueCapacity int    `json:"queueCapacity"`
	Pending       int64  `json:"pending"`
	Enqueued      int64  `json:"enqueued"`
	Dropped       int64  `json:"dropped"`
	Success       int64  `json:"success"`
	Error         int64  `json:"error"`
	Stored        int    `json:"stored"`
	GeneratedAt   string `json:"generatedAt"`
}

// OCRStatusResponse is the payload for GET /api/weighing-slip/ocr-status.
type OCRStatusResponse struct {
	Summary OCRStatusSummary `json:"summary"`
	Items   []OCRStatusItem  `json:"items"`
}

const (
	ocrStatusPending  = "pending"
	ocrStatusDone     = "done"
	ocrStatusError    = "error"
	ocrStatusDropped  = "dropped"
	ocrStatusDisabled = "disabled"

	ocrModeAsync = "async"
	ocrModeSync  = "sync"
)

type AuditJob struct {
	Endpoint   string
	StatusCode int
	Trace      TestRequestIDs
	QueuedAt   time.Time
}

type errorResponse struct {
	Error string `json:"error"`
}

func NewServer() *Server {
	server := &Server{
		mux:            http.NewServeMux(),
		uploadJobs:     make(chan UploadJob, envInt("OCR_ASYNC_QUEUE", defaultOCRAsyncQueue)),
		auditJobs:      make(chan AuditJob, auditQueueSize),
		maxUploadBytes: maxUploadBytesFromEnv(),
		ocr:            newOCRClient(),
		ocrResults:     make(map[string]*OCRResult),
		maxOCRResults:  envInt("OCR_MAX_RESULTS", defaultOCRMaxResults),
		weighings: []WeighingRecord{
			{
				ID:            "wgt_sample_001",
				TicketID:      "ticket_sample_001",
				VehicleNo:     "sample-vehicle",
				GrossWeightKg: 24000,
				TareWeightKg:  9000,
				NetWeightKg:   15000,
				RecordedAt:    time.Date(2026, 6, 17, 0, 0, 0, 0, time.UTC),
			},
		},
	}

	reg := prometheus.NewRegistry()
	server.metrics = newServerMetrics(reg, server)

	server.routes()
	server.startAsyncWorkers()

	return server
}

func (s *Server) Handler() http.Handler {
	return withCORS(s.withMetrics(s.mux))
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /health", s.health)
	s.mux.HandleFunc("GET /healthz", s.health)
	s.mux.Handle("GET /metrics", s.metrics.handler())
	s.mux.HandleFunc("POST /api/weighing-slip/upload", s.uploadWeighingSlip)
	s.mux.HandleFunc("POST /api/weighing-slip/upload-only", s.uploadWeighingSlipOnly)
	s.mux.HandleFunc("POST /api/weighing-slip/upload-sync", s.uploadWeighingSlipSync)
	s.mux.HandleFunc("GET /api/weighing-slip/ocr-status", s.ocrStatus)
	s.mux.HandleFunc("GET /api/weighing-slip/ocr-result/{uploadId}", s.getOCRResult)
	s.mux.HandleFunc("GET /api/weighing-data", s.listWeighingData)
	s.mux.HandleFunc("POST /api/weighing-data", s.createWeighing)
	s.mux.HandleFunc("POST /api/weighing-data/bulk", s.createBulkWeighing)
	s.mux.HandleFunc("POST /api/test-result", s.createTestResult)

	// Temporary aliases keep the initial MVP endpoints usable while the frontend catches up.
	s.mux.HandleFunc("POST /v1/certificates/uploads", s.uploadWeighingSlip)
	s.mux.HandleFunc("GET /v1/weighings", s.listWeighings)
	s.mux.HandleFunc("POST /v1/weighings", s.createWeighing)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":           "ok",
		"targetTps":        100,
		"workerModel":      "100 logical workers x 1 TPS",
		"maxUploadBytes":   s.maxUploadBytes,
		"uploadQueueDepth": len(s.uploadJobs),
		"ocrEnabled":       s.ocr.enabled,
		"ocrPending":       s.metrics.ocrPendingCount.Load(),
		"ocrSuccess":       s.metrics.ocrSuccessCount.Load(),
		"ocrError":         s.metrics.ocrErrorCount.Load(),
		"ocrDropped":       s.metrics.ocrDroppedCount.Load(),
	})
}

// uploadWeighingSlip accepts the image, responds immediately, and forwards the
// file to the OCR service in the background. The OCR outcome is retrievable via
// GET /api/weighing-slip/ocr-result/{uploadId}.
func (s *Server) uploadWeighingSlip(w http.ResponseWriter, r *http.Request) {
	trace := testRequestIDs(r)
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUploadBytes+4096)

	fileName, data, sizeBytes, err := readMultipartFileBytes(r, "file", s.maxUploadBytes)
	if err != nil {
		s.metrics.uploadRejected.Inc()
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	uploadID, err := prefixedID("upl")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create upload id")
		return
	}

	now := time.Now().UTC()
	result := &OCRResult{
		UploadID:  uploadID,
		FileName:  fileName,
		SizeBytes: sizeBytes,
		Mode:      ocrModeAsync,
		Status:    ocrStatusPending,
		Trace:     trace,
		QueuedAt:  now,
	}

	s.metrics.uploadAccepted.Inc()
	s.metrics.uploadBytesTotal.Add(float64(sizeBytes))

	if !s.ocr.enabled {
		result.Status = ocrStatusDisabled
		s.putOCRResult(result)
	} else {
		s.putOCRResult(result)
		job := UploadJob{
			UploadID:  uploadID,
			FileName:  fileName,
			Data:      data,
			SizeBytes: sizeBytes,
			Trace:     trace,
			QueuedAt:  now,
		}
		if s.enqueueUpload(job) {
			s.metrics.incOCREnqueued()
			s.metrics.incOCRPending()
		} else {
			s.metrics.incOCRDropped()
			s.markOCRResult(uploadID, func(res *OCRResult) {
				res.Status = ocrStatusDropped
				res.Error = "ocr queue is full"
			})
		}
	}

	writeJSON(w, http.StatusAccepted, UploadResponse{
		UploadID:  uploadID,
		FileName:  fileName,
		SizeBytes: sizeBytes,
		Status:    "accepted",
		Trace:     trace,
	})
}

// uploadWeighingSlipOnly accepts the image and responds immediately without any
// OCR forwarding. It is the pure upload path for measuring upload TPS in
// isolation from OCR throughput.
func (s *Server) uploadWeighingSlipOnly(w http.ResponseWriter, r *http.Request) {
	trace := testRequestIDs(r)
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUploadBytes+4096)

	fileName, sizeBytes, err := readMultipartFileMeta(r, "file", s.maxUploadBytes)
	if err != nil {
		s.metrics.uploadRejected.Inc()
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	uploadID, err := prefixedID("upl")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create upload id")
		return
	}

	s.metrics.uploadAccepted.Inc()
	s.metrics.uploadBytesTotal.Add(float64(sizeBytes))

	writeJSON(w, http.StatusAccepted, UploadResponse{
		UploadID:  uploadID,
		FileName:  fileName,
		SizeBytes: sizeBytes,
		Status:    "accepted",
		Trace:     trace,
	})
}

// uploadWeighingSlipSync accepts the image, runs OCR inline, and only responds
// once the OCR service has returned a result.
func (s *Server) uploadWeighingSlipSync(w http.ResponseWriter, r *http.Request) {
	trace := testRequestIDs(r)
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUploadBytes+4096)

	fileName, data, sizeBytes, err := readMultipartFileBytes(r, "file", s.maxUploadBytes)
	if err != nil {
		s.metrics.uploadRejected.Inc()
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	uploadID, err := prefixedID("upl")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create upload id")
		return
	}

	s.metrics.uploadAccepted.Inc()
	s.metrics.uploadBytesTotal.Add(float64(sizeBytes))

	if !s.ocr.enabled {
		writeError(w, http.StatusServiceUnavailable, "ocr service is not configured")
		return
	}

	ctx, cancel := s.ocr.callCtx(r.Context())
	defer cancel()

	start := time.Now()
	statusCode, raw, callErr := s.ocr.call(ctx, fileName, data)
	latencyMs := float64(time.Since(start).Microseconds()) / 1000
	summary := summarizeOCRPayload(raw)

	if callErr != nil {
		s.metrics.incOCRError()
		writeError(w, http.StatusBadGateway, "ocr request failed: "+callErr.Error())
		return
	}
	if statusCode >= http.StatusBadRequest {
		s.metrics.incOCRError()
		writeJSON(w, http.StatusBadGateway, SyncUploadResponse{
			UploadID:      uploadID,
			FileName:      fileName,
			SizeBytes:     sizeBytes,
			Status:        ocrStatusError,
			OCRStatusCode: statusCode,
			LatencyMs:     latencyMs,
			Provider:      summary.Provider,
			Parsed:        summary.Parsed,
			Final:         summary.Final,
			Result:        raw,
			Trace:         trace,
		})
		return
	}

	s.metrics.incOCRSuccess()
	writeJSON(w, http.StatusOK, SyncUploadResponse{
		UploadID:      uploadID,
		FileName:      fileName,
		SizeBytes:     sizeBytes,
		Status:        ocrStatusDone,
		OCRStatusCode: statusCode,
		LatencyMs:     latencyMs,
		Provider:      summary.Provider,
		Parsed:        summary.Parsed,
		Final:         summary.Final,
		Result:        raw,
		Trace:         trace,
	})
}

func (s *Server) getOCRResult(w http.ResponseWriter, r *http.Request) {
	uploadID := r.PathValue("uploadId")

	s.ocrMu.RLock()
	result, ok := s.ocrResults[uploadID]
	s.ocrMu.RUnlock()

	if !ok {
		writeError(w, http.StatusNotFound, "ocr result not found for upload id")
		return
	}

	writeJSON(w, http.StatusOK, result)
}

// ocrStatus returns the live OCR pipeline summary plus the most recent results.
// Query params: limit (default 50, max 500), status (optional filter).
func (s *Server) ocrStatus(w http.ResponseWriter, r *http.Request) {
	const maxScan = 5000
	limit := clampInt(parseQueryInt(r.URL.Query().Get("limit"), 50), 1, 500)
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))

	s.ocrMu.RLock()
	items := make([]OCRStatusItem, 0, limit)
	scanned := 0
	for i := len(s.ocrOrder) - 1; i >= 0 && len(items) < limit && scanned < maxScan; i-- {
		result, ok := s.ocrResults[s.ocrOrder[i]]
		if !ok {
			continue
		}
		scanned++
		if statusFilter != "" && result.Status != statusFilter {
			continue
		}
		items = append(items, OCRStatusItem{
			UploadID:      result.UploadID,
			FileName:      result.FileName,
			SizeBytes:     result.SizeBytes,
			Mode:          result.Mode,
			Status:        result.Status,
			OCRStatusCode: result.OCRStatusCode,
			LatencyMs:     result.LatencyMs,
			Error:         result.Error,
			Provider:      result.Provider,
			Parsed:        result.Parsed,
			Final:         result.Final,
			Result:        result.Result,
			QueuedAt:      result.QueuedAt,
			StartedAt:     result.StartedAt,
			FinishedAt:    result.FinishedAt,
		})
	}
	stored := len(s.ocrResults)
	s.ocrMu.RUnlock()

	writeJSON(w, http.StatusOK, OCRStatusResponse{
		Summary: OCRStatusSummary{
			Enabled:       s.ocr.enabled,
			QueueDepth:    len(s.uploadJobs),
			QueueCapacity: cap(s.uploadJobs),
			Pending:       s.metrics.ocrPendingCount.Load(),
			Enqueued:      s.metrics.ocrEnqueuedCount.Load(),
			Dropped:       s.metrics.ocrDroppedCount.Load(),
			Success:       s.metrics.ocrSuccessCount.Load(),
			Error:         s.metrics.ocrErrorCount.Load(),
			Stored:        stored,
			GeneratedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		},
		Items: items,
	})
}

func (s *Server) listWeighings(w http.ResponseWriter, r *http.Request) {
	ticketID := strings.TrimSpace(r.URL.Query().Get("ticketId"))

	s.mu.RLock()
	defer s.mu.RUnlock()

	records := make([]WeighingRecord, 0, len(s.weighings))
	for _, record := range s.weighings {
		if ticketID == "" || record.TicketID == ticketID {
			records = append(records, record)
		}
	}

	writeJSON(w, http.StatusOK, map[string][]WeighingRecord{"items": records})
}

func (s *Server) createWeighing(w http.ResponseWriter, r *http.Request) {
	trace := testRequestIDs(r)

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)
	var req CreateWeighingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "request body must be valid JSON")
		return
	}

	record, err := newWeighingRecord(req, trace)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	s.mu.Lock()
	s.weighings = append(s.weighings, record)
	s.mu.Unlock()

	s.metrics.weighingRowsTotal.Inc()
	s.enqueueAudit(AuditJob{Endpoint: "/api/weighing-data", StatusCode: http.StatusCreated, Trace: trace, QueuedAt: time.Now().UTC()})

	writeJSON(w, http.StatusCreated, CreateWeighingResponse{
		Request: req,
		Item:    record,
		Trace:   trace,
	})
}

func (s *Server) createBulkWeighing(w http.ResponseWriter, r *http.Request) {
	trace := testRequestIDs(r)

	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)
	var req BulkWeighingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "request body must be valid JSON")
		return
	}

	if len(req.Items) == 0 {
		writeError(w, http.StatusBadRequest, "items must contain at least one weighing record")
		return
	}

	records := make([]WeighingRecord, 0, len(req.Items))
	for _, item := range req.Items {
		record, err := newWeighingRecord(item, trace)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		records = append(records, record)
	}

	s.mu.Lock()
	s.weighings = append(s.weighings, records...)
	s.mu.Unlock()

	s.metrics.weighingRowsTotal.Add(float64(len(records)))
	s.enqueueAudit(AuditJob{Endpoint: "/api/weighing-data/bulk", StatusCode: http.StatusCreated, Trace: trace, QueuedAt: time.Now().UTC()})

	writeJSON(w, http.StatusCreated, BulkWeighingResponse{
		Requests:      req.Items,
		Items:         records,
		APICount:      1,
		RowCount:      len(records),
		Trace:         trace,
		RecordedAt:    time.Now().UTC(),
		RowThroughput: "api_tps x bulk_size",
	})
}

func (s *Server) createTestResult(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodySize)

	var result TestResult
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		writeError(w, http.StatusBadRequest, "request body must be valid JSON")
		return
	}

	if strings.TrimSpace(result.TestRunID) == "" {
		writeError(w, http.StatusBadRequest, "testRunId is required")
		return
	}

	result.SubmittedAt = time.Now().UTC()

	s.mu.Lock()
	s.testResults = append(s.testResults, result)
	s.mu.Unlock()

	s.metrics.testResultsTotal.Inc()

	writeJSON(w, http.StatusAccepted, result)
}

func newWeighingRecordCore(req CreateWeighingRequest) (WeighingRecord, error) {
	if req.GrossWeightKg <= 0 {
		return WeighingRecord{}, errors.New("grossWeightKg must be greater than 0")
	}

	if req.TareWeightKg < 0 {
		return WeighingRecord{}, errors.New("tareWeightKg must be greater than or equal to 0")
	}

	if req.TareWeightKg > req.GrossWeightKg {
		return WeighingRecord{}, errors.New("tareWeightKg must not exceed grossWeightKg")
	}

	id, err := prefixedID("wgt")
	if err != nil {
		return WeighingRecord{}, fmt.Errorf("create weighing id: %w", err)
	}

	ticketID := strings.TrimSpace(req.TicketID)
	if ticketID == "" {
		ticketID, err = prefixedID("ticket")
		if err != nil {
			return WeighingRecord{}, fmt.Errorf("create ticket id: %w", err)
		}
	}

	return WeighingRecord{
		ID:            id,
		TicketID:      ticketID,
		VehicleNo:     strings.TrimSpace(req.VehicleNo),
		GrossWeightKg: req.GrossWeightKg,
		TareWeightKg:  req.TareWeightKg,
		NetWeightKg:   req.GrossWeightKg - req.TareWeightKg,
		RecordedAt:    time.Now().UTC(),
	}, nil
}

func copyMax(dst io.Writer, src io.Reader, maxBytes int64) (int64, error) {
	written, err := io.Copy(dst, io.LimitReader(src, maxBytes+1))
	if err != nil {
		return written, errors.New("failed to read uploaded file")
	}

	if written > maxBytes {
		return written, fmt.Errorf("uploaded file exceeds %d bytes", maxBytes)
	}

	return written, nil
}

// readMultipartFileBytes streams the named multipart file into memory, enforcing
// the configured size limit. Files are <= 100 KB for this testbed, so buffering
// the bytes to forward them to OCR is cheap.
func readMultipartFileBytes(r *http.Request, fieldName string, maxBytes int64) (string, []byte, int64, error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return "", nil, 0, errors.New("request must be multipart/form-data")
	}

	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			return "", nil, 0, fmt.Errorf("multipart field %s is required", fieldName)
		}
		if err != nil {
			return "", nil, 0, errors.New("failed to read multipart body")
		}

		if part.FormName() != fieldName {
			_ = part.Close()
			continue
		}

		fileName := part.FileName()
		var buf bytes.Buffer
		sizeBytes, err := copyMax(&buf, part, maxBytes)
		_ = part.Close()
		if err != nil {
			return "", nil, 0, err
		}

		return fileName, buf.Bytes(), sizeBytes, nil
	}
}

func parseQueryInt(value string, fallback int) int {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func clampInt(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

// readMultipartFileMeta streams the named multipart file to io.Discard,
// returning only its name and size. It avoids buffering the body, which keeps
// the OCR-free upload path as cheap as possible for high-TPS tests.
func readMultipartFileMeta(r *http.Request, fieldName string, maxBytes int64) (string, int64, error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return "", 0, errors.New("request must be multipart/form-data")
	}

	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			return "", 0, fmt.Errorf("multipart field %s is required", fieldName)
		}
		if err != nil {
			return "", 0, errors.New("failed to read multipart body")
		}

		if part.FormName() != fieldName {
			_ = part.Close()
			continue
		}

		fileName := part.FileName()
		sizeBytes, err := copyMax(io.Discard, part, maxBytes)
		_ = part.Close()
		if err != nil {
			return "", 0, err
		}

		return fileName, sizeBytes, nil
	}
}

func maxUploadBytesFromEnv() int64 {
	value := strings.TrimSpace(os.Getenv("MAX_UPLOAD_BYTES"))
	if value == "" {
		return defaultMaxUploadBytes
	}

	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return defaultMaxUploadBytes
	}

	return parsed
}

func testRequestIDs(r *http.Request) TestRequestIDs {
	requestID, err := prefixedID("req")
	if err != nil {
		requestID = "req_unavailable"
	}

	return TestRequestIDs{
		TestRunID:     strings.TrimSpace(r.Header.Get("X-Test-Run-Id")),
		ClientType:    strings.TrimSpace(r.Header.Get("X-Test-Client-Type")),
		DeviceID:      strings.TrimSpace(r.Header.Get("X-Test-Device-Id")),
		WorkerID:      strings.TrimSpace(r.Header.Get("X-Test-Worker-Id")),
		RequestSeq:    strings.TrimSpace(r.Header.Get("X-Test-Request-Seq")),
		RequestID:     requestID,
		ReceivedAtUTC: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func prefixedID(prefix string) (string, error) {
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}

	return prefix + "_" + hex.EncodeToString(bytes[:]), nil
}

func (s *Server) enqueueUpload(job UploadJob) bool {
	select {
	case s.uploadJobs <- job:
		return true
	default:
		s.metrics.asyncDroppedTotal.Inc()
		return false
	}
}

func (s *Server) enqueueAudit(job AuditJob) {
	select {
	case s.auditJobs <- job:
	default:
		s.metrics.asyncDroppedTotal.Inc()
	}
}

func (s *Server) startAsyncWorkers() {
	workerCount := envInt("OCR_ASYNC_WORKERS", defaultOCRAsyncWorkers)
	for range workerCount {
		go func() {
			for job := range s.uploadJobs {
				s.processOCRJob(job)
			}
		}()
	}

	go func() {
		for range s.auditJobs {
			// MVP 1: the worker keeps request-path logging off the hot path.
		}
	}()
}

// processOCRJob forwards a queued upload to the OCR service and records the outcome.
func (s *Server) processOCRJob(job UploadJob) {
	defer s.metrics.decOCRPending()

	start := time.Now()
	s.markOCRResult(job.UploadID, func(res *OCRResult) {
		started := start.UTC()
		res.StartedAt = &started
	})

	ctx, cancel := s.ocr.callCtx(context.Background())
	statusCode, raw, err := s.ocr.call(ctx, job.FileName, job.Data)
	cancel()

	finished := time.Now()
	latencyMs := float64(finished.Sub(start).Microseconds()) / 1000
	finishedUTC := finished.UTC()
	summary := summarizeOCRPayload(raw)

	switch {
	case err != nil:
		s.metrics.incOCRError()
		s.markOCRResult(job.UploadID, func(res *OCRResult) {
			res.Status = ocrStatusError
			res.Error = err.Error()
			res.FinishedAt = &finishedUTC
			res.LatencyMs = latencyMs
		})
	case statusCode >= http.StatusBadRequest:
		s.metrics.incOCRError()
		s.markOCRResult(job.UploadID, func(res *OCRResult) {
			res.Status = ocrStatusError
			res.OCRStatusCode = statusCode
			res.Provider = summary.Provider
			res.Parsed = summary.Parsed
			res.Final = summary.Final
			res.Result = raw
			res.FinishedAt = &finishedUTC
			res.LatencyMs = latencyMs
		})
	default:
		s.metrics.incOCRSuccess()
		s.markOCRResult(job.UploadID, func(res *OCRResult) {
			res.Status = ocrStatusDone
			res.OCRStatusCode = statusCode
			res.Provider = summary.Provider
			res.Parsed = summary.Parsed
			res.Final = summary.Final
			res.Result = raw
			res.FinishedAt = &finishedUTC
			res.LatencyMs = latencyMs
		})
	}
}

func (s *Server) putOCRResult(result *OCRResult) {
	s.ocrMu.Lock()
	defer s.ocrMu.Unlock()

	// Bound memory: drop everything once it grows past the configured cap.
	// Certification runs are restarted between scenarios, so a hard reset is fine.
	if s.maxOCRResults > 0 && len(s.ocrResults) >= s.maxOCRResults {
		s.ocrResults = make(map[string]*OCRResult)
		s.ocrOrder = s.ocrOrder[:0]
	}

	s.ocrResults[result.UploadID] = result
	s.ocrOrder = append(s.ocrOrder, result.UploadID)
}

func (s *Server) markOCRResult(uploadID string, mutate func(*OCRResult)) {
	s.ocrMu.Lock()
	defer s.ocrMu.Unlock()

	if result, ok := s.ocrResults[uploadID]; ok {
		mutate(result)
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", strings.Join([]string{
			"Content-Type",
			"Authorization",
			"X-Test-Run-Id",
			"X-Test-Client-Type",
			"X-Test-Device-Id",
			"X-Test-Worker-Id",
			"X-Test-Request-Seq",
		}, ", "))

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) withMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}

		recorder := &statusRecorder{
			ResponseWriter: w,
			statusCode:     http.StatusOK,
		}

		s.metrics.httpInFlight.Inc()
		start := time.Now()
		next.ServeHTTP(recorder, r)
		s.metrics.httpInFlight.Dec()

		elapsed := time.Since(start).Seconds()
		route := requestRoute(r)
		testRunID := strings.TrimSpace(r.Header.Get("X-Test-Run-Id"))
		s.metrics.observeHTTP(r.Method, route, testRunID, recorder.statusCode, elapsed)

		w.Header().Set("X-SWAT-Handler-Duration-Ms", strconv.FormatInt(time.Since(start).Milliseconds(), 10))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (r *statusRecorder) WriteHeader(statusCode int) {
	r.statusCode = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, statusCode int, message string) {
	writeJSON(w, statusCode, errorResponse{Error: message})
}
