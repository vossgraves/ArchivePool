// SPDX-License-Identifier: GPL-3.0-or-later
package pool

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"archivepool/server/internal/crypto"
	"archivepool/server/internal/db"
)

// Entries one request may hold per category, and the per-key sticky window. Not 1 for tokens: the
// app tries the next credential when one fails, so a single lease turns any bad credential into a
// hard playback failure (docs/LEASE_RESEARCH.md).
const (
	LEASE_PER_CATEGORY_ACCOUNT = 3
	LEASE_PER_CATEGORY_API     = 10
	// Not 24h: that matches the app's refresh cadence exactly, so every lease would expire just as
	// the next refresh asked for a feed and the mechanism would degrade to reshuffling every time.
	LEASE_TTL_HOURS = 72
	// How many Tidal renewals a single lease request runs at once. Mirrors the Workers
	// TIDAL_REFRESH_CONCURRENCY: enough to keep one lease request from serializing several provider
	// round trips, low enough that a burst of lease requests cannot look like a refresh flood.
	leaseRefreshConcurrency = 3
)

// eachConcurrent runs fn over items with at most `concurrency` goroutines, in item order. Used for
// the bounded per-lease credential maintenance (see AccountLeaseMaintenance) — a lease request must
// not serialize one provider round trip per candidate.
func eachConcurrent[T any](ctx context.Context, items []T, concurrency int, fn func(T)) {
	if len(items) == 0 {
		return
	}
	if concurrency < 1 {
		concurrency = 1
	}
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, item := range items {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(item T) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(item)
		}(item)
	}
	wg.Wait()
}

// servableSQL is the single definition of "may be handed to an app". `preview` counts — Tidal keys
// commonly sit there while serving fine. A contributor-declared expiry that has passed also
// disqualifies the row, because a lapsed plan usually still authenticates (it just drops to
// previews, which the premium gate cannot see mid-cycle).
const (
	accountServableSQL  = `a.removed = false and a.disabled = false and a.status in ('alive','preview') and (a.expires_at is null or a.expires_at > now())`
	instanceServableSQL = `i.removed = false and i.disabled = false and i.status in ('alive','preview') and (i.expires_at is null or i.expires_at > now())`
)

// LeasedEntry is one served credential: identity/metadata plus the re-encrypted payload fields.
type LeasedEntry map[string]any

// ServiceAccounts is the per-service account groups /api/accounts returns.
type ServiceAccounts struct {
	Tidal       []LeasedEntry
	Qobuz       []LeasedEntry
	Deezer      []LeasedEntry
	AppleMusic  []LeasedEntry
	AmazonMusic []LeasedEntry
}

// For returns the group for a service (nil when the service has no account tier).
func (s ServiceAccounts) For(service Service) []LeasedEntry {
	switch service {
	case ServiceTidal:
		return s.Tidal
	case ServiceQobuz:
		return s.Qobuz
	case ServiceDeezer:
		return s.Deezer
	case ServiceAppleMusic:
		return s.AppleMusic
	case ServiceAmazonMusic:
		return s.AmazonMusic
	}
	return nil
}

// ServiceApis is the per-service instance groups /api/instances/[service] and /api/sources return.
type ServiceApis struct {
	Tidal       []LeasedEntry
	Qobuz       []LeasedEntry
	Deezer      []LeasedEntry
	AppleMusic  []LeasedEntry
	AmazonMusic []LeasedEntry
}

// For returns the group for a service.
func (s ServiceApis) For(service Service) []LeasedEntry {
	switch service {
	case ServiceTidal:
		return s.Tidal
	case ServiceQobuz:
		return s.Qobuz
	case ServiceDeezer:
		return s.Deezer
	case ServiceAppleMusic:
		return s.AppleMusic
	case ServiceAmazonMusic:
		return s.AmazonMusic
	}
	return nil
}

// LeaseResult is what a per-service lease produced, including how many rows were stamped.
type LeaseResult[T any] struct {
	Groups      T
	LeasedCount int
}

