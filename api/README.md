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

The metrics response is Prometheus text format and includes request, upload, weighing-row, in-flight, and async queue counters.

### Upload Weighing Slip Image

```sh
curl -X POST http://localhost:8080/api/weighing-slip/upload \
  -H "X-Test-Run-Id: CERT-20260617-001" \
  -H "X-Test-Client-Type: web" \
  -H "X-Test-Device-Id: android-01" \
  -H "X-Test-Worker-Id: worker-001" \
  -H "X-Test-Request-Seq: 000001" \
  -F "file=@./sample-certificate.jpg"
```

The file should be a 100 KB-or-less weighing slip image for certification-style tests. This endpoint reads the multipart file and queues metadata work, but does not store the file yet.

The default upload limit is `102400` bytes. Set `MAX_UPLOAD_BYTES` when you need to test larger samples.

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
