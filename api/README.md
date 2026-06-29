# SWAT API

Go API server for the certification testbed MVP.

The server is shaped around this target:

```text
100 logical workers x 1 request/sec = 100 TPS
```

For MVP 1, uploads and weighing data are accepted in memory. The request path is kept short so the frontend and auxiliary load tests can validate concurrent request handling before PostgreSQL, MinIO, and queue infrastructure are added.

## Run

### Local

```sh
go run ./cmd/server
```

The server listens on `:8080` by default. Override it with `API_ADDR`.

```sh
API_ADDR=:8081 go run ./cmd/server
```

### Docker

Build the API image from the `api` directory:

```sh
docker build -t swat-api .
```

Run only the API server:

```sh
docker run --rm -p 8080:8080 --name swat-api swat-api
```

Override the upload size limit in bytes:

```sh
docker run --rm -p 8080:8080 \
  -e MAX_UPLOAD_BYTES=150000 \
  --name swat-api \
  swat-api
```

Health check:

```sh
curl http://localhost:8080/health
```

### Docker Compose With HAProxy

From the repository root, run HAProxy plus three API containers:

```sh
docker compose up --build
```

Override the upload size limit for all API containers:

```sh
MAX_UPLOAD_BYTES=150000 docker compose up --build
```

Requests should go through HAProxy:

```sh
curl -i http://localhost:8080/health
```

The response includes `X-Backend-Server` so you can see which API container handled the request. HAProxy stats are exposed on `http://localhost:8404`.

## Endpoints

### Health

```sh
curl http://localhost:8080/health
```

### Metrics

```sh
curl http://localhost:8080/metrics
```

The metrics response is Prometheus text format. Key series:

- `swat_http_requests_total{method,route,status_class,test_run_id}` — TPS and success/error breakdown
- `swat_http_request_duration_seconds_bucket{method,route,test_run_id}` — latency histogram for p95/p99
- `swat_upload_*`, `swat_weighing_rows_total`, `swat_ocr_*`, `swat_async_queue_depth`

`test_run_id` is taken from the `X-Test-Run-Id` header (`unknown` when absent). Grafana dashboards and PromQL examples live in `docs/monitoring.md`.

### Upload Weighing Slip Image (Async OCR)

```sh
curl -X POST http://localhost:8080/api/weighing-slip/upload \
  -H "X-Test-Run-Id: CERT-20260617-001" \
  -H "X-Test-Client-Type: web" \
  -H "X-Test-Device-Id: android-01" \
  -H "X-Test-Worker-Id: worker-001" \
  -H "X-Test-Request-Seq: 000001" \
  -F "file=@./sample-certificate.jpg"
```

The file should be a 100 KB-or-less weighing slip image for certification-style tests. This endpoint reads the multipart file, responds immediately with an `uploadId` (HTTP 202), and forwards the image to the OCR service on a background worker pool. Fetch the OCR outcome later:

```sh
curl http://localhost:8080/api/weighing-slip/ocr-result/<uploadId>
```

The result `status` is one of `pending`, `done`, `error`, `dropped` (OCR queue full), or `disabled` (`OCR_API_URL` not set).

### OCR Live Status

```sh
curl "http://localhost:8080/api/weighing-slip/ocr-status?limit=50&status=pending"
```

Returns a `summary` (queue depth/capacity, pending, enqueued, dropped, success, error, stored) plus the most recent `items` (newest first), each with its per-request status, latency, and error. `status` is an optional filter (`pending`/`done`/`error`/`dropped`/`disabled`); `limit` defaults to 50 (max 500). The frontend "OCR 현황" menu polls this endpoint for live monitoring.

The default upload limit is `102400` bytes. Set `MAX_UPLOAD_BYTES` when you need to test larger samples.

### Upload Weighing Slip Image (No OCR)

```sh
curl -X POST http://localhost:8080/api/weighing-slip/upload-only \
  -H "X-Test-Run-Id: CERT-20260617-001" \
  -F "file=@./sample-certificate.jpg"
```

Accepts the image and responds `202` immediately with no OCR forwarding. The body is streamed to discard, so this is the cheapest path and is meant for measuring upload TPS in isolation from OCR throughput.

### Upload Weighing Slip Image (Sync OCR)

```sh
curl -X POST http://localhost:8080/api/weighing-slip/upload-sync \
  -H "X-Test-Run-Id: CERT-20260617-001" \
  -F "file=@./sample-certificate.jpg"
```

This endpoint runs OCR inline and responds (HTTP 200) only after the OCR service returns, including the parsed OCR `result` and `latencyMs`. If `OCR_API_URL` is not configured it returns HTTP 503.