// servableForLease decides which of a service's candidate rows this lease may hand out, in order,
// capped at `limit`. Pure, so the rule is testable without a database.
//
// Every service serves its first `limit` candidates. Tidal is the exception: once the freshness hook
// ran, only rows inside its bounded window (`checked`) that it did not exclude are servable. An
// excluded row holds a token that is already expired and could not be renewed, and a row the window
// never reached may hold a token that is just as dead, so serving either would only make the app 401.
func servableForLease(service Service, ids []int, hookRan bool, checked, excluded map[int]bool, limit int) []int {
	served := make([]int, 0, limit)
	for _, id := range ids {
		if len(served) >= limit {
			break
		}
		if service == ServiceTidal && hookRan && (!checked[id] || excluded[id]) {
			continue
		}
		served = append(served, id)
	}
	return served
}

func toLeased(row db.Row, clientKey []byte) LeasedEntry {
	return toLeasedWithPayload(row, clientKey, nil)
}

// toLeasedWithPayload builds one served entry, from the row's stored payload or from an override the
// caller produced for this lease (a Tidal row whose access token was just renewed). The override is
// a DECRYPTED payload, so end-to-end encryption for the client still happens here.
func toLeasedWithPayload(row db.Row, clientKey []byte, override map[string]any) LeasedEntry {
	// Decrypt at rest, re-encrypt for the client, so what leaves the server is ciphertext
	// end-to-end. Routes fail closed when no key is available.
	payload := crypto.DecryptAtRest(row.JSON("payload"))
	if override != nil {
		payload = override
	}
	// The contributor's own password is kept only so the pool can renew the account; no consumer of
	// the pool may ever receive it, even encrypted.
	delete(payload, "password")
	out := LeasedEntry{
		"id":            row.Int("id"),
		"premium":       row.Bool("premium"),
		"status":        row.Str("status"),
		"latencyMs":     nil,
		"lastCheckedAt": nil,
	}
	if v := row.IntPtr("latency_ms"); v != nil {
		out["latencyMs"] = *v
	}
	if v := db.AnyISOPtr(row.Any("last_checked_at")); v != nil {
		out["lastCheckedAt"] = *v
	}
	for k, v := range crypto.EncryptForClient(payload, clientKey) {
		out[k] = v
	}
	return out
}

// AccountLeaseMaintenance is the per-lease credential upkeep the caller supplies. The pool layer
// owns no HTTP client — a Tidal access token expires roughly hourly while the sweep runs every six,
// so a leased token was routinely dead on arrival, and only the layer that can reach the provider
// may renew it.
type AccountLeaseMaintenance struct {
	// FreshTidalToken is called for at most LEASE_PER_CATEGORY_ACCOUNT*2 Tidal rows — enough that an
	// excluded entry can still be substituted — and never for any other service.
	FreshTidalToken FreshTidalTokenFunc
}

// FreshTidalTokenFunc receives a Tidal account's fingerprint and its DECRYPTED payload and returns
// the payload to serve (with a currently valid access token), or excluded = true when the entry must
// be left out of this lease because the credential it holds is already dead and could not be
// renewed. The fingerprint is what lets the implementation persist a rotated credential back onto
// the row: without it a lease can serve a fresh token while the row keeps the spent, single-use
// refresh token.
type FreshTidalTokenFunc func(ctx context.Context, fingerprint string, payload map[string]any) (fresh map[string]any, excluded bool)

// tidalFreshness is what the lease-time freshness pass decided: the rows it cleared with a new
// payload, the rows it excluded, and every row it attempted (the bounded window). A row outside
// `checked` was never consulted, so its stored token may already be dead.
type tidalFreshness struct {
	freshPayloads map[int]map[string]any
	excluded      map[int]bool
	checked       map[int]bool
}

// refreshTidalCandidates runs the freshness hook over the bounded candidate list with the lease
// refresh concurrency and merges the per-worker outcomes only AFTER the workers join. Each worker
// hands its result to the collector over a channel: the hook runs concurrently, so writing straight
// into the shared result maps would be a concurrent map write.
func refreshTidalCandidates(ctx context.Context, candidates []db.Row, hook FreshTidalTokenFunc) tidalFreshness {
	out := tidalFreshness{
		freshPayloads: map[int]map[string]any{},
		excluded:      map[int]bool{},
		checked:       map[int]bool{},
	}
	results := make(chan tidalCandidateOutcome, len(candidates))
	eachConcurrent(ctx, candidates, leaseRefreshConcurrency, func(row db.Row) {
		payload := crypto.DecryptAtRest(row.JSON("payload"))
		fresh, excluded := hook(ctx, row.Str("fingerprint"), payload)
		results <- tidalCandidateOutcome{id: row.Int("id"), fresh: fresh, excluded: excluded}
	})
	close(results)
	// Only a row whose hook returned counts as consulted: when ctx stops the workers early the rest
	// were never looked at, and a row outside `checked` is not served.
	for r := range results {
		out.checked[r.id] = true
		switch {
		case r.excluded:
			out.excluded[r.id] = true
		case r.fresh != nil:
			out.freshPayloads[r.id] = r.fresh
		}
	}
	return out
}

