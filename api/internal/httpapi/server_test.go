package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestHealth(t *testing.T) {
	handler := NewServer().Handler()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}

	if !strings.Contains(rec.Body.String(), `"status":"ok"`) {
		t.Fatalf("expected ok health response, got %s", rec.Body.String())
	}
}

func TestMaxUploadBytesFromEnvironment(t *testing.T) {
	t.Setenv("MAX_UPLOAD_BYTES", "150000")
	handler := NewServer().Handler()

	healthReq := httptest.NewRequest(http.MethodGet, "/health", nil)
	healthRec := httptest.NewRecorder()
	handler.ServeHTTP(healthRec, healthReq)

	if !strings.Contains(healthRec.Body.String(), `"maxUploadBytes":150000`) {
		t.Fatalf("expected configured maxUploadBytes, got %s", healthRec.Body.String())
	}

	req := newMultipartUploadRequest(t, "/api/weighing-slip/upload", "certificate.jpg", bytes.Repeat([]byte("a"), 140000))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}
}

func TestUploadWeighingSlip(t *testing.T) {
	handler := NewServer().Handler()

	req := newMultipartUploadRequest(t, "/api/weighing-slip/upload", "certificate.jpg", []byte("fake image bytes"))
	setTestHeaders(req, "worker-001", "000001")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var response UploadResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}

	if response.UploadID == "" {
		t.Fatal("expected upload id")
	}
	if response.Trace.TestRunID != "CERT-20260617-001" {
		t.Fatalf("expected trace test run id, got %q", response.Trace.TestRunID)
	}
	if response.FileName != "certificate.jpg" {
		t.Fatalf("expected uploaded file name, got %q", response.FileName)
	}
	if response.SizeBytes != int64(len("fake image bytes")) {
		t.Fatalf("expected uploaded file size, got %d", response.SizeBytes)
	}
}

func TestParallelUploadWeighingSlip(t *testing.T) {
	handler := NewServer().Handler()

	const workers = 100
	var wg sync.WaitGroup
	errs := make(chan string, workers)

	for worker := range workers {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()

			req := newMultipartUploadRequest(t, "/api/weighing-slip/upload", "certificate.jpg", bytes.Repeat([]byte("a"), 1024))
			setTestHeaders(req, "worker-"+strconv.Itoa(worker), "000001")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusAccepted {
				errs <- "expected accepted, got " + strconv.Itoa(rec.Code) + ": " + rec.Body.String()
			}
		}(worker)
	}

	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatal(err)
	}

	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRec := httptest.NewRecorder()
	handler.ServeHTTP(metricsRec, metricsReq)

	body := metricsRec.Body.String()
	if !strings.Contains(body, "swat_upload_accepted_total 100") {
		t.Fatalf("expected upload accepted metric to reach 100, got:\n%s", body)
	}
}

func TestUploadWeighingSlipRejectsOversizedFile(t *testing.T) {
	handler := NewServer().Handler()

	req := newMultipartUploadRequest(t, "/api/weighing-slip/upload", "large.jpg", bytes.Repeat([]byte("a"), defaultMaxUploadBytes+1))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
}

func TestCreateAndListWeighing(t *testing.T) {
	handler := NewServer().Handler()

	createBody := strings.NewReader(`{
		"ticketId": "ticket_123",
		"vehicleNo": "12가3456",
		"grossWeightKg": 25000,
		"tareWeightKg": 10000
	}`)
	createReq := httptest.NewRequest(http.MethodPost, "/api/weighing-data", createBody)
	createReq.Header.Set("Content-Type", "application/json")
	setTestHeaders(createReq, "worker-001", "000001")
	createRec := httptest.NewRecorder()

	handler.ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, createRec.Code, createRec.Body.String())
	}

	var createResponse struct {
		Item  WeighingRecord `json:"item"`
		Trace TestRequestIDs `json:"trace"`
	}
	if err := json.NewDecoder(createRec.Body).Decode(&createResponse); err != nil {
		t.Fatal(err)
	}
	if createResponse.Item.NetWeightKg != 15000 {
		t.Fatalf("expected net weight 15000, got %d", createResponse.Item.NetWeightKg)
	}
	if createResponse.Trace.WorkerID != "worker-001" {
		t.Fatalf("expected worker trace, got %q", createResponse.Trace.WorkerID)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/weighings?ticketId=ticket_123", nil)
	listRec := httptest.NewRecorder()

	handler.ServeHTTP(listRec, listReq)

	if listRec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, listRec.Code, listRec.Body.String())
	}

	var response struct {
		Items []WeighingRecord `json:"items"`
	}
	if err := json.NewDecoder(listRec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}

	if len(response.Items) != 1 {
		t.Fatalf("expected one weighing, got %d", len(response.Items))
	}
	if response.Items[0].TicketID != "ticket_123" {
		t.Fatalf("expected ticket_123, got %q", response.Items[0].TicketID)
	}
}

func TestCreateBulkWeighing(t *testing.T) {
	handler := NewServer().Handler()

	createBody := strings.NewReader(`{
		"items": [
			{
				"ticketId": "ticket_001",
				"vehicleNo": "12가3456",
				"grossWeightKg": 25000,
				"tareWeightKg": 10000
			},
			{
				"ticketId": "ticket_002",
				"vehicleNo": "34나7890",
				"grossWeightKg": 30000,
				"tareWeightKg": 12000
			}
		]
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/weighing-data/bulk", createBody)
	req.Header.Set("Content-Type", "application/json")
	setTestHeaders(req, "worker-001", "000001")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d: %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var response BulkWeighingResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}

	if response.RowCount != 2 {
		t.Fatalf("expected row count 2, got %d", response.RowCount)
	}
	if response.APICount != 1 {
		t.Fatalf("expected api count 1, got %d", response.APICount)
	}
}

func TestCreateTestResult(t *testing.T) {
	handler := NewServer().Handler()

	body := strings.NewReader(`{
		"testRunId": "CERT-20260617-001",
		"testType": "image-upload",
		"targetTps": 100,
		"workerCount": 100,
		"workerTps": 1,
		"durationSec": 600,
		"sentCount": 60000,
		"successCount": 60000,
		"failCount": 0,
		"averageLatencyMs": 25.5,
		"p95LatencyMs": 50.1,
		"p99LatencyMs": 90.2
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/test-result", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}
}

func newMultipartUploadRequest(t *testing.T, path string, fileName string, content []byte) *http.Request {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, path, &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	return req
}

func setTestHeaders(req *http.Request, workerID string, requestSeq string) {
	req.Header.Set("X-Test-Run-Id", "CERT-20260617-001")
	req.Header.Set("X-Test-Client-Type", "web")
	req.Header.Set("X-Test-Device-Id", "android-01")
	req.Header.Set("X-Test-Worker-Id", workerID)
	req.Header.Set("X-Test-Request-Seq", requestSeq)
}
