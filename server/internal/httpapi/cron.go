package httpapi

import (
	"log"
	"net/http"

	"archivepool/server/internal/auth"
	"archivepool/server/internal/blob"
	"archivepool/server/internal/cache"
	"archivepool/server/internal/db"
	"archivepool/server/internal/health"
)

// logf is the package's one-line, non-fatal failure reporting.
func logf(format string, args ...any) { log.Printf(format, args...) }

// isoPtr renders a nullable timestamp column as the TS does.
func isoPtr(v any) *string { return db.AnyISOPtr(v) }

// handleCronHealth is GET /api/cron/health: pull community token feeds, sweep, republish.
func (s *Server) handleCronHealth(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if !auth.IsCronAuthorized(r) {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
		return
	}

	// Pull community token feeds and ingest entries not already pooled. Errors are isolated: an
	// unreachable feed must never block the health sweep. Ingestion is bounded, so the 6-hourly
	// schedule only health-checks genuinely NEW credentials.
	external, err := health.IngestExternalSources(ctx, s.DB, 10)
	if err != nil {
		external = health.ExternalIngestSummary{
			Errors: []string{db.ErrorMessage(err)},
		}
	}

	summary, err := health.RunHealthSweep(ctx, s.DB, false)
	if err != nil {
		// Mirrors the TS, where a throwing sweep is an unhandled rejection: 500 with no body.
		logf("[cron] health sweep failed: %v", err)
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	// The board's figures just changed; drop the cached copy so the next reader sees this sweep.
	cache.Invalidate("status")
	// The sweep also flips instances alive/dead/disabled, and the discovery feeds answer from the Blob
	// snapshot — which the 12-hourly instance sync is what rewrites. Without this the feeds would keep
	// handing out a base URL this sweep just marked dead for up to 12 hours.
	blob.WriteInstanceSnapshot(ctx, s.DB, s.Blob)
	cache.Invalidate("snapshot:")
	// The database fallback the discovery routes use when Blob is unconfigured is cached too, so it
	// would otherwise keep serving an instance this sweep just disabled for the rest of its TTL.
	cache.Invalidate("discovery:")

	writeJSON(w, http.StatusOK, struct {
		OK        bool                         `json:"ok"`
		External  health.ExternalIngestSummary `json:"external"`
		Checked   int                          `json:"checked"`
		Skipped   int                          `json:"skipped"`
		Disabled  int                          `json:"disabled"`
		Reenabled int                          `json:"reenabled"`
		Locked    bool                         `json:"locked,omitempty"`
		RanAt     string                       `json:"ranAt"`
	}{
		OK:        true,
		External:  external,
		Checked:   summary.Checked,
		Skipped:   summary.Skipped,
		Disabled:  summary.Disabled,
		Reenabled: summary.Reenabled,
		Locked:    summary.Locked,
		RanAt:     nowISO(),
	}, nil)
}

// handleCronMonochrome is GET /api/cron/monochrome: the instance sync (monochrome + SpotiFLAC) plus
// a snapshot rewrite.
func (s *Server) handleCronMonochrome(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if !auth.IsCronAuthorized(r) {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"}, nil)
		return
	}

	// Each feed is isolated so one being unreachable never blocks the others, and all share one
	// dedupe/health-check/premium-gate core.
	var monochrome any
	monochromeOK := true
	if result, err := health.SyncMonochromeInstances(ctx, s.DB); err != nil {
		monochrome = map[string]any{"error": errMessage(err)}
		monochromeOK = false
	} else {
		monochrome = result
	}

	var spotiflac any
	spotiflacOK := true
	if result, err := health.SyncSpotiFlacInstances(ctx, s.DB); err != nil {
		spotiflac = map[string]any{"error": errMessage(err)}
		spotiflacOK = false
	} else {
		spotiflac = result
	}

	ok := monochromeOK || spotiflacOK
	// Publish the servable URLs to Blob so the discovery routes can answer from it without waking the
	// database; then drop the cached feeds so the next client sees the new instances.
	blob.WriteInstanceSnapshot(ctx, s.DB, s.Blob)
	cache.Invalidate("discovery:")
	cache.Invalidate("snapshot:")

	status := http.StatusOK
	if !ok {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, struct {
		OK         bool   `json:"ok"`
		Monochrome any    `json:"monochrome"`
		SpotiFLAC  any    `json:"spotiflac"`
		RanAt      string `json:"ranAt"`
	}{ok, monochrome, spotiflac, nowISO()}, nil)
}

func errMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