// tidalCandidateOutcome is one worker's result, merged after every worker has joined.
type tidalCandidateOutcome struct {
	id       int
	fresh    map[string]any
	excluded bool
}

// LeaseAccounts leases account credentials per service: held-by-this-key first, then premium, then
// least-recently-leased. A thin pool degrades to fewer entries rather than erroring; a nil keyID
// collapses it to the plain global rotation and an empty scope to every service.
//
// `maintenance` may be nil (no renewal is attempted). When it is supplied, a Tidal entry is served
// only if it went through the freshness hook and was not excluded by it — a fallback from the
// unchecked tail could serve what is already an expired token.
func LeaseAccounts(ctx context.Context, database *db.DB, clientKey []byte, keyID *int, scope Service, maintenance *AccountLeaseMaintenance) (*LeaseResult[ServiceAccounts], error) {
	database.EnsureSchema(ctx)

	args := []any{}
	if keyID != nil {
		args = append(args, *keyID, LEASE_TTL_HOURS)
	}
	if scope != "" {
		args = append(args, string(scope))
	}

	rows, err := database.Query(ctx, accountsLeaseQuery(keyID != nil, scope != ""), args...)
	if err != nil {
		return nil, err
	}

	byService := map[string][]db.Row{}
	for _, row := range rows.All() {
		s := row.Str("service")
		byService[s] = append(byService[s], row)
	}

	freshness := tidalFreshness{}
	hookRan := false
	if maintenance != nil && maintenance.FreshTidalToken != nil && (scope == "" || scope == ServiceTidal) {
		hookRan = true
		candidates := byService[string(ServiceTidal)]
		if len(candidates) > LEASE_PER_CATEGORY_ACCOUNT*2 {
			candidates = candidates[:LEASE_PER_CATEGORY_ACCOUNT*2]
		}
		// Bounded concurrency: each candidate is one provider round trip, and the list is short by
		// design (twice what gets served).
		freshness = refreshTidalCandidates(ctx, candidates, maintenance.FreshTidalToken)
	}

	leasedIDs := make([]int, 0, 16)
	picked := make([]leaseRef, 0, 16)
	group := func(service Service) []LeasedEntry {
		rowsForService := byService[string(service)]
		ids := make([]int, 0, len(rowsForService))
		rowsByID := make(map[int]db.Row, len(rowsForService))
		for _, r := range rowsForService {
			id := r.Int("id")
			ids = append(ids, id)
			rowsByID[id] = r
		}
		served := servableForLease(service, ids, hookRan, freshness.checked, freshness.excluded, LEASE_PER_CATEGORY_ACCOUNT)
		out := make([]LeasedEntry, 0, len(served))
		for _, id := range served {
			leasedIDs = append(leasedIDs, id)
			picked = append(picked, leaseRef{ID: id, Service: service})
			out = append(out, toLeasedWithPayload(rowsByID[id], clientKey, freshness.freshPayloads[id]))
		}
		return out
	}

	groups := ServiceAccounts{
		Tidal: group(ServiceTidal),
		Qobuz: group(ServiceQobuz),
		// Apple Music is account-only, so its instance list stays empty and the response shape
		// matches. Apple's dev JWT is deliberately not pooled.
		Deezer:      group(ServiceDeezer),
		AppleMusic:  group(ServiceAppleMusic),
		AmazonMusic: group(ServiceAmazonMusic),
	}

	stampLeases(ctx, database, "account_entries", leasedIDs)
	recordKeyLeases(ctx, database, keyID, picked)
	return &LeaseResult[ServiceAccounts]{Groups: groups, LeasedCount: len(leasedIDs)}, nil
}

