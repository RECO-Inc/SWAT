# SWAT Frontend

React/Vite web test console for the SWAT API.

## Run

```sh
npm install
npm run dev
```

The app defaults to `http://localhost:8080` for API requests.

Override the API URL:

```sh
VITE_API_BASE_URL=http://172.16.0.90:8080 npm run dev
```

## Current Features

- Edit API base URL.
- Check `/health`.
- Upload one weighing slip image to `/api/weighing-slip/upload`.
- Display JSON responses.

## Check

```sh
npm run lint
npm run build
```
