# Agent Guide

## Project Goal

Build a performance certification testbed for weighing-related APIs.

The target certification scenario is:

- 계근증 이미지 업로드 API TPS 확장 검증.
- 계근 데이터 연동 API TPS 확장 검증.
- 시험성적 인증용 결과 캡처와 문서화.

Do not spend time on repository naming. The project name decision is out of scope for agents.

## Certification Target

Interpret the target as distributed 1 TPS request sources, not one thread forcing 100 TPS.

- One requester or worker sends about 1 request per second.
- 100 parallel requesters or logical workers produce 100 TPS total.
- The server must sustain at least 100 TPS for the target API flow.
- Image upload tests use weighing slip images of 100 KB or less.
- A standard certification run should last 10 minutes when practical.
- Repeat the run 3 times when preparing final evidence.

The most defensible explanation is: one collection manager uploads one weighing slip image per second, and 100 collection managers uploading in parallel produce at least 100 TPS.

## Certification Environments

Use a web-based test program when possible so the same code can run in both required environments.

- Android Chrome: official image upload test environment.
- Windows Chrome or Edge: official weighing data API test environment.
- k6 or JMeter: auxiliary server-side reproducibility check, not the only official evidence if Android execution is required.

Preferred official image-upload setup:

- Best: Android 10 devices x 10 logical workers x 1 TPS = 100 TPS.
- Acceptable fallback: Android 1 device x 100 logical workers x 1 TPS = 100 TPS, if the evaluator only requires execution on Android.

For Android browser tests, keep the tab foregrounded, prevent screen lock, disable battery saver, and record network conditions.

## Architecture Direction

Use one repository with separated runnable services.

Recommended service boundaries:

- `frontend`: React/Vite/TypeScript web test console.
- `api`: Go API server for upload, weighing data, metrics, and test-result endpoints.
- `infra`: Docker Compose, reverse proxy, monitoring, and local infrastructure configuration.
- `load-test`: k6 or JMeter auxiliary load-test scenarios.
- `docs`: test plans, result templates, and certification evidence.

Keep services independently runnable, but manage source, local setup, and docs from this repository.

## API Surface

Keep endpoint naming consistent with the certification scenarios.

- `POST /api/weighing-slip/upload`: multipart upload for 100 KB-or-less weighing slip images.
- `POST /api/weighing-data`: single weighing data JSON request.
- `POST /api/weighing-data/bulk`: bulk weighing data request; track API TPS and row throughput separately.
- `GET /health`: health check.
- `GET /metrics`: Prometheus-compatible metrics when monitoring is added.
- `POST /api/test-result`: optional client-side summary upload.

Every test request should include traceable identifiers:

- `X-Test-Run-Id`: one certification run ID.
- `X-Test-Client-Type`: `web`, `android`, `windows`, `k6`, or similar.
- `X-Test-Device-Id`: device or browser instance ID.
- `X-Test-Worker-Id`: logical worker ID.
- `X-Test-Request-Seq`: per-worker request sequence.

## Web Test Console

The web console is a performance test program, not a customer-facing product.

Required controls:

- API base URL, authorization token, test run ID, device ID.
- Test type: image upload, weighing data single, weighing data bulk.
- Target TPS, worker count, worker TPS, duration, ramp-up seconds.
- Image file selection or bundled sample image, with visible file size and content type.
- JSON template and bulk size controls for weighing data tests.

Required live results:

- Sent count, success count, fail count.
- Current TPS, average latency, p95 latency, p99 latency.
- Error list.
- CSV and JSON result export.
- Copyable certification summary.

Run request generation inside one Web Worker that schedules N logical workers. Do not create 100 actual browser Web Workers unless there is evidence it is needed.

## Measurement Rules

Server-side APM or metrics are the source of truth for certification evidence. Client-side numbers are supporting evidence.

Capture at minimum:

- Endpoint requests/sec.
- Success count and error count.
- p95 and p99 latency.
- 2xx, 4xx, and 5xx counts.
- CPU, memory, network, DB latency, and queue backlog when available.
- Filters by `testRunId`.

Prefer same-origin deployment through a reverse proxy to reduce CORS preflight noise in TPS measurements.

## Storage And Processing

For MVP 1, in-memory placeholders are acceptable. For certification-like runs, use production-shaped flow:

- Store weighing slip images in S3-compatible object storage such as MinIO.
- Store only metadata in the database.
- Include `test_run_id`, `device_id`, `worker_id`, `request_seq`, `file_name`, `file_size`, `storage_path`, and timestamps.
- Do not run OCR synchronously in the upload request path.
- Enqueue OCR or downstream processing work after storing the image and metadata.
- Process OCR in a separate worker service.

Recommended database tables:

- `test_run`: run ID, test type, target TPS, worker count, duration, start/end time.
- `upload_request_log`: upload request metadata, status, latency, success flag.
- `weighing_data_log`: data API request metadata, status, latency, success flag.

For bulk weighing data, document both API TPS and row throughput. Example: 100 API TPS x bulk size 10 = 1,000 rows/sec.

## Implementation Order

1. Keep the Go API runnable and align it with the canonical API surface.
2. Add request identifier capture and structured logs.
3. Add the React/Vite web test console.
4. Add Docker Compose for API and web console.
5. Add k6 auxiliary tests for 100 TPS reproduction.
6. Add metrics endpoint and monitoring dashboards.
7. Add PostgreSQL, MinIO, and queue infrastructure.
8. Add certification docs and result templates.

## MVP Plan

### MVP 1

Goal: prove 100 logical workers x 1 TPS can reach the API without persistence.

- Web console can call the Go API.
- API exposes health, image upload placeholder, weighing data placeholder, and test-result placeholder endpoints.
- Responses can be in-memory or mocked.
- Docker Compose can run the local stack.
- Client exports CSV/JSON with latency and success/failure results.

### MVP 2

Goal: make the testbed close to the real certification path.

- Add PostgreSQL for test runs and request logs.
- Add MinIO for uploaded weighing slip images.
- Add queue infrastructure only when the upload flow needs OCR/downstream processing.
- Upload API stores object, writes metadata, enqueues downstream work, then responds.
- Metrics/APM can show requests/sec, errors, and latency by test run.

### MVP 3

Goal: produce repeatable certification evidence.

- Android Chrome image upload run: target 100 TPS for 10 minutes.
- Windows Chrome/Edge weighing data run: target 100 TPS for 10 minutes.
- k6 or JMeter auxiliary run against the same APIs at 100 TPS.
- Capture dashboard screenshots and client CSV/JSON exports.
- Document assumptions, device count, worker count, file size, duration, pass criteria, and observed results.

## Engineering Notes

- Start simple, but keep the certification evidence path visible in every design decision.
- Prefer real runnable slices over broad scaffolding.
- Keep the upload request path short; storage, metadata write, queue enqueue, response.
- Avoid synchronous OCR or heavy processing in the measured API path.
- Do not let CORS preflight, browser background throttling, or client-only metrics distort the official TPS result.
- Keep load tests reproducible from local commands.
- Update this file when project decisions change.
