// SPDX-License-Identifier: GPL-3.0-or-later
package health

import (
	"context"
	"sync"
	"time"

	"archivepool/server/internal/crypto"
	"archivepool/server/internal/db"
	"archivepool/server/internal/pool"
)

// InstanceSyncResult is the accounting every instance feed reports.
type InstanceSyncResult struct {
	Fetched  int `json:"fetched"`  // unique URLs handed in
	Skipped  int `json:"skipped"`  // already in pool and recently checked (by fingerprint)
	Checked  int `json:"checked"`  // actually health-checked this run
	Added    int `json:"added"`    // passed check, newly inserted
	Updated  int `json:"updated"`  // already existed, status updated
	Failed   int `json:"failed"`   // health check did not pass
	Rejected int `json:"rejected"` // reachable but not premium/hi-res — not added (new) per pool policy
	// Locked reports that another run held the job lease and this one did nothing. Absent from a
	// normal run, so the monochrome/SpotiFLAC response body is unchanged.
	Locked bool `json:"locked,omitempty"`
}

// Instances checked more recently than this are skipped, so a sweep never hammers live hosts.
const defaultRecheckWindow = 6 * time.Hour

// Each health check allows up to 12s. A serial loop over a ten-entry feed can hit 2 minutes and blow
// a cron route's maxDuration=60. Five workers keep per-entry DB writes sequential within a worker,
// so the added/updated/failed accounting stays exact.
const defaultSyncConcurrency = 5

// syncLeaseTTL bounds the instance sync's job lease. Five workers over a community list are done in
// a couple of minutes; the lease only has to outlive one run so a crashed one cannot block the next.
const syncLeaseTTL = 15 * time.Minute

