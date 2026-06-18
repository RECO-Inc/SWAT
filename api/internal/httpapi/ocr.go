package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultOCRPath          = "/ocr"
	defaultOCRTimeout       = 30 * time.Second
	defaultOCRAsyncWorkers  = 16
	defaultOCRAsyncQueue    = 1024
	defaultOCRMaxResults    = 200000
	maxOCRResponseBodyBytes = 1 << 20
)

// ocrClient forwards weighing-slip images to the external OCR service.
type ocrClient struct {
	httpClient *http.Client
	endpoint   string
	enabled    bool
	// timeout bounds a single OCR call. Zero means no timeout, so queued async
	// jobs run to completion no matter how slow the OCR service is.
	timeout time.Duration
}

func newOCRClient() *ocrClient {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("OCR_API_URL")), "/")
	if base == "" {
		return &ocrClient{enabled: false}
	}

	path := strings.TrimSpace(os.Getenv("OCR_API_PATH"))
	if path == "" {
		path = defaultOCRPath
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	endpoint := base + path + "?map=" + strconv.FormatBool(envBool("OCR_MAP", true))

	transport := &http.Transport{
		MaxIdleConns:        512,
		MaxIdleConnsPerHost: 512,
		IdleConnTimeout:     90 * time.Second,
	}

	return &ocrClient{
		// No client-level timeout: timeouts are applied per call via context so
		// async background jobs can be fully decoupled (OCR_TIMEOUT_MS=0).
		httpClient: &http.Client{Transport: transport},
		endpoint:   endpoint,
		enabled:    true,
		timeout:    ocrTimeoutFromEnv(),
	}
}

// callCtx wraps a parent context with the configured OCR timeout. When the
// timeout is zero the parent context is returned unchanged (no deadline).
func (c *ocrClient) callCtx(parent context.Context) (context.Context, context.CancelFunc) {
	if c.timeout <= 0 {
		return parent, func() {}
	}
	return context.WithTimeout(parent, c.timeout)
}

// ocrTimeoutFromEnv reads OCR_TIMEOUT_MS. Unset uses the default; an explicit 0
// (or negative) disables the per-call timeout entirely.
func ocrTimeoutFromEnv() time.Duration {
	value := strings.TrimSpace(os.Getenv("OCR_TIMEOUT_MS"))
	if value == "" {
		return defaultOCRTimeout
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0
	}
	return time.Duration(parsed) * time.Millisecond
}

// call posts the image to the OCR service and returns its status code and body.
func (c *ocrClient) call(ctx context.Context, fileName string, data []byte) (int, json.RawMessage, error) {
	if fileName == "" {
		fileName = "upload.jpg"
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		return 0, nil, fmt.Errorf("build ocr request: %w", err)
	}
	if _, err := part.Write(data); err != nil {
		return 0, nil, fmt.Errorf("write ocr payload: %w", err)
	}
	if err := writer.Close(); err != nil {
		return 0, nil, fmt.Errorf("finalize ocr request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, &body)
	if err != nil {
		return 0, nil, fmt.Errorf("create ocr request: %w", err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("call ocr service: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxOCRResponseBodyBytes))
	if err != nil {
		return resp.StatusCode, nil, fmt.Errorf("read ocr response: %w", err)
	}

	return resp.StatusCode, json.RawMessage(raw), nil
}

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
