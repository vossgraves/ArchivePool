// SPDX-License-Identifier: GPL-3.0-or-later
package health

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"archivepool/server/internal/crypto"
	"archivepool/server/internal/db"
	"archivepool/server/internal/pool"
)

// logf keeps the package's failure reporting one-line and non-fatal, as the TS does.
func logf(format string, args ...any) { log.Printf(format, args...) }

// Auto-disable policy and sweep pacing (lib/health-sweep.ts).
const (
	autoDisableAfter = 5
	sweepConcurrency = 6
	staleAfterMs     = 6 * 60 * 60 * 1000
)

// Entry is one pool row with its kind resolved from which table it came from. Ids are globally
// unique across account_entries/instance_entries thanks to the shared sequence, so this is
// unambiguous.
type Entry struct {
	ID                  int
	Service             string
	Label               string
	Payload             map[string]any
	Fingerprint         string
	Status              string
	Premium             bool
	Detail              *string
	LatencyMs           *int
	ConsecutiveFailures int
	CheckCount          int
	OKCount             int
	Disabled            bool
	Removed             bool
	LastCheckedAt       *time.Time
	Kind                pool.Kind
}

const entryColumns = `id, service, label, payload, fingerprint, status, premium, detail, latency_ms,
	consecutive_failures, check_count, ok_count, disabled, removed, last_checked_at, last_leased_at, created_at`

func scanEntry(row db.Row, kind pool.Kind) Entry {
	return Entry{
		ID:                  row.Int("id"),
		Service:             row.Str("service"),
		Label:               row.Str("label"),
		Payload:             row.JSON("payload"),
		Fingerprint:         row.Str("fingerprint"),
		Status:              row.Str("status"),
		Premium:             row.Bool("premium"),
		Detail:              row.StrPtr("detail"),
		LatencyMs:           row.IntPtr("latency_ms"),
		ConsecutiveFailures: row.Int("consecutive_failures"),
		CheckCount:          row.Int("check_count"),
		OKCount:             row.Int("ok_count"),
		Disabled:            row.Bool("disabled"),
		Removed:             row.Bool("removed"),
		LastCheckedAt:       row.Time("last_checked_at"),
		Kind:                kind,
	}
}

// AllPoolEntries reads every non-removed entry from both tables.
func AllPoolEntries(ctx context.Context, database *db.DB) ([]Entry, error) {
	accounts, err := database.Query(ctx, `select `+entryColumns+` from account_entries where removed = false`)
	if err != nil {
		return nil, err
	}
	instances, err := database.Query(ctx, `select `+entryColumns+` from instance_entries where removed = false`)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, accounts.Len()+instances.Len())
	for _, r := range accounts.All() {
		out = append(out, scanEntry(r, pool.KindAccount))
	}
	for _, r := range instances.All() {
		out = append(out, scanEntry(r, pool.KindAPI))
	}
	return out, nil
}

// SweepSummary is the cron route's payload.
type SweepSummary struct {
	Checked   int `json:"checked"`
	Skipped   int `json:"skipped"`
	Disabled  int `json:"disabled"`
	Reenabled int `json:"reenabled"`
	// Locked reports that another run held the job lease and this one did nothing. It is absent
	// from a normal run, so the documented cron body is unchanged.
	Locked bool `json:"locked,omitempty"`
}

// sweepLeaseTTL bounds the sweep's job lease. It only has to outlive one run (a few minutes at
// sweepConcurrency against the pool's size): an expired lease is how a crashed run releases the job
// for the next scheduled one instead of blocking it forever.
const sweepLeaseTTL = 20 * time.Minute

// ErrEncryptionRequired is returned when account credentials cannot be processed.
var ErrEncryptionRequired = errors.New("POOL_ENCRYPTION_KEY is required to process account credentials")

