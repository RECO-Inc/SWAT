# SWAT

Testbed for verifying TPS scalability of weighing-related APIs.

## Services

- `api`: Go API server for weighing certificate upload and weighing data endpoints.
- `frontend`: React/Vite web test console for API smoke tests.
- `haproxy`: load balancer in front of five API containers.

## Start API

### Local

```sh
cd api
go run ./cmd/server
```

### Docker Compose With HAProxy And Frontend

`docker-compose.yml` only references images, so it can run from prebuilt
Docker Hub images. `docker-compose.build.yml` adds the build context for
building from source.

Build and run locally from source:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

Override the upload size limit in bytes:

```sh
MAX_UPLOAD_BYTES=150000 docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

The public API endpoint is HAProxy on `http://localhost:8080`.
The frontend is served on `http://localhost:3000`.

```sh
curl -i http://localhost:8080/health
```

HAProxy stats are available at `http://localhost:8404`.

### Makefile Shortcuts

A `Makefile` wraps the common Docker workflows. It auto-loads `.env`, so set
`API_IMAGE` / `FRONTEND_IMAGE` there first. Run `make help` for the full list.

```sh
make build           # build images from source
make up-build        # build from source and start the stack (-d)
make push            # build and push api + frontend images
make release         # docker login + build + push
make push-multiarch  # buildx multi-arch build and push
make pull            # pull images from the registry
make run             # start the stack from registry images (-d)
make down            # stop and remove the stack
make logs            # tail service logs
```

### Publish Images To Docker Hub

Set the image references first. Copy `.env.example` to `.env` and replace
`<dockerhub-username>`, or export them inline:

```sh
export API_IMAGE=<dockerhub-username>/swat-api:1.0.0
export FRONTEND_IMAGE=<dockerhub-username>/swat-frontend:1.0.0
```

Log in, build, and push the project-owned images:

```sh
docker login
docker compose -f docker-compose.yml -f docker-compose.build.yml build api-1 frontend
docker push "$API_IMAGE"
docker push "$FRONTEND_IMAGE"
```

The five `api-*` services share `API_IMAGE`, so building/pushing it covers
all of them.

Note: `docker compose push` is skipped when Docker Desktop uses the
containerd image store (it does not upload the buildkit manifest list), so
push the images directly with `docker push` (what `make push` does).

For a server on a different CPU architecture (e.g. building on Apple
Silicon for an amd64 host), build and push multi-arch images with buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t "$API_IMAGE" --push ./api
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg VITE_API_BASE_URL=http://localhost:8080 \
  -t "$FRONTEND_IMAGE" --push ./frontend
```

### Run From Docker Hub Images (Remote Pull)

On the target machine, set the same `API_IMAGE` / `FRONTEND_IMAGE` values
(via `.env` or `export`), then pull and start without building:

```sh
docker compose pull
docker compose up -d
```

This uses `docker-compose.yml` only, so no build context is required. The
machine still needs `infra/haproxy/haproxy.cfg` because HAProxy bind-mounts
it; keep a repo checkout or copy that file alongside the compose file.

Because `VITE_API_BASE_URL` is baked into the frontend image at build time,
rebuild and republish the frontend image if the browser-facing API URL
changes.

## Start Frontend

```sh
cd frontend
npm install
npm run dev
```

The frontend defaults to `http://localhost:8080` for API calls. Override it with `VITE_API_BASE_URL` when needed.

### Frontend Container Only

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build frontend
```

Override the browser-facing frontend port:

```sh
FRONTEND_PORT=5173 docker compose -f docker-compose.yml -f docker-compose.build.yml up --build frontend
```

For container builds, `VITE_API_BASE_URL` is baked into the static frontend bundle:

```sh
VITE_API_BASE_URL=http://172.16.0.90:8080 docker compose -f docker-compose.yml -f docker-compose.build.yml up --build frontend
```

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