Note: sync mode is bound by the OCR service throughput. If the OCR backend processes requests serially (one at a time), high-concurrency sync load will queue for a long time. Use sync for single/low-concurrency latency checks, and use the async endpoint for high-TPS load tests.

The OCR service currently returns a payload shaped like:

```json
{
  "provider": "upstage",
  "parsed": {
    "ocr_disposal_company_name": "에코사이클",
    "ocr_amount": "2520",
    "ocr_car_number": "87더2150",
    "car_full_weight": "20220",
    "car_empty_weight": "17700",
    "request_id": "...",
    "template_id": ""
  },
  "final": {
    "ocr.full_weight": "20220",
    "ocr.empty_weight": "17700",
    "ocr.amount": "2520",
    "ocr.car_number": "87더2150",
    "ocr.disposal_company": "에코사이클"
  }
}
```

The API keeps the full OCR body in `result` and also exposes `provider`,
`parsed`, and `final` as top-level fields in sync responses and OCR status/result
responses. `final` is present when `OCR_MAP=true` and contains the normalized
fields to inspect first.

### OCR Configuration

OCR forwarding is controlled by environment variables (all optional). Leave `OCR_API_URL` empty to disable OCR.

```text
OCR_API_URL          OCR base URL, e.g. http://192.168.0.9:8718 (empty = disabled)
OCR_API_PATH         OCR endpoint path, default /ocr
OCR_MAP              value of the ?map= query param, default true
OCR_TIMEOUT_MS       per-call OCR timeout in ms; 0 = unlimited (default 30000 if unset)
OCR_ASYNC_WORKERS    background OCR worker count, default 16
OCR_ASYNC_QUEUE      async OCR queue capacity, default 1024
API_WRITE_TIMEOUT_MS HTTP write timeout in ms; 0 = disabled (default), so slow
                     synchronous OCR is not reset mid-request
```

For fully decoupled async behavior set `OCR_TIMEOUT_MS=0` (the provided `.env`
does this): the upload returns `202` immediately and the queued OCR job runs to
completion no matter how slow the OCR service is. When the OCR backend cannot keep
up at the incoming rate, the async queue fills and excess jobs are counted as
`dropped` (the upload still returns `202`; no client error).

OCR counters are exposed in `/metrics` (`swat_ocr_enqueued_total`, `swat_ocr_dropped_total`, `swat_ocr_success_total`, `swat_ocr_error_total`, `swat_ocr_pending`) and summarized in `/health`.

### Create Weighing Data

```sh
curl -X POST http://localhost:8080/api/weighing-data \
  -H "Content-Type: application/json" \
  -H "X-Test-Run-Id: CERT-20260617-001" \
  -H "X-Test-Client-Type: web" \
  -H "X-Test-Device-Id: windows-01" \
  -H "X-Test-Worker-Id: worker-001" \
  -H "X-Test-Request-Seq: 000001" \
  -d '{
    "ticketId": "ticket_123",
    "vehicleNo": "12가3456",
    "grossWeightKg": 25000,
    "tareWeightKg": 10000
  }'
```

### Create Bulk Weighing Data

```sh
curl -X POST http://localhost:8080/api/weighing-data/bulk \
  -H "Content-Type: application/json" \
  -H "X-Test-Run-Id: CERT-20260617-001" \
  -H "X-Test-Client-Type: web" \
  -H "X-Test-Device-Id: windows-01" \
  -H "X-Test-Worker-Id: worker-001" \
  -H "X-Test-Request-Seq: 000001" \
  -d '{
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
  }'
```

Bulk tests should report API TPS and row throughput separately. Example: `100 API TPS x bulk size 10 = 1,000 rows/sec`.

### Submit Client Test Result

```sh
curl -X POST http://localhost:8080/api/test-result \
  -H "Content-Type: application/json" \
  -d '{
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
  }'
```

## Required Test Headers

Every generated request should include these headers so logs and metrics can be filtered by certification run:

```text
X-Test-Run-Id: CERT-20260617-001
X-Test-Client-Type: web
X-Test-Device-Id: android-01
X-Test-Worker-Id: worker-001
X-Test-Request-Seq: 000001
```

## Load Model

The official target should be generated as 1 TPS per logical worker:

```text
worker-001 -> 1 request/sec
worker-002 -> 1 request/sec
...
worker-100 -> 1 request/sec

total -> 100 TPS
```

Server-side `/metrics` or APM data should be used as the source of truth for certification evidence. Client-side CSV/JSON results are supporting evidence.

## Test

```sh
go test ./...
```