// SyncInstanceURLs health-checks a list of instance base URLs for one service and upserts the
// passing (premium) ones, updating rather than recreating any that already exist. This is the shared
// core behind every instance feed: a feed module only has to produce the URLs.
//
// Expect most of a community list to land in `rejected` rather than `added`: public HiFi instances
// are frequently unsubscribed and therefore preview-only, which is the gate doing its job.
//
// The run is exclusive (see internal/db.ClaimJob): the monochrome and SpotiFLAC feeds overlap on
// shared community lists, and two instances syncing the same fingerprint each derive the row's next
// state from a stale read of its check history, so an entry can end up with the loser's older status
// and last_checked_at while its counters claim both runs were recorded.
func SyncInstanceURLs(ctx context.Context, database *db.DB, service pool.Service, urls []string, note string, recheckWindow time.Duration, concurrency int) (InstanceSyncResult, error) {
	database.EnsureSchema(ctx)

	if lease, ok, err := database.ClaimJob(ctx, "instance-sync", syncLeaseTTL); err != nil {
		// An unavailable guard must not stop the feeds being refreshed; it only means this run is
		// unguarded.
		logf("[health] could not claim the instance-sync lease, running unguarded: %v", err)
	} else if !ok {
		logf("[health] another instance holds the instance-sync lease; skipping this run")
		return InstanceSyncResult{Locked: true}, nil
	} else {
		defer lease.Release(ctx)
	}

	if recheckWindow <= 0 {
		recheckWindow = defaultRecheckWindow
	}
	if concurrency <= 0 {
		concurrency = defaultSyncConcurrency
	}

	// Normalize and de-duplicate, preserving the first occurrence.
	seen := map[string]bool{}
	allURLs := make([]string, 0, len(urls))
	for _, u := range urls {
		normalized := pool.NormalizeURL(u)
		if !hasHTTPPrefix(normalized) || seen[normalized] {
			continue
		}
		seen[normalized] = true
		allURLs = append(allURLs, normalized)
	}

	result := InstanceSyncResult{Fetched: len(allURLs)}
	if len(allURLs) == 0 {
		return result, nil
	}

	// Load existing fingerprints for this service so known-good, recently-checked entries are
	// skipped instead of re-probed on every sweep.
	rows, err := database.Query(ctx, `
		select fingerprint, last_checked_at, status, disabled, removed
		from instance_entries where service = $1`, string(service))
	if err != nil {
		return result, err
	}

	type existing struct {
		lastCheckedAt *time.Time
		status        string
		disabled      bool
		removed       bool
	}
	fingerprints := map[string]existing{}
	for _, r := range rows.All() {
		fingerprints[r.Str("fingerprint")] = existing{
			lastCheckedAt: r.Time("last_checked_at"),
			status:        r.Str("status"),
			disabled:      r.Bool("disabled"),
			removed:       r.Bool("removed"),
		}
	}

	var mu sync.Mutex
	mapLimit(allURLs, concurrency, func(baseURL string) {
		payload := map[string]any{"baseUrl": baseURL}
		if note != "" {
			payload["note"] = note
		}
		fp := pool.Fingerprint(service, pool.KindAPI, payload)
		known, exists := fingerprints[fp]

		if exists && !known.removed {
			recentlyChecked := known.lastCheckedAt != nil &&
				time.Since(*known.lastCheckedAt) < recheckWindow
			currentlyAlive := known.status == "alive" || known.status == "preview"
			if recentlyChecked && currentlyAlive && !known.disabled {
				mu.Lock()
				result.Skipped++
				mu.Unlock()
				return
			}
		}

		mu.Lock()
		result.Checked++
		mu.Unlock()

		check := RunCheck(ctx, database, service, pool.KindAPI, payload, "")

		if !check.OK {
			mu.Lock()
			result.Failed++
			mu.Unlock()
			if exists && !known.removed {
				if _, err := database.Exec(ctx, `
					update instance_entries set status = $1, premium = $2, detail = $3, latency_ms = $4,
					  consecutive_failures = consecutive_failures + 1, check_count = check_count + 1,
					  last_checked_at = $5
					where fingerprint = $6`,
					string(check.Status), check.Premium, check.Detail, check.LatencyMs,
					time.Now(), fp); err != nil {
					logf("[health] instance update failed: %v", err)
				}
				mu.Lock()
				result.Updated++
				mu.Unlock()
			}
			return
		}

		if !check.Premium {
			mu.Lock()
			result.Rejected++
			mu.Unlock()
			if exists && !known.removed {
				if _, err := database.Exec(ctx, `
					update instance_entries set status = $1, premium = false, detail = $2, latency_ms = $3,
					  disabled = true, check_count = check_count + 1, last_checked_at = $4
					where fingerprint = $5`,
					string(check.Status), "reachable but not premium ("+check.Detail+")", check.LatencyMs,
					time.Now(), fp); err != nil {
					logf("[health] instance update failed: %v", err)
				}
				mu.Lock()
				result.Updated++
				mu.Unlock()
			}
			return
		}

		label := pool.MaskLabel(service, pool.KindAPI, payload)
		stored, err := crypto.EncryptAtRest(payload)
		if err != nil {
			logf("[health] instance encrypt failed: %v", err)
			return
		}
		if _, err := database.Exec(ctx, `
			insert into instance_entries
			  (service, label, payload, fingerprint, status, premium, detail, latency_ms,
			   check_count, ok_count, consecutive_failures, last_checked_at, disabled, removed)
			values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, 1, 1, 0, $9, false, false)
			on conflict (fingerprint) do update set
			  status = excluded.status,
			  premium = excluded.premium,
			  detail = excluded.detail,
			  latency_ms = excluded.latency_ms,
			  consecutive_failures = 0,
			  disabled = false,
			  removed = false,
			  check_count = instance_entries.check_count + 1,
			  ok_count = instance_entries.ok_count + 1,
			  last_checked_at = excluded.last_checked_at`,
			string(service), label, encodeJSON(stored), fp, string(check.Status), check.Premium,
			check.Detail, check.LatencyMs, time.Now()); err != nil {
			logf("[health] instance upsert failed: %v", err)
			return
		}

		mu.Lock()
		if exists {
			result.Updated++
		} else {
			result.Added++
		}
		mu.Unlock()
	})

	return result, nil
}

func hasHTTPPrefix(u string) bool {
	return len(u) >= 4 && u[:4] == "http"
}
