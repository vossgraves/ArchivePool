package pool

import (
	"context"
	"math"
	"sort"

	"archivepool/server/internal/db"
)

// DashboardKey is a read key the signed-in user owns. No hash, ever — only the prefix is renderable.
type DashboardKey struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	Reason      string  `json:"reason"`
	Prefix      string  `json:"prefix"`
	Revoked     bool    `json:"revoked"`
	UseCount    int     `json:"useCount"`
	LastUsedAt  *string `json:"lastUsedAt"`
	CreatedAt   string  `json:"createdAt"`
	HeldEntries int     `json:"heldEntries"`
}

// DashboardRequest is one key request as its owner sees it.
type DashboardRequest struct {
	ID             int     `json:"id"`
	Subject        string  `json:"subject"`
	Reason         string  `json:"reason"`
	Status         string  `json:"status"`
	ReviewNote     string  `json:"reviewNote"`
	ResultingKeyID *int    `json:"resultingKeyId"`
	CreatedAt      string  `json:"createdAt"`
	ReviewedAt     *string `json:"reviewedAt"`
}

// DashboardLease is an entry one of the user's keys currently holds. Masked label only; the payload
// is never selected.
type DashboardLease struct {
	KeyID         int     `json:"keyId"`
	KeyName       string  `json:"keyName"`
	EntryID       int     `json:"entryId"`
	Service       string  `json:"service"`
	Label         string  `json:"label"`
	Status        string  `json:"status"`
	Premium       bool    `json:"premium"`
	LeasedAt      string  `json:"leasedAt"`
	ExpiresAt     *string `json:"expiresAt"`
	LastCheckedAt *string `json:"lastCheckedAt"`
}

// DashboardContribution is one contribution, with its health metrics.
type DashboardContribution struct {
	ID            int      `json:"id"`
	Kind          string   `json:"kind"`
	Service       string   `json:"service"`
	Label         string   `json:"label"`
	Status        string   `json:"status"`
	Premium       bool     `json:"premium"`
	Disabled      bool     `json:"disabled"`
	Removed       bool     `json:"removed"`
	ExpiresAt     *string  `json:"expiresAt"`
	LastCheckedAt *string  `json:"lastCheckedAt"`
	LatencyMs     *int     `json:"latencyMs"`
	CheckCount    int      `json:"checkCount"`
	OKCount       int      `json:"okCount"`
	UptimePct     *float64 `json:"uptimePct"`
	CreatedAt     string   `json:"createdAt"`
}

// DashboardSnapshot is everything /dashboard renders, in one server-side read.
type DashboardSnapshot struct {
	Keys                []DashboardKey          `json:"keys"`
	Requests            []DashboardRequest      `json:"requests"`
	Leases              []DashboardLease        `json:"leases"`
	Contributions       []DashboardContribution `json:"contributions"`
	ContributionHistory []UptimePoint           `json:"contributionHistory"`
	Pool                []CategoryStatus        `json:"pool"`
	PoolHistory         []UptimePoint           `json:"poolHistory"`
	Failed              []string                `json:"failed"`
}