// LeaseInstances is kept separate from LeaseAccounts so a caller can never receive tokens by asking
// for URLs.
func LeaseInstances(ctx context.Context, database *db.DB, clientKey []byte, scope Service) (*LeaseResult[ServiceApis], error) {
	database.EnsureSchema(ctx)

	args := []any{}
	if scope != "" {
		args = append(args, string(scope))
	}
	rows, err := database.Query(ctx, instancesLeaseQuery(scope != ""), args...)
	if err != nil {
		return nil, err
	}

	byService := map[string][]db.Row{}
	for _, row := range rows.All() {
		byService[row.Str("service")] = append(byService[row.Str("service")], row)
	}

	leasedIDs := make([]int, 0, 32)
	group := func(service Service) []LeasedEntry {
		rowsForService := byService[string(service)]
		if len(rowsForService) > LEASE_PER_CATEGORY_API {
			rowsForService = rowsForService[:LEASE_PER_CATEGORY_API]
		}
		out := make([]LeasedEntry, 0, len(rowsForService))
		for _, r := range rowsForService {
			leasedIDs = append(leasedIDs, r.Int("id"))
			out = append(out, toLeased(r, clientKey))
		}
		return out
	}

	groups := ServiceApis{
		Tidal:      group(ServiceTidal),
		Qobuz:      group(ServiceQobuz),
		Deezer:     group(ServiceDeezer),
		AppleMusic: group(ServiceAppleMusic),
		// Amazon instances are pooled like any other: the group fills from `instance_entries`
		// rows whose service is amazon-music (see Categories).
		AmazonMusic: group(ServiceAmazonMusic),
	}

	stampLeases(ctx, database, "instance_entries", leasedIDs)
	return &LeaseResult[ServiceApis]{Groups: groups, LeasedCount: len(leasedIDs)}, nil
}

// LeaseReplacement picks one replacement credential after a key reports a leased entry dead. Nil
// when the pool holds nothing the key does not already have — a replacement it already holds is
// worse than none.
func LeaseReplacement(ctx context.Context, database *db.DB, service Service, keyID int, clientKey []byte, excludeID int) (LeasedEntry, error) {
	database.EnsureSchema(ctx)
	row, err := database.QueryRow(ctx, replacementLeaseQuery,
		string(service), excludeID, keyID, LEASE_TTL_HOURS)
	if err != nil {
		return nil, err
	}
	if !row.Valid() {
		return nil, nil
	}

	stampLeases(ctx, database, "account_entries", []int{row.Int("id")})
	recordKeyLeases(ctx, database, &keyID, []leaseRef{{ID: row.Int("id"), Service: service}})
	return toLeased(row, clientKey), nil
}

// ReleaseLease drops one key's lease on entryID. True only when a row existed: /api/report treats
// that as proof the pool handed this exact entry to this exact key before issuing a replacement.
// Without the check, any registered key could report ids it never leased and harvest a credential
// for each — the pool-walking oracle per-key leases exist to close.
func ReleaseLease(ctx context.Context, database *db.DB, keyID, entryID int) bool {
	rows, err := database.Query(ctx,
		`delete from api_key_leases where key_id = $1 and entry_id = $2 returning entry_id`, keyID, entryID)
	if err != nil {
		// Errors read as "no lease found", so a bookkeeping failure cannot unlock a replacement.
		return false
	}
	return rows.Len() > 0
}

type leaseRef struct {
	ID      int
	Service Service
}

// stampLeases gives each id a DISTINCT timestamp, 1ms apart. One `SET last_leased_at = now()`
// across all of them writes an identical value, and the next request's ORDER BY then breaks the tie
// arbitrarily — entries recur instead of rotating. Errors are swallowed: a bookkeeping failure must
// never deny a client credentials it already holds.
//
// One statement, not one UPDATE per id: this runs on every credential fetch (up to 15 ids across the
// services), and a per-row loop would cost a round trip each time a client asks for credentials.
// Values are bound parameters, so the SQL text is static.
func stampLeases(ctx context.Context, database *db.DB, table string, ids []int) {
	if len(ids) == 0 {
		return
	}
	base := time.Now()
	var sb strings.Builder
	sb.WriteString(`update ` + table + ` as t set last_leased_at = v.stamp from (values `)
	args := make([]any, 0, len(ids)*2)
	for i, id := range ids {
		if i > 0 {
			sb.WriteString(", ")
		}
		args = append(args, id, base.Add(time.Duration(i)*time.Millisecond))
		first := len(args) - 1
		sb.WriteString(fmt.Sprintf("($%d::int, $%d::timestamptz)", first, first+1))
	}
	sb.WriteString(`) as v(id, stamp) where t.id = v.id`)
	if _, err := database.Exec(ctx, sb.String(), args...); err != nil {
		logf("[pool] failed to stamp lease timestamps %v", err)
	}
}

