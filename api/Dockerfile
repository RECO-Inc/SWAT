# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build

WORKDIR /src

COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/swat-api ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot

ENV API_ADDR=:8080

EXPOSE 8080

COPY --from=build /out/swat-api /swat-api

USER nonroot:nonroot

ENTRYPOINT ["/swat-api"]