// GetDashboard reads every dashboard section. A section that cannot load degrades to "unavailable"
// rather than 500ing the page: a reader whose history query timed out still needs the keys panel to
// revoke a leaked key.
//
// username is the contributor credit, which is how an entry is tied back to a person at all — the
// pool tables deliberately hold no user id. Anonymous contributions therefore cannot appear here,
// and that is the contributor's choice being honoured, not a gap.
func GetDashboard(ctx context.Context, database *db.DB, userID int, username string) (*DashboardSnapshot, error) {
	database.EnsureSchema(ctx)
	failed := []string{}

	keys, err := dashboardKeys(ctx, database, userID)
	if err != nil {
		logf("[dashboard] keys failed: %v", err)
		failed = append(failed, "keys")
		keys = []DashboardKey{}
	}

	requests, err := dashboardRequests(ctx, database, userID)
	if err != nil {
		logf("[dashboard] requests failed: %v", err)
		failed = append(failed, "requests")
		requests = []DashboardRequest{}
	}

	leaseRows, err := dashboardLeases(ctx, database, userID)
	if err != nil {
		logf("[dashboard] leases failed: %v", err)
		failed = append(failed, "leases")
		leaseRows = []DashboardLease{}
	}

	contributions, err := dashboardContributions(ctx, database, username)
	if err != nil {
		logf("[dashboard] contributions failed: %v", err)
		failed = append(failed, "contributions")
		contributions = []DashboardContribution{}
	}

	poolStatus, err := GetStatus(ctx, database)
	if err != nil {
		logf("[dashboard] pool failed: %v", err)
		failed = append(failed, "pool")
		poolStatus = []CategoryStatus{}
	}

	history, err := GetPoolHistory(ctx, database)
	if err != nil {
		logf("[dashboard] pool history failed: %v", err)
		failed = append(failed, "pool history")
		history = PoolHistory{Overall: []UptimePoint{}, Categories: []CategoryPoints{}}
	}

	held := map[int]int{}
	for _, lease := range leaseRows {
		held[lease.KeyID]++
	}
	for i := range keys {
		keys[i].HeldEntries = held[keys[i].ID]
	}

	contributionHistory := []UptimePoint{}
	if len(contributions) > 0 {
		ids := make([]int, 0, len(contributions))
		for _, c := range contributions {
			ids = append(ids, c.ID)
		}
		rows, err := ReadHistory(ctx, database, ids)
		if err != nil {
			logf("[dashboard] contribution history failed: %v", err)
			failed = append(failed, "contribution history")
		} else {
			contributionHistory = ToPoints(BucketBy(rows, nil))
		}
	}

	return &DashboardSnapshot{
		Keys:                keys,
		Requests:            requests,
		Leases:              leaseRows,
		Contributions:       contributions,
		ContributionHistory: contributionHistory,
		Pool:                poolStatus,
		PoolHistory:         history.Overall,
		Failed:              dedupe(failed),
	}, nil
}

func dashboardKeys(ctx context.Context, database *db.DB, userID int) ([]DashboardKey, error) {
	rows, err := database.Query(ctx, `
		select id, name, reason, prefix, revoked, use_count, last_used_at, created_at
		from api_keys
		where user_id = $1 and deleted = false
		order by created_at desc`, userID)
	if err != nil {
		return nil, err
	}
	out := make([]DashboardKey, 0, rows.Len())
	for _, r := range rows.All() {
		k := DashboardKey{
			ID:         r.Int("id"),
			Name:       r.Str("name"),
			Reason:     r.Str("reason"),
			Prefix:     r.Str("prefix"),
			Revoked:    r.Bool("revoked"),
			UseCount:   r.Int("use_count"),
			LastUsedAt: db.AnyISOPtr(r.Any("last_used_at")),
		}
		if created := db.AnyISOPtr(r.Any("created_at")); created != nil {
			k.CreatedAt = *created
		}
		out = append(out, k)
	}
	return out, nil
}

func dashboardRequests(ctx context.Context, database *db.DB, userID int) ([]DashboardRequest, error) {
	rows, err := database.Query(ctx, `
		select id, subject, reason, status, review_note, resulting_key_id, created_at, reviewed_at
		from api_key_requests
		where user_id = $1
		order by created_at desc`, userID)
	if err != nil {
		return nil, err
	}
	out := make([]DashboardRequest, 0, rows.Len())
	for _, r := range rows.All() {
		req := DashboardRequest{
			ID:             r.Int("id"),
			Subject:        r.Str("subject"),
			Reason:         r.Str("reason"),
			Status:         r.Str("status"),
			ReviewNote:     r.Str("review_note"),
			ResultingKeyID: r.IntPtr("resulting_key_id"),
			ReviewedAt:     db.AnyISOPtr(r.Any("reviewed_at")),
		}
		if created := db.AnyISOPtr(r.Any("created_at")); created != nil {
			req.CreatedAt = *created
		}
		out = append(out, req)
	}
	return out, nil
}

