# SWAT Monitoring

Server-side Prometheus metrics and Grafana dashboards are the primary certification evidence for TPS, success rate, and latency.

## Stack

| Service | URL (default) | Role |
|---------|---------------|------|
| Prometheus | http://localhost:9090 | Scrapes API and HAProxy metrics |
| Grafana | http://localhost:3000 | Certification dashboards (admin / `swat`) |
| HAProxy stats | http://localhost:8404 | Load-balancer stats and `/metrics` |

Start with the rest of the stack:

```sh
docker compose up -d
# or
make up-build
```

Override ports via `.env`:

```sh
PROMETHEUS_PORT=9090
GRAFANA_PORT=3000
GRAFANA_ADMIN_PASSWORD=swat
HAPROXY_STATS_PORT=8404
```

On `reco-ss-xeon` (`192.168.0.9`), use non-overlapping host ports:

```sh
FRONTEND_PORT=19090
PROMETHEUS_PORT=19095
GRAFANA_PORT=19092
HAPROXY_STATS_PORT=19096
```

| Service | Local default | reco-ss-xeon |
|---------|---------------|--------------|
| Web console + API | http://localhost:19090 | http://192.168.0.9:19090 |
| Prometheus | http://localhost:9090 | http://192.168.0.9:19095 |
| Grafana | http://localhost:3000 | http://192.168.0.9:19092 |
| HAProxy stats | http://localhost:8404 | http://192.168.0.9:19096 |

## API Metrics

Each API instance exposes `GET /metrics` in Prometheus text format.

Key series:

| Metric | Labels | Use |
|--------|--------|-----|
| `swat_http_requests_total` | `method`, `route`, `status_class`, `test_run_id` | TPS and success/error breakdown |
| `swat_http_request_duration_seconds` | `method`, `route`, `test_run_id` | p95 / p99 latency |
| `swat_upload_accepted_total` | — | Accepted uploads |
| `swat_weighing_rows_total` | — | Weighing data row throughput |
| `swat_ocr_pending` | — | Async OCR backlog |

`test_run_id` comes from the `X-Test-Run-Id` request header. Requests without the header are labeled `unknown`.

## Grafana Dashboard

Open Grafana → folder **SWAT** → **SWAT Certification**.

The dashboard is split into two certification sections:

### 이미지 업로드 (계근증)

Routes: `POST /api/weighing-slip/upload`, `upload-only`, `upload-sync`

Panels:

- 이미지 업로드 성공 TPS (gauge, target 100)
- TPS by upload endpoint
- Status class share
- p95 / p99 latency
- OCR pipeline backlog

### 계근 데이터 업로드

Routes: `POST /api/weighing-data`, `POST /api/weighing-data/bulk`

Panels:

- 계근 데이터 API 성공 TPS (gauge, target 100)
- Row TPS (`swat_weighing_rows_total`) — bulk runs show API TPS and row TPS separately
- TPS by endpoint (single vs bulk)
- Status class share
- p95 / p99 latency

**계근 데이터 API 성공 TPS vs Row TPS**

- **계근 데이터 API 성공 TPS**: `POST /api/weighing-data` 또는
  `POST /api/weighing-data/bulk`가 2xx/3xx로 성공한 HTTP 요청 수/초입니다.
  단건과 벌크 모두 API 호출 1번을 1 TPS로 계산합니다. 인증의 100 TPS 기준은
  이 값을 기준으로 설명합니다.
- **계근 데이터 Row TPS**: API 요청 내부에서 처리된 계근 데이터 행 수/초입니다.
  단건 API는 보통 API TPS와 Row TPS가 같습니다. 벌크 API는 `API TPS x bulk size`
  만큼 Row TPS가 커집니다. 예: 100 API TPS x bulk size 10 = 1,000 rows/sec.
- 평가자에게는 API 성공 TPS를 “100개의 요청원이 초당 1건씩 성공 요청을 만든
  결과”로 설명하고, Row TPS는 벌크 처리량 참고 지표로 분리해서 캡처합니다.

### 공통

- 인증 시나리오별 성공 TPS 비교 (image vs weighing on one chart)
- 인스턴스별 TPS (scenario split)

Variable:

- **Test Run ID** — filter by `X-Test-Run-Id`

## PromQL Examples

Image upload TPS:

```promql
sum(rate(swat_http_requests_total{
  test_run_id="CERT-20260617-001",
  route=~"POST /api/weighing-slip/upload.*"
}[1m]))
```

Weighing data API TPS:

```promql
sum(rate(swat_http_requests_total{
  test_run_id="CERT-20260617-001",
  route=~"POST /api/weighing-data.*"
}[1m]))
```

Weighing data row throughput (bulk):

```promql
sum(rate(swat_weighing_rows_total[1m]))
```

Success rate (image upload only):

```promql
sum(rate(swat_http_requests_total{route=~"POST /api/weighing-slip/upload.*", status_class=~"2xx|3xx"}[1m]))
/
sum(rate(swat_http_requests_total{route=~"POST /api/weighing-slip/upload.*"}[1m]))
```

p95 latency (image upload):

```promql
histogram_quantile(0.95,
  sum by (le) (rate(swat_http_request_duration_seconds_bucket{
    route="POST /api/weighing-slip/upload"
  }[5m]))
)
```

## Evidence Checklist

During each certification run, record:

1. Grafana screenshot: API TPS by route (target ≥ 100 TPS)
2. Grafana screenshot: success TPS gauge and status-class share
3. Grafana screenshot: p95 / p99 latency
4. Prometheus query or Grafana panel: per-instance TPS distribution
5. Optional: HAProxy `/metrics` for front-end request rate

Client-side CSV/JSON exports from the web console remain supporting evidence only.