// RunHealthSweep re-checks every non-removed entry (or only the stale ones), persisting the verdict
// and the health_log row.
//
// The run is exclusive: several instances can be scheduled at once (Railway replicas, or Vercel and
// Railway during a cutover, all against one database) and two sweeps of the same row would
// read-modify-write its failure counters — under-counting the failures that disable an entry — and,
// for a Tidal account, race the refresh-token rotation that persists a new credential, where the
// loser's write leaves a token Tidal has already invalidated.
func RunHealthSweep(ctx context.Context, database *db.DB, force bool) (SweepSummary, error) {
	database.EnsureSchema(ctx)

	if lease, ok, err := database.ClaimJob(ctx, "health-sweep", sweepLeaseTTL); err != nil {
		// An unavailable guard (an older database without the lease table) must not stop the pool
		// being health-checked; it only means this run is unguarded.
		logf("[health] could not claim the sweep lease, running unguarded: %v", err)
	} else if !ok {
		logf("[health] another instance holds the sweep lease; skipping this run")
		return SweepSummary{Locked: true}, nil
	} else {
		defer lease.Release(ctx)
	}

	allEntries, err := AllPoolEntries(ctx, database)
	if err != nil {
		return SweepSummary{}, err
	}
	hasAccount := false
	for _, e := range allEntries {
		if e.Kind == pool.KindAccount {
			hasAccount = true
			break
		}
	}
	if hasAccount && !crypto.AtRestEncryptionEnabled() {
		return SweepSummary{}, ErrEncryptionRequired
	}

	// The stale threshold is what keeps the 6-hourly cron from re-probing healthy hosts every run.
	// A forced sweep (the admin force-check) bypasses it.
	staleAfter := time.Duration(staleAfterMs) * time.Millisecond
	now := time.Now()
	entries := make([]Entry, 0, len(allEntries))
	for _, e := range allEntries {
		// Entries parked in pending by a dead report are neither servable nor dead, so they are
		// re-verified promptly instead of waiting out the stale window.
		if force || e.Status == string(pool.StatusPending) || e.LastCheckedAt == nil || now.Sub(*e.LastCheckedAt) > staleAfter {
			entries = append(entries, e)
		}
	}

	summary := SweepSummary{Skipped: len(allEntries) - len(entries)}
	var mu sync.Mutex

	mapLimit(entries, sweepConcurrency, func(entry Entry) {
		table := tableFor(entry.Kind)
		plaintext := crypto.DecryptAtRest(entry.Payload)
		// Migrate rows written by older deployments before checking: a Tidal check may rotate its
		// refresh token, so migrating afterwards could overwrite the newly issued credential.
		if stored, err := crypto.EncryptAtRest(plaintext); err == nil {
			_, _ = database.Exec(ctx, `update `+table+` set payload = $1 where id = $2`,
				encodeJSON(stored), entry.ID)
		}

		result := RunCheck(ctx, database, pool.Service(entry.Service), entry.Kind, plaintext, entry.Fingerprint)

		nextConsecutive := 0
		if !result.OK {
			nextConsecutive = entry.ConsecutiveFailures + 1
		}
		nextDisabled := entry.Disabled
		disabledDelta, reenabledDelta := 0, 0
		switch {
		case !result.OK && nextConsecutive >= autoDisableAfter:
			if !entry.Disabled {
				disabledDelta = 1
			}
			nextDisabled = true
		case result.OK && !result.Premium:
			// Working but no premium entitlement (free tier / lossy-only instance): disable
			// immediately — the pool only serves premium sources. Self-heals on a later sweep if the
			// entitlement returns (ok && premium).
			if !entry.Disabled {
				disabledDelta = 1
			}
			nextDisabled = true
		case result.OK && entry.Disabled:
			nextDisabled = false
			reenabledDelta = 1
		}

		if _, err := database.Exec(ctx, `
			update `+table+` set status = $1, premium = $2, detail = $3, latency_ms = $4,
			  consecutive_failures = $5, disabled = $6, check_count = check_count + 1,
			  ok_count = ok_count + $7, last_checked_at = $8
			where id = $9`,
			string(result.Status), result.Premium, result.Detail, result.LatencyMs,
			nextConsecutive, nextDisabled, boolInt(result.OK), time.Now(), entry.ID); err != nil {
			logf("[health] sweep update failed for entry %d: %v", entry.ID, err)
		}

		AppendHealthLog(ctx, database, entry.ID, result)

		mu.Lock()
		summary.Checked++
		summary.Disabled += disabledDelta
		summary.Reenabled += reenabledDelta
		mu.Unlock()
	})

	if _, err := database.Exec(ctx,
		`delete from health_log where checked_at < now() - interval '30 days'`); err != nil {
		logf("[health] pruning health_log failed: %v", err)
	}
	return summary, nil
}

