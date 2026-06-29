package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var requestDurationBuckets = []float64{
	0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
}

type serverMetrics struct {
	reg *prometheus.Registry

	httpRequestsTotal      *prometheus.CounterVec
	httpRequestDuration    *prometheus.HistogramVec
	httpInFlight           prometheus.Gauge
	uploadAccepted         prometheus.Counter
	uploadRejected         prometheus.Counter
	uploadBytesTotal       prometheus.Counter
	weighingRowsTotal      prometheus.Counter
	testResultsTotal       prometheus.Counter
	asyncDroppedTotal      prometheus.Counter
	ocrEnqueuedTotal       prometheus.Counter
	ocrDroppedTotal        prometheus.Counter
	ocrSuccessTotal       prometheus.Counter
	ocrErrorTotal         prometheus.Counter
	ocrPending            prometheus.Gauge
	ocrPendingCount       atomic.Int64
	ocrEnqueuedCount      atomic.Int64
	ocrDroppedCount       atomic.Int64
	ocrSuccessCount       atomic.Int64
	ocrErrorCount         atomic.Int64
}

func newServerMetrics(reg *prometheus.Registry, s *Server) *serverMetrics {
	m := &serverMetrics{reg: reg}

	m.httpRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "swat_http_requests_total",
		Help: "Total HTTP requests.",
	}, []string{"method", "route", "status_class", "test_run_id"})

	m.httpRequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "swat_http_request_duration_seconds",
		Help:    "HTTP request latency in seconds.",
		Buckets: requestDurationBuckets,
	}, []string{"method", "route", "test_run_id"})

	m.httpInFlight = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "swat_http_in_flight_requests",
		Help: "Current in-flight HTTP requests.",
	})

	m.uploadAccepted = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_upload_accepted_total",
		Help: "Accepted weighing slip uploads.",
	})
	m.uploadRejected = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_upload_rejected_total",
		Help: "Rejected weighing slip uploads.",
	})
	m.uploadBytesTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_upload_bytes_total",
		Help: "Accepted upload payload bytes.",
	})
	m.weighingRowsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_weighing_rows_total",
		Help: "Accepted weighing data rows.",
	})
	m.testResultsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_test_results_total",
		Help: "Submitted client test-result summaries.",
	})
	m.asyncDroppedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_async_dropped_total",
		Help: "Async jobs dropped because queues were full.",
	})
	m.ocrEnqueuedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_ocr_enqueued_total",
		Help: "Uploads queued for asynchronous OCR.",
	})
	m.ocrDroppedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_ocr_dropped_total",
		Help: "Async OCR jobs dropped because the OCR queue was full.",
	})
	m.ocrSuccessTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_ocr_success_total",
		Help: "OCR requests that returned a 2xx/3xx result.",
	})
	m.ocrErrorTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "swat_ocr_error_total",
		Help: "OCR requests that failed or returned a 4xx/5xx result.",
	})
	m.ocrPending = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "swat_ocr_pending",
		Help: "Async OCR jobs currently queued or in flight.",
	})

	uploadQueueDepth := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name:        "swat_async_queue_depth",
		Help:        "Current async job queue depth.",
		ConstLabels: prometheus.Labels{"queue": "upload"},
	}, func() float64 {
		return float64(len(s.uploadJobs))
	})
	auditQueueDepth := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name:        "swat_async_queue_depth",
		Help:        "Current async job queue depth.",
		ConstLabels: prometheus.Labels{"queue": "audit"},
	}, func() float64 {
		return float64(len(s.auditJobs))
	})

	reg.MustRegister(
		m.httpRequestsTotal,
		m.httpRequestDuration,
		m.httpInFlight,
		m.uploadAccepted,
		m.uploadRejected,
		m.uploadBytesTotal,
		m.weighingRowsTotal,
		m.testResultsTotal,
		m.asyncDroppedTotal,
		m.ocrEnqueuedTotal,
		m.ocrDroppedTotal,
		m.ocrSuccessTotal,
		m.ocrErrorTotal,
		m.ocrPending,
		uploadQueueDepth,
		auditQueueDepth,
	)

	return m
}

func (m *serverMetrics) handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}

func (m *serverMetrics) incOCREnqueued() {
	m.ocrEnqueuedTotal.Inc()
	m.ocrEnqueuedCount.Add(1)
}

func (m *serverMetrics) incOCRDropped() {
	m.ocrDroppedTotal.Inc()
	m.ocrDroppedCount.Add(1)
}

func (m *serverMetrics) incOCRPending() {
	m.ocrPending.Inc()
	m.ocrPendingCount.Add(1)
}

func (m *serverMetrics) decOCRPending() {
	m.ocrPending.Dec()
	m.ocrPendingCount.Add(-1)
}

func (m *serverMetrics) incOCRSuccess() {
	m.ocrSuccessTotal.Inc()
	m.ocrSuccessCount.Add(1)
}

func (m *serverMetrics) incOCRError() {
	m.ocrErrorTotal.Inc()
	m.ocrErrorCount.Add(1)
}

func (m *serverMetrics) observeHTTP(method, route, testRunID string, statusCode int, durationSeconds float64) {
	statusClass := statusClass(statusCode)
	testRunID = normalizeTestRunID(testRunID)

	m.httpRequestsTotal.WithLabelValues(method, route, statusClass, testRunID).Inc()
	m.httpRequestDuration.WithLabelValues(method, route, testRunID).Observe(durationSeconds)
}

func requestRoute(r *http.Request) string {
	if pattern := strings.TrimSpace(r.Pattern); pattern != "" {
		return pattern
	}
	return r.URL.Path
}

func normalizeTestRunID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return "unknown"
	}
	return id
}

func statusClass(statusCode int) string {
	switch {
	case statusCode >= 500:
		return "5xx"
	case statusCode >= 400:
		return "4xx"
	case statusCode >= 300:
		return "3xx"
	case statusCode >= 200:
		return "2xx"
	default:
		return strconv.Itoa(statusCode)
	}
}
