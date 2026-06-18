package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"

	"swat-api/internal/httpapi"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	addr := os.Getenv("API_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           httpapi.NewServer().Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       durationFromEnvMs("API_READ_TIMEOUT_MS", 60*time.Second),
		// WriteTimeout defaults to 0 (disabled) so synchronous OCR uploads can wait
		// for a slow OCR service without the connection being reset mid-request.
		WriteTimeout:   durationFromEnvMs("API_WRITE_TIMEOUT_MS", 0),
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	go func() {
		logger.Info("api server listening", "addr", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("api server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("api server shutdown failed", "error", err)
		os.Exit(1)
	}

	logger.Info("api server stopped")
}

// durationFromEnvMs reads a millisecond value from the environment. An unset or
// invalid value uses the fallback; an explicit 0 disables the timeout.
func durationFromEnvMs(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return fallback
	}
	return time.Duration(parsed) * time.Millisecond
}
