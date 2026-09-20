package health

import (
	"context"
	"strings"
	"time"

	"archivepool/server/internal/crypto"
	"archivepool/server/internal/db"
	"archivepool/server/internal/pool"
)

// IngestResult is what the manual form, the OAuth flows and the external ingester all report.
type IngestResult struct {
	OK      bool   `json:"ok"`
	Saved   bool   `json:"saved"`
	Status  string `json:"status"`
	Premium bool   `json:"premium"`
	Detail  string `json:"detail"`
}

// IngestOptions carries the fields that must NOT live in the payload: the payload feeds the
// fingerprint, so putting credit or expiry in it would make a re-submission with a corrected value
// insert a duplicate row instead of updating the existing one.
type IngestOptions struct {
	Contributor *string
	ExpiresAt   *time.Time
}

// IngestSource runs a live health check on a candidate and — only when it is BOTH working and
// premium — upserts it, deduped by fingerprint.
//
// Admission policy: `!ok || !premium` ⇒ saved: false and nothing is persisted. Dead or free-tier
// candidates never enter the database.
func IngestSource(ctx context.Context, database *db.DB, service pool.Service, kind pool.Kind, payload map[string]any, opts IngestOptions) (IngestResult, error) {
	database.EnsureSchema(ctx)
	if kind == pool.KindAccount && !crypto.AtRestEncryptionEnabled() {
		return IngestResult{}, ErrEncryptionRequired
	}

	var contributor any
	if opts.Contributor != nil {
		trimmed := truncate(trimSpace(*opts.Contributor), 64)
		if trimmed != "" {
			contributor = trimmed
		}
	}
	var expiresAt any
	if opts.ExpiresAt != nil {
		expiresAt = *opts.ExpiresAt
	}

	// Fingerprint, label and the live health check all run on the PLAINTEXT payload; only the value
	// persisted to the database is encrypted, so dedupe and validation behaviour is unchanged.
	fp := pool.Fingerprint(service, kind, payload)
	label := pool.MaskLabel(service, kind, payload)
	result := RunCheck(ctx, database, service, kind, payload, fp)

	if !result.OK || !result.Premium {
		detail := "rejected — working but no premium/lossless entitlement (" + result.Detail + ")"
		if !result.OK {
			detail = "rejected — live check failed (" + result.Detail + ")"
		}
		return IngestResult{
			OK:      result.OK,
			Saved:   false,
			Status:  string(result.Status),
			Premium: result.Premium,
			Detail:  detail,
		}, nil
	}

	storedPayload, err := crypto.EncryptAtRest(payload)
	if err != nil {
		return IngestResult{}, err
	}
	table := "account_entries"
	if kind == pool.KindAPI {
		table = "instance_entries"
	}

	_, err = database.Exec(ctx, `
		insert into `+table+`
		  (service, label, payload, fingerprint, status, premium, detail, latency_ms,
		   check_count, ok_count, consecutive_failures, last_checked_at, removed, disabled,
		   contributor, expires_at)
		values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, 1, $9, $10, $11, false, false, $12, $13)
		on conflict (fingerprint) do update set
		  payload = excluded.payload,
		  label = excluded.label,
		  status = excluded.status,
		  premium = excluded.premium,
		  detail = excluded.detail,
		  latency_ms = excluded.latency_ms,
		  check_count = `+table+`.check_count + 1,
		  ok_count = `+table+`.ok_count + $9,
		  consecutive_failures = case when $14 then 0 else `+table+`.consecutive_failures + 1 end,
		  last_checked_at = excluded.last_checked_at,
		  removed = false,
		  contributor = COALESCE(`+table+`.contributor, excluded.contributor)`,
		string(service), label, encodeJSON(storedPayload), fp, string(result.Status), result.Premium,
		result.Detail, result.LatencyMs, boolInt(result.OK), boolInt(!result.OK), time.Now(),
		contributor, expiresAt, result.OK)
	if err != nil {
		return IngestResult{}, err
	}

	return IngestResult{
		OK:      result.OK,
		Saved:   true,
		Status:  string(result.Status),
		Premium: result.Premium,
		Detail:  result.Detail,
	}, nil
}

// DescribeSaveError turns a save/DB error into a human-readable cause. Most "could not save"
// failures in a fresh deploy are configuration problems (no DATABASE_URL, or the schema was never
// applied), so those are detected explicitly instead of returning a generic message.
func DescribeSaveError(databaseURL string, err error) string {
	msg := strings.ToLower(errMessage(err))
	if databaseURL == "" {
		return "The server has no DATABASE_URL set. Add your database connection string in the host's environment variables."
	}
	for _, table := range []string{"account_entries", "instance_entries", "source_entries"} {
		if strings.Contains(msg, `relation "`+table+`" does not exist`) ||
			(strings.Contains(msg, table) && strings.Contains(msg, "does not exist")) {
			return "The database has no tables yet. Run scripts/schema.sql against it once, then try again."
		}
	}
	if strings.Contains(msg, "no unique or exclusion constraint") || strings.Contains(msg, "on conflict") {
		return "The database schema is out of date (missing the fingerprint unique constraint). Re-run scripts/schema.sql."
	}
	if strings.Contains(msg, "econnrefused") || strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "terminating connection") || strings.Contains(msg, "connect") {
		return "Could not reach the database. Check that DATABASE_URL is correct and the database is reachable from the host."
	}
	return "Could not save to the database. Check the server logs for the underlying error."
}

func errMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
