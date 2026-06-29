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
	"time"
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

	var createResponse CreateWeighingResponse
	if err := json.NewDecoder(createRec.Body).Decode(&createResponse); err != nil {
		t.Fatal(err)
	}
	if createResponse.Item.NetWeightKg != 15000 {
		t.Fatalf("expected net weight 15000, got %d", createResponse.Item.NetWeightKg)
	}
	if createResponse.Trace.WorkerID != "worker-001" {
		t.Fatalf("expected worker trace, got %q", createResponse.Trace.WorkerID)
	}
	if createResponse.Request.TicketID != "ticket_123" {
		t.Fatalf("expected echoed request ticket, got %q", createResponse.Request.TicketID)
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

func TestAsyncUploadWithoutOCRMarksDisabled(t *testing.T) {
	handler := NewServer().Handler()

	req := newMultipartUploadRequest(t, "/api/weighing-slip/upload", "certificate.jpg", []byte("fake image bytes"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var response UploadResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}

	result := fetchOCRResult(t, handler, response.UploadID)
	if result.Status != ocrStatusDisabled {
		t.Fatalf("expected ocr status %q, got %q", ocrStatusDisabled, result.Status)
	}
}

func TestUploadOnlySkipsOCR(t *testing.T) {
	t.Setenv("OCR_API_URL", "http://127.0.0.1:0")
	handler := NewServer().Handler()

	req := newMultipartUploadRequest(t, "/api/weighing-slip/upload-only", "certificate.jpg", []byte("fake image bytes"))
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

	resultReq := httptest.NewRequest(http.MethodGet, "/api/weighing-slip/ocr-result/"+response.UploadID, nil)
	resultRec := httptest.NewRecorder()
	handler.ServeHTTP(resultRec, resultReq)
	if resultRec.Code != http.StatusNotFound {
		t.Fatalf("expected no ocr result for upload-only, got %d: %s", resultRec.Code, resultRec.Body.String())
	}

	statusReq := httptest.NewRequest(http.MethodGet, "/api/weighing-slip/ocr-status", nil)
	statusRec := httptest.NewRecorder()
	handler.ServeHTTP(statusRec, statusReq)
	var status OCRStatusResponse
	if err := json.NewDecoder(statusRec.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Summary.Enqueued != 0 {
		t.Fatalf("expected no ocr jobs enqueued, got %d", status.Summary.Enqueued)
	}
}

func TestSyncUploadRunsOCR(t *testing.T) {
	ocr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("ocr stub parse: %v", err)
		}
		if _, _, err := r.FormFile("file"); err != nil {
			t.Errorf("ocr stub missing file: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"provider":"upstage","parsed":{"ocr_amount":"2520"},"final":{"ocr.amount":"2520","ocr.car_number":"87더2150"}}`))
	}))
	defer ocr.Close()

	t.Setenv("OCR_API_URL", ocr.URL)
	handler := NewServer().Handler()

	req := newMultipartUploadRequest(t, "/api/weighing-slip/upload-sync", "certificate.jpg", []byte("fake image bytes"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response SyncUploadResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Status != ocrStatusDone {
		t.Fatalf("expected status %q, got %q", ocrStatusDone, response.Status)
	}
	if response.OCRStatusCode != http.StatusOK {
		t.Fatalf("expected ocr status code 200, got %d", response.OCRStatusCode)
	}
	if !strings.Contains(string(response.Result), "2520") {
		t.Fatalf("expected ocr result body, got %s", string(response.Result))
	}
	if response.Provider != "upstage" {
		t.Fatalf("expected provider upstage, got %q", response.Provider)
	}
	if !strings.Contains(string(response.Final), "ocr.amount") {
		t.Fatalf("expected final mapped body, got %s", string(response.Final))
	}
}

func TestAsyncUploadRunsOCRInBackground(t *testing.T) {
	ocr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"provider":"upstage","parsed":{"ocr_amount":"2520"},"final":{"ocr.amount":"2520","ocr.car_number":"87더2150"}}`))
	}))
	defer ocr.Close()

	t.Setenv("OCR_API_URL", ocr.URL)
	handler := NewServer().Handler()

	req := newMultipartUploadRequest(t, "/api/weighing-slip/upload", "certificate.jpg", []byte("fake image bytes"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d: %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var response UploadResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		result := fetchOCRResult(t, handler, response.UploadID)
		if result.Status == ocrStatusDone {
			if !strings.Contains(string(result.Result), "2520") {
				t.Fatalf("expected ocr result body, got %s", string(result.Result))
			}
			if result.Provider != "upstage" {
				t.Fatalf("expected provider upstage, got %q", result.Provider)
			}
			if !strings.Contains(string(result.Final), "ocr.car_number") {
				t.Fatalf("expected final mapped body, got %s", string(result.Final))
			}
			return
		}
		if result.Status == ocrStatusError {
			t.Fatalf("async ocr failed: %s", result.Error)
		}
		if time.Now().After(deadline) {
			t.Fatalf("async ocr did not finish, last status %q", result.Status)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestOCRStatusEndpoint(t *testing.T) {
	ocr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"provider":"upstage","parsed":{"ocr_amount":"2520"},"final":{"ocr.amount":"2520"}}`))
	}))
	defer ocr.Close()

	t.Setenv("OCR_API_URL", ocr.URL)
	handler := NewServer().Handler()

	req := newMultipartUploadRequest(t, "/api/weighing-slip/upload", "certificate.jpg", []byte("fake image bytes"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	var response UploadResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		result := fetchOCRResult(t, handler, response.UploadID)
		if result.Status == ocrStatusDone {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("async ocr did not finish, last status %q", result.Status)
		}
		time.Sleep(20 * time.Millisecond)
	}

	statusReq := httptest.NewRequest(http.MethodGet, "/api/weighing-slip/ocr-status?limit=10", nil)
	statusRec := httptest.NewRecorder()
	handler.ServeHTTP(statusRec, statusReq)

	if statusRec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d: %s", http.StatusOK, statusRec.Code, statusRec.Body.String())
	}

	var status OCRStatusResponse
	if err := json.NewDecoder(statusRec.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}

	if !status.Summary.Enabled {
		t.Fatal("expected ocr to be enabled")
	}
	if status.Summary.Success < 1 {
		t.Fatalf("expected at least one success, got %d", status.Summary.Success)
	}
	if len(status.Items) == 0 {
		t.Fatal("expected at least one status item")
	}
	if status.Items[0].UploadID != response.UploadID {
		t.Fatalf("expected most recent item %q, got %q", response.UploadID, status.Items[0].UploadID)
	}
	if status.Items[0].Status != ocrStatusDone {
		t.Fatalf("expected item status done, got %q", status.Items[0].Status)
	}
	if status.Items[0].Provider != "upstage" {
		t.Fatalf("expected provider upstage, got %q", status.Items[0].Provider)
	}
	if !strings.Contains(string(status.Items[0].Final), "ocr.amount") {
		t.Fatalf("expected final mapped body, got %s", string(status.Items[0].Final))
	}
}

func fetchOCRResult(t *testing.T, handler http.Handler, uploadID string) OCRResult {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/api/weighing-slip/ocr-result/"+uploadID, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d for ocr-result, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var result OCRResult
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
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
