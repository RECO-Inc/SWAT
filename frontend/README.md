# SWAT Frontend

React/Vite web test console for the SWAT API.

## Run

### Local

```sh
npm install
npm run dev
```

The app defaults to `http://localhost:8080` for API requests.

Override the API URL:

```sh
VITE_API_BASE_URL=http://172.16.0.90:8080 npm run dev
```

### Docker

Build and serve the production bundle with Nginx:

```sh
docker build -t swat-frontend .
docker run --rm -p 3000:80 swat-frontend
```

Or run it through the repository Compose stack:

```sh
docker compose up --build frontend
```

The Compose service maps the frontend to `http://localhost:3000` by default.
Override the port with `FRONTEND_PORT`, and set `VITE_API_BASE_URL` before building when the browser should call a different API origin.

```sh
FRONTEND_PORT=5173 VITE_API_BASE_URL=http://172.16.0.90:8080 docker compose up --build frontend
```

## Current Features

- Edit API base URL.
- Check `/health`.
- Upload one weighing slip image to `/api/weighing-slip/upload`.
- Display JSON responses.
- Load generation in a Web Worker that schedules N logical workers at a target per-worker TPS, with ramp-up and duration.
  - Test types: image upload, weighing data single, weighing data bulk.
  - Image source: selected file or a synthetic payload of a configured size.
  - Live metrics: sent/success/fail, current TPS, success rate, avg/p95/p99/max latency, in-flight, status-code breakdown, and recent errors.
  - Export CSV/JSON, copy a certification summary, and submit results to `/api/test-result`.

## Check

```sh
npm run lint
npm run build
```