func dashboardLeases(ctx context.Context, database *db.DB, userID int) ([]DashboardLease, error) {
	rows, err := database.Query(ctx, `
		select l.key_id as key_id, k.name as key_name, a.id as entry_id, a.service as service,
		       a.label as label, a.status as status, a.premium as premium, a.disabled as disabled,
		       l.leased_at as leased_at, a.expires_at as expires_at, a.last_checked_at as last_checked_at
		from api_key_leases l
		inner join api_keys k on k.id = l.key_id
		inner join account_entries a on a.id = l.entry_id
		where k.user_id = $1 and k.deleted = false
		  and l.leased_at > now() - make_interval(hours => $2)
		order by l.leased_at desc`, userID, LEASE_TTL_HOURS)
	if err != nil {
		return nil, err
	}
	out := make([]DashboardLease, 0, rows.Len())
	for _, r := range rows.All() {
		// A disabled entry is no longer served, so listing it as "held" would be a lie the reader
		// cannot check.
		if r.Bool("disabled") {
			continue
		}
		lease := DashboardLease{
			KeyID:         r.Int("key_id"),
			KeyName:       r.Str("key_name"),
			EntryID:       r.Int("entry_id"),
			Service:       r.Str("service"),
			Label:         r.Str("label"),
			Status:        r.Str("status"),
			Premium:       r.Bool("premium"),
			ExpiresAt:     db.AnyISOPtr(r.Any("expires_at")),
			LastCheckedAt: db.AnyISOPtr(r.Any("last_checked_at")),
		}
		if leasedAt := db.AnyISOPtr(r.Any("leased_at")); leasedAt != nil {
			lease.LeasedAt = *leasedAt
		}
		out = append(out, lease)
	}
	return out, nil
}

func dashboardContributions(ctx context.Context, database *db.DB, username string) ([]DashboardContribution, error) {
	const columns = `id, service, label, status, premium, disabled, removed, expires_at,
		last_checked_at, latency_ms, check_count, ok_count, created_at`
	out := []DashboardContribution{}

	for _, table := range []string{"account_entries", "instance_entries"} {
		kind := KindAccount
		if table == "instance_entries" {
			kind = KindAPI
		}
		rows, err := database.Query(ctx,
			`select `+columns+` from `+table+` where contributor = $1 order by created_at desc`, username)
		if err != nil {
			return nil, err
		}
		for _, r := range rows.All() {
			c := DashboardContribution{
				ID:            r.Int("id"),
				Kind:          string(kind),
				Service:       r.Str("service"),
				Label:         r.Str("label"),
				Status:        r.Str("status"),
				Premium:       r.Bool("premium"),
				Disabled:      r.Bool("disabled"),
				Removed:       r.Bool("removed"),
				ExpiresAt:     db.AnyISOPtr(r.Any("expires_at")),
				LastCheckedAt: db.AnyISOPtr(r.Any("last_checked_at")),
				LatencyMs:     r.IntPtr("latency_ms"),
				CheckCount:    r.Int("check_count"),
				OKCount:       r.Int("ok_count"),
			}
			if c.CheckCount > 0 {
				pct := roundTenth(float64(c.OKCount) / float64(c.CheckCount) * 100)
				c.UptimePct = &pct
			}
			if created := db.AnyISOPtr(r.Any("created_at")); created != nil {
				c.CreatedAt = *created
			}
			out = append(out, c)
		}
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

// roundTenth mirrors the TS's Math.round((ok / checks) * 1000) / 10.
func roundTenth(v float64) float64 {
	return math.Round(v*10) / 10
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, v := range values {
		if seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}
