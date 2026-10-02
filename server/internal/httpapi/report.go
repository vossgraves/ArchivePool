package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"archivepool/server/internal/auth"
	"archivepool/server/internal/crypto"
	"archivepool/server/internal/health"
	"archivepool/server/internal/pool"
)

// Rate-limit posture of /api/report (docs/REPORT_ENDPOINT.md). Keyed on IP because reports may
// arrive without a key. Low because every report costs one live provider check.
const (
	reportIPLimit    = 20
	reportKeyLimit   = 20
	reportWindowMs   = 5 * 60_000
	replacementLimit = 3
	replacementMs    = 60 * 60_000
	// A single report can be noise, so auto-disable only once several apps agree.
	disableAfterReports = 3
)

var reportTypes = map[string]bool{"dead": true, "not_premium": true}

type reportRequest struct {
	Service     string          `json:"service"`
	Kind        string          `json:"kind"`
	ID          json.RawMessage `json:"id"`
	Fingerprint string          `json:"fingerprint"`
	Report      string          `json:"report"`
}

type reportResponse struct {
	OK          bool                           `json:"ok"`
	ID          int                            `json:"id"`
	Encrypted   bool                           `json:"encrypted"`
	Encryption  string                         `json:"encryption"`
	Replacement map[string]serviceAccountGroup `json:"replacement"`
}

