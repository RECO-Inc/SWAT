# SWAT

Testbed for verifying TPS scalability of weighing-related APIs.

## Services

- `api`: Go API server for weighing certificate upload and weighing data endpoints.
- `frontend`: React/Vite web test console for API smoke tests.
- `haproxy`: load balancer in front of three API containers.

## Start API

### Local

```sh
cd api
go run ./cmd/server
```

### Docker Compose With HAProxy

Run HAProxy plus three API containers:

```sh
docker compose up --build
```

Override the upload size limit in bytes:

```sh
MAX_UPLOAD_BYTES=150000 docker compose up --build
```

The public API endpoint is HAProxy on `http://localhost:8080`.

```sh
curl -i http://localhost:8080/health
```

HAProxy stats are available at `http://localhost:8404`.

## Start Frontend

```sh
cd frontend
npm install
npm run dev
```

The frontend defaults to `http://localhost:8080` for API calls. Override it with `VITE_API_BASE_URL` when needed.

## Image Upload Load Test

Run a local max-throughput test through HAProxy:

```sh
python3 load-test/upload_image.py \
  --url http://localhost:8080 \
  --workers 50 \
  --duration 20
```

The script defaults to `sample/84b42905c32037.jpg`, so it can also be run from `load-test/`:

```sh
cd load-test
python3 upload_image.py --url http://localhost:8080 --workers 50 --duration 20
```

Run from another machine on the same network to include real network hops:

```sh
python3 upload_image.py \
  --url http://172.16.0.90:8080 \
  --image 84b42905c32037.jpg \
  --workers 50 \
  --duration 20
```

Run the certification-style model, where each logical worker sends 1 request/sec:

```sh
python3 load-test/upload_image.py \
  --url http://localhost:8080 \
  --workers 100 \
  --rate-per-worker 1 \
  --duration 600
```
