package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// WeighingSourcePayload mirrors the legacy weighing CSV export fields.
type WeighingSourcePayload struct {
	Num            int64  `json:"num,omitempty"`
	Business       string `json:"business,omitempty"`
	Car            string `json:"car,omitempty"`
	Product        string `json:"product,omitempty"`
	Area           string `json:"area,omitempty"`
	DateFirst      string `json:"dateFirst,omitempty"`
	TimeFirst      string `json:"timeFirst,omitempty"`
	DateSecond     string `json:"dateSecond,omitempty"`
	TimeSecond     string `json:"timeSecond,omitempty"`
	WeightFirst    int64  `json:"weightFirst,omitempty"`
	WeightSecond   int64  `json:"weightSecond,omitempty"`
	WeightGap      int64  `json:"weightGap,omitempty"`
	InOut          string `json:"inOut,omitempty"`
	Unit           int64  `json:"unit,omitempty"`
	SumMoney       int64  `json:"sumMoney,omitempty"`
	SlipNum        int64  `json:"slipNum,omitempty"`
	CardKeyID      int64  `json:"cardKeyId,omitempty"`
	UserName       string `json:"userName,omitempty"`
	CarName        string `json:"carName,omitempty"`
	Note           string `json:"note,omitempty"`
	ChargeFlag     string `json:"chargeFlag,omitempty"`
	ChargeMoney    int64  `json:"chargeMoney,omitempty"`
	DateReWrite    string `json:"dateReWrite,omitempty"`
	TimeReWrite    string `json:"timeReWrite,omitempty"`
	CountReWrite   int64  `json:"countReWrite,omitempty"`
	Generated      bool   `json:"generated,omitempty"`
	SourceFile     string `json:"sourceFile,omitempty"`
}

type CreateWeighingRequest struct {
	TicketID      string          `json:"ticketId"`
	VehicleNo     string          `json:"vehicleNo"`
	GrossWeightKg int64           `json:"grossWeightKg"`
	TareWeightKg  int64           `json:"tareWeightKg"`
	Source        json.RawMessage `json:"source,omitempty"`
}

type WeighingRecord struct {
	ID            string          `json:"id"`
	TicketID      string          `json:"ticketId"`
	VehicleNo     string          `json:"vehicleNo"`
	GrossWeightKg int64           `json:"grossWeightKg"`
	TareWeightKg  int64           `json:"tareWeightKg"`
	NetWeightKg   int64           `json:"netWeightKg"`
	RecordedAt    time.Time       `json:"recordedAt"`
	Trace         TestRequestIDs  `json:"trace,omitempty"`
	Source        json.RawMessage `json:"source,omitempty"`
}

type BulkWeighingRequest struct {
	Items []CreateWeighingRequest `json:"items"`
}

type BulkWeighingResponse struct {
	Requests      []CreateWeighingRequest `json:"requests"`
	Items         []WeighingRecord      `json:"items"`
	APICount      int                   `json:"apiCount"`
	RowCount      int                   `json:"rowCount"`
	Trace         TestRequestIDs        `json:"trace"`
	RecordedAt    time.Time             `json:"recordedAt"`
	RowThroughput string                `json:"rowThroughput"`
}

type CreateWeighingResponse struct {
	Request CreateWeighingRequest `json:"request"`
	Item    WeighingRecord        `json:"item"`
	Trace   TestRequestIDs        `json:"trace"`
}

func (s *Server) listWeighingData(w http.ResponseWriter, r *http.Request) {
	testRunID := strings.TrimSpace(r.URL.Query().Get("testRunId"))
	ticketID := strings.TrimSpace(r.URL.Query().Get("ticketId"))
	limit := envInt("WEIGHING_LIST_LIMIT", 500)
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if limit > 5000 {
		limit = 5000
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	records := make([]WeighingRecord, 0, len(s.weighings))
	for i := len(s.weighings) - 1; i >= 0; i-- {
		record := s.weighings[i]
		if ticketID != "" && record.TicketID != ticketID {
			continue
		}
		if testRunID != "" && record.Trace.TestRunID != testRunID {
			continue
		}
		records = append(records, record)
		if len(records) >= limit {
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items": records,
		"count": len(records),
	})
}

func newWeighingRecord(req CreateWeighingRequest, trace TestRequestIDs) (WeighingRecord, error) {
	record, err := newWeighingRecordCore(req)
	if err != nil {
		return WeighingRecord{}, err
	}
	record.Trace = trace
	record.Source = req.Source
	return record, nil
}
