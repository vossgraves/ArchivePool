package pool

import (
	"context"
	"fmt"
	"strings"
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
)

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

func toLeased(row db.Row, clientKey []byte) LeasedEntry {
	// Decrypt at rest, re-encrypt for the client, so what leaves the server is ciphertext
	// end-to-end. Routes fail closed when no key is available.
	payload := crypto.DecryptAtRest(row.JSON("payload"))
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

// LeaseAccounts leases account credentials per service: held-by-this-key first, then premium, then
// least-recently-leased. A thin pool degrades to fewer entries rather than erroring; a nil keyID
// collapses it to the plain global rotation and an empty scope to every service.
func LeaseAccounts(ctx context.Context, database *db.DB, clientKey []byte, keyID *int, scope Service) (*LeaseResult[ServiceAccounts], error) {
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

	leasedIDs := make([]int, 0, 16)
	picked := make([]leaseRef, 0, 16)
	group := func(service Service) []LeasedEntry {
		rowsForService := byService[string(service)]
		if len(rowsForService) > LEASE_PER_CATEGORY_ACCOUNT {
			rowsForService = rowsForService[:LEASE_PER_CATEGORY_ACCOUNT]
		}
		out := make([]LeasedEntry, 0, len(rowsForService))
		for _, r := range rowsForService {
			leasedIDs = append(leasedIDs, r.Int("id"))
			picked = append(picked, leaseRef{ID: r.Int("id"), Service: service})
			out = append(out, toLeased(r, clientKey))
		}
		return out
	}

	groups := ServiceAccounts{
		Tidal: group(ServiceTidal),
		Qobuz: group(ServiceQobuz),
		// Deezer and Apple Music are account-only, so their instance lists stay empty and the
		// response shape matches. Apple's dev JWT is deliberately not pooled.
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
func stampLeases(ctx context.Context, database *db.DB, table string, ids []int) {
	if len(ids) == 0 {
		return
	}
	base := time.Now()
	err := database.Tx(ctx, func(tx *db.Tx) error {
		for i, id := range ids {
			if _, err := tx.Exec(ctx,
				`update `+table+` set last_leased_at = $1 where id = $2`,
				base.Add(time.Duration(i)*time.Millisecond), id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
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
		select a.id, a.service, a.premium, a.status, a.latency_ms, a.last_checked_at, a.payload
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