// handleReport is the app's side channel — never a truth source: a report only triggers a live
// re-check of the entry.
func (s *Server) handleReport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Enforced only when READ_KEYS_ENFORCED is set, so a build with no baked key can still report.
	identity, err := auth.IdentifyReadKey(ctx, s.DB, r, false)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if !identity.OK {
		writeJSON(w, http.StatusUnauthorized, errBody{Error: "unauthorized"},
			map[string]string{"cache-control": "private, no-store"})
		return
	}

	if verdict := s.rateLimit("report-ip:"+clientIP(r), reportIPLimit, reportWindowMs); !verdict.OK {
		tooManyRequests(w, verdict.RetryAfterSec, "report")
		return
	}
	presentedKey, presented := auth.ReadKeyFromRequest(r)
	if presented {
		if verdict := s.rateLimit("report-key:"+keyID(presentedKey), reportKeyLimit, reportWindowMs); !verdict.OK {
			tooManyRequests(w, verdict.RetryAfterSec, "report")
			return
		}
	}

	var body reportRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid body"}, nil)
		return
	}

	reportType := body.Report
	if !reportTypes[reportType] {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "unknown report type"}, nil)
		return
	}

	s.DB.EnsureSchema(ctx)

	// `Number(body.id ?? 0) || null`: any non-finite or zero value means "no id".
	id := 0
	if value, ok := jsNumberValue(body.ID); ok && value != 0 {
		id = int(value)
	}
	fingerprint := strings.TrimSpace(body.Fingerprint)

	if id == 0 && fingerprint == "" {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "id or fingerprint required"}, nil)
		return
	}

	// Ids are globally unique, fingerprints only per table, so prefer the id. `service` comes from
	// the resolved row: a client must not steer which service a replacement is drawn from.
	var entry reportedEntry
	found := false
	if id != 0 {
		row, err := s.DB.QueryRow(ctx, `select id, service from account_entries where id = $1 limit 1`, id)
		if err != nil {
			writeEmpty(w, http.StatusInternalServerError)
			return
		}
		if row.Valid() {
			entry = reportedEntry{row.Int("id"), pool.KindAccount, row.Str("service")}
			found = true
		} else {
			row, err = s.DB.QueryRow(ctx, `select id, service from instance_entries where id = $1 limit 1`, id)
			if err != nil {
				writeEmpty(w, http.StatusInternalServerError)
				return
			}
			if row.Valid() {
				entry = reportedEntry{row.Int("id"), pool.KindAPI, row.Str("service")}
				found = true
			}
		}
	} else if fingerprint != "" {
		tables := []struct {
			name string
			kind pool.Kind
		}{{"account_entries", pool.KindAccount}, {"instance_entries", pool.KindAPI}}
		switch {
		case pool.IsKind(body.Kind) && body.Kind == string(pool.KindAccount):
			tables = tables[:1]
		case pool.IsKind(body.Kind) && body.Kind == string(pool.KindAPI):
			tables = tables[1:]
		}
		for _, table := range tables {
			row, err := s.DB.QueryRow(ctx,
				`select id, service from `+table.name+` where fingerprint = $1 limit 1`, fingerprint)
			if err != nil {
				writeEmpty(w, http.StatusInternalServerError)
				return
			}
			if row.Valid() {
				entry = reportedEntry{row.Int("id"), table.kind, row.Str("service")}
				found = true
				break
			}
		}
	}

	if !found {
		writeJSON(w, http.StatusNotFound, errBody{Error: "unknown entry"}, nil)
		return
	}

	table := "account_entries"
	if entry.Kind == pool.KindAPI {
		table = "instance_entries"
	}

	if reportType == "dead" {
		// Verify-before-park: a report usually means the app's cached copy went stale, not that the
		// account died. The live check already records itself and resets a healthy entry, so only a
		// failing one is parked.
		live, err := health.CheckEntryByID(ctx, s.DB, entry.ID)
		if err != nil {
			live = nil
		}
		if live == nil || !live.OK {
			park := `update ` + table + ` set status = 'pending'`
			if live == nil {
				// A check that could not run recorded nothing, so the report itself is the failure.
				park += `, consecutive_failures = consecutive_failures + 1, check_count = check_count + 1`
			}
			if _, err := s.DB.Exec(ctx, park+` where id = $1`, entry.ID); err != nil {
				writeEmpty(w, http.StatusInternalServerError)
				return
			}
			current, err := s.DB.QueryRow(ctx,
				`select consecutive_failures from `+table+` where id = $1 limit 1`, entry.ID)
			if err != nil {
				writeEmpty(w, http.StatusInternalServerError)
				return
			}
			if current.Int("consecutive_failures") >= disableAfterReports {
				if _, err := s.DB.Exec(ctx, `update `+table+` set disabled = true where id = $1`, entry.ID); err != nil {
					writeEmpty(w, http.StatusInternalServerError)
					return
				}
			}
		}
	} else if reportType == "not_premium" {
		// Reports are keyless and entry ids are small sequential integers, so an unverified report
		// would let one request switch a healthy account off and one address walk the whole pool.
		// The provider's own answer decides entitlement; a wrong report is discarded.
		live, err := health.CheckEntryByID(ctx, s.DB, entry.ID)
		if err != nil {
			live = nil
		}
		if live == nil || !live.OK || live.Premium {
			// Also rejected when the check could not decide: a flaky network must not hand the abuse
			// back. Entitlement is judged only from a check that ran and succeeded, and that check
			// has already disabled the entry itself when the account really is not premium.
			reason := "live check still premium"
			switch {
			case live == nil:
				reason = "live check unavailable"
			case !live.OK:
				reason = "live check failed"
			}
			if _, err := s.DB.Exec(ctx, `
				insert into health_log (entry_id, ok, premium, latency_ms, detail)
				values ($1, true, true, null, $2)`,
				entry.ID, "app report: not_premium (rejected — "+reason+")"); err != nil {
				writeEmpty(w, http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": entry.ID, "ignored": "not_premium"},
				map[string]string{"cache-control": "private, no-store"})
			return
		}
	}

	if _, err := s.DB.Exec(ctx, `
		insert into health_log (entry_id, ok, premium, latency_ms, detail)
		values ($1, $2, $3, null, $4)`,
		entry.ID, reportType != "dead", reportType != "not_premium", "app report: "+reportType); err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}

	// Gated three ways — registered key, proven lease, hourly cap.
	encryption := "client-key"
	var replacement map[string]serviceAccountGroup
	if entry.Kind == pool.KindAccount && identity.KeyID != nil && pool.IsService(entry.Service) {
		hadLease := pool.ReleaseLease(ctx, s.DB, *identity.KeyID, entry.ID)
		if hadLease {
			v2 := isV2Client(r)
			if v2 {
				encryption = "read-key"
			}
			// Non-fatal, unlike /api/accounts: a client that cannot be encrypted for gets
			// replacement: null, never plaintext. The report itself must still succeed.
			canEncrypt := crypto.ClientEncryptionEnabled()
			if v2 {
				canEncrypt = presented
			}
			if canEncrypt && presented {
				verdict := s.rateLimit(
					"report-replacement-key:"+keyID(presentedKey)+":"+entry.Service,
					replacementLimit, replacementMs)
				if verdict.OK {
					var clientKey []byte
					if v2 {
						clientKey = crypto.DeriveClientKey(presentedKey)
					}
					picked, err := pool.LeaseReplacement(ctx, s.DB, pool.Service(entry.Service),
						*identity.KeyID, clientKey, entry.ID)
					if err == nil && picked != nil {
						// Same envelope /api/accounts uses, so the app's feed parser is unchanged.
						replacement = map[string]serviceAccountGroup{
							entry.Service: {Accounts: []pool.LeasedEntry{picked}},
						}
					}
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, reportResponse{
		OK:          true,
		ID:          entry.ID,
		Encrypted:   true,
		Encryption:  encryption,
		Replacement: replacement,
	}, map[string]string{"cache-control": "private, no-store"})
}

// reportedEntry is the resolved report target: ids are globally unique across the two tables, so
// the kind is what identifies which table the row came from.
type reportedEntry struct {
	ID      int
	Kind    pool.Kind
	Service string
}