// CheckEntryByID re-verifies one entry with the same rules as the full sweep (auto-disable
// threshold, health_log append, at-rest payload migration). Used by the admin panel so a single
// suspect account can be re-verified without sweeping the whole pool.
func CheckEntryByID(ctx context.Context, database *db.DB, id int) (*CheckEntryResult, error) {
	database.EnsureSchema(ctx)
	entry, err := findEntryByID(ctx, database, id)
	if err != nil || entry == nil {
		return nil, err
	}
	if entry.Kind == pool.KindAccount && !crypto.AtRestEncryptionEnabled() {
		return nil, ErrEncryptionRequired
	}

	table := tableFor(entry.Kind)
	plaintext := crypto.DecryptAtRest(entry.Payload)
	// Migrate before checking: a Tidal check can rotate its refresh token, so writing the migrated
	// payload afterwards would clobber the newly issued credential.
	if stored, err := crypto.EncryptAtRest(plaintext); err == nil {
		_, _ = database.Exec(ctx, `update `+table+` set payload = $1 where id = $2`,
			encodeJSON(stored), entry.ID)
	}

	result := RunCheck(ctx, database, pool.Service(entry.Service), entry.Kind, plaintext, entry.Fingerprint)

	nextConsecutive := 0
	if !result.OK {
		nextConsecutive = entry.ConsecutiveFailures + 1
	}
	nextDisabled := entry.Disabled
	switch {
	case !result.OK && nextConsecutive >= autoDisableAfter:
		nextDisabled = true
	case result.OK && !result.Premium:
		nextDisabled = true
	case result.OK && entry.Disabled:
		nextDisabled = false
	}

	if _, err := database.Exec(ctx, `
		update `+table+` set status = $1, premium = $2, detail = $3, latency_ms = $4,
		  consecutive_failures = $5, disabled = $6, check_count = check_count + 1,
		  ok_count = ok_count + $7, last_checked_at = $8
		where id = $9`,
		string(result.Status), result.Premium, result.Detail, result.LatencyMs,
		nextConsecutive, nextDisabled, boolInt(result.OK), time.Now(), entry.ID); err != nil {
		return nil, err
	}

	AppendHealthLog(ctx, database, entry.ID, result)

	return &CheckEntryResult{
		ID:                  entry.ID,
		OK:                  result.OK,
		Status:              string(result.Status),
		Premium:             result.Premium,
		Detail:              result.Detail,
		LatencyMs:           result.LatencyMs,
		ConsecutiveFailures: nextConsecutive,
		Disabled:            nextDisabled,
	}, nil
}

// CheckEntryResult is the admin panel's single-entry re-check payload.
type CheckEntryResult struct {
	ID                  int    `json:"id"`
	OK                  bool   `json:"ok"`
	Status              string `json:"status"`
	Premium             bool   `json:"premium"`
	Detail              string `json:"detail"`
	LatencyMs           int    `json:"latencyMs"`
	ConsecutiveFailures int    `json:"consecutiveFailures"`
	Disabled            bool   `json:"disabled"`
}

// AppendHealthLog records one check in the per-entry history.
func AppendHealthLog(ctx context.Context, database *db.DB, entryID int, result CheckResult) {
	if _, err := database.Exec(ctx, `
		insert into health_log (entry_id, ok, premium, latency_ms, detail)
		values ($1, $2, $3, $4, $5)`, entryID, result.OK, result.Premium, result.LatencyMs, result.Detail); err != nil {
		logf("[health] health_log insert failed for entry %d: %v", entryID, err)
	}
}

func findEntryByID(ctx context.Context, database *db.DB, id int) (*Entry, error) {
	row, err := database.QueryRow(ctx, `select `+entryColumns+` from account_entries where id = $1 limit 1`, id)
	if err != nil {
		return nil, err
	}
	if row.Valid() {
		entry := scanEntry(row, pool.KindAccount)
		return &entry, nil
	}
	row, err = database.QueryRow(ctx, `select `+entryColumns+` from instance_entries where id = $1 limit 1`, id)
	if err != nil {
		return nil, err
	}
	if row.Valid() {
		entry := scanEntry(row, pool.KindAPI)
		return &entry, nil
	}
	return nil, nil
}

func tableFor(kind pool.Kind) string {
	if kind == pool.KindAccount {
		return "account_entries"
	}
	return "instance_entries"
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// mapLimit runs fn over items with a bounded number of workers, keeping the per-item accounting
// exact (each worker awaits its own item before taking the next).
//
// A panic inside fn is confined to its item and logged. The TS equivalent (an exception in one
// worker of Promise.all) fails that run but cannot take the process down, whereas an unrecovered
// panic in any goroutine here would exit the whole server — every route, for every client — because
// one contributor's payload tripped a probe.
func mapLimit[T any](items []T, limit int, fn func(T)) {
	if len(items) == 0 {
		return
	}
	if limit > len(items) {
		limit = len(items)
	}
	var wg sync.WaitGroup
	var next int
	var mu sync.Mutex
	wg.Add(limit)
	for range limit {
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				idx := next
				next++
				mu.Unlock()
				if idx >= len(items) {
					return
				}
				runItem(items[idx], fn)
			}
		}()
	}
	wg.Wait()
}

// runItem calls fn under a recover, so one bad item is one failed item rather than a process exit.
func runItem[T any](item T, fn func(T)) {
	defer func() {
		if r := recover(); r != nil {
			logf("[health] check panicked for %s: %v", describeItem(item), r)
		}
	}()
	fn(item)
}

// describeItem names an item for the log without printing it: an Entry carries its payload.
func describeItem(item any) string {
	if e, ok := item.(Entry); ok {
		return "entry " + strconv.Itoa(e.ID)
	}
	return fmt.Sprint(item)
}