// recordKeyLeases has the same swallow-errors policy as stampLeases. ON CONFLICT DO UPDATE makes
// racing same-key requests benign: the slice in LeaseAccounts, not this table, bounds what is
// actually served, and any excess rows age out past the TTL.
func recordKeyLeases(ctx context.Context, database *db.DB, keyID *int, picked []leaseRef) {
	if keyID == nil || len(picked) == 0 {
		return
	}
	var sb strings.Builder
	sb.WriteString(`insert into api_key_leases (key_id, entry_id, service, leased_at) values `)
	args := make([]any, 0, len(picked)*4)
	for i, p := range picked {
		if i > 0 {
			sb.WriteString(", ")
		}
		args = append(args, *keyID, p.ID, string(p.Service), time.Now())
		base := len(args) - 3
		sb.WriteString(fmt.Sprintf("($%d, $%d, $%d, $%d)", base, base+1, base+2, base+3))
	}
	sb.WriteString(` on conflict (key_id, entry_id) do update set leased_at = excluded.leased_at, service = excluded.service`)
	if _, err := database.Exec(ctx, sb.String(), args...); err != nil {
		logf("[pool] failed to record per-key leases %v", err)
	}
}

// The query builders below are the single definition of the lease SQL. They are separate functions so
// the live integration test can execute exactly what the routes execute (inside a rolled-back
// transaction) instead of a copy that could drift.

// accountsLeaseQuery leases account credentials per service: held-by-this-key first, then premium,
// then least-recently-leased. A scoped key's row set is narrowed in SQL, so it cannot even load
// another service's credentials, let alone return them.
//
// Entries excluded by the WHERE clause rather than filtered afterwards, so a key whose leased entry
// died is never stranded on it. Held entries outrank even an unheld premium one: the app has these
// cached, and churning them costs more than the better pick gains. `id` makes the order total, so
// ties cannot rotate unstably.
func accountsLeaseQuery(heldByKey, scoped bool) string {
	// The placeholder numbers are derived from which clauses are present: an anonymous, scoped lease
	// (no key id) binds only the service, and hardcoding $3 there would leave the parameter unbound.
	held := "false"
	next := 1
	if heldByKey {
		held = fmt.Sprintf(
			"l.entry_id = a.id and l.key_id = $%d and l.leased_at > now() - make_interval(hours => $%d)",
			next, next+1)
		next += 2
	}
	query := `
		select a.id, a.service, a.fingerprint, a.premium, a.status, a.latency_ms, a.last_checked_at, a.payload
		from account_entries a
		left join api_key_leases l on ` + held + `
		where ` + accountServableSQL
	if scoped {
		query += fmt.Sprintf(" and a.service = $%d", next)
	}
	return query + `
		order by (l.key_id is not null) desc, a.premium desc, a.last_leased_at asc nulls first, a.id asc`
}

// instancesLeaseQuery is the instance equivalent; it never joins the lease table, because instance
// URLs are public and rotation is global.
func instancesLeaseQuery(scoped bool) string {
	query := `
		select i.id, i.service, i.premium, i.status, i.latency_ms, i.last_checked_at, i.payload
		from instance_entries i
		where ` + instanceServableSQL
	if scoped {
		query += " and i.service = $1"
	}
	return query + ` order by i.premium desc, i.last_leased_at asc nulls first, i.id asc`
}

// replacementLeaseQuery is the single replacement credential a key gets after reporting one dead.
// A replacement the key already holds is worse than none, hence the NOT EXISTS.
const replacementLeaseQuery = `
	select a.id, a.premium, a.status, a.latency_ms, a.last_checked_at, a.payload
	from account_entries a
	where ` + accountServableSQL + `
	  and a.service = $1
	  and a.id <> $2
	  and not exists (
	    select 1 from api_key_leases l
	    where l.key_id = $3 and l.entry_id = a.id
	      and l.leased_at > now() - make_interval(hours => $4)
	  )
	order by a.premium desc, a.last_leased_at asc nulls first, a.id asc
	limit 1`
