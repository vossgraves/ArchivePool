// SPDX-License-Identifier: GPL-3.0-or-later
package pool

import (
	"context"
	"math"

	"archivepool/server/internal/db"
)

// CategoryStatus is the credential-free aggregate the public status page renders.
type CategoryStatus struct {
	Service       string   `json:"service"`
	Kind          string   `json:"kind"`
	Label         string   `json:"label"`
	Total         int      `json:"total"`
	Alive         int      `json:"alive"`
	Premium       int      `json:"premium"`
	Dead          int      `json:"dead"`
	Pending       int      `json:"pending"`
	UptimePct     *float64 `json:"uptimePct"`
	LastCheckedAt *string  `json:"lastCheckedAt"`
	Health        string   `json:"health"`
}

// GetStatus aggregates the board's figures. getStatus() is the one call the /api/status route
// cannot degrade around: without it there are no figures at all.
func GetStatus(ctx context.Context, database *db.DB) ([]CategoryStatus, error) {
	database.EnsureSchema(ctx)

	accounts, err := database.Query(ctx, `
		select service, status, premium, disabled, check_count, ok_count, last_checked_at
		from account_entries where removed = false`)
	if err != nil {
		return nil, err
	}
	instances, err := database.Query(ctx, `
		select service, status, premium, disabled, check_count, ok_count, last_checked_at
		from instance_entries where removed = false`)
	if err != nil {
		return nil, err
	}

	type row struct {
		service       string
		kind          string
		status        string
		premium       bool
		disabled      bool
		checkCount    int
		okCount       int
		lastCheckedAt *string
	}
	rows := make([]row, 0, accounts.Len()+instances.Len())
	collect := func(rs *db.Rows, kind Kind) {
		for _, r := range rs.All() {
			rows = append(rows, row{
				service:       r.Str("service"),
				kind:          string(kind),
				status:        r.Str("status"),
				premium:       r.Bool("premium"),
				disabled:      r.Bool("disabled"),
				checkCount:    r.Int("check_count"),
				okCount:       r.Int("ok_count"),
				lastCheckedAt: db.AnyISOPtr(r.Any("last_checked_at")),
			})
		}
	}
	collect(accounts, KindAccount)
	collect(instances, KindAPI)

	out := make([]CategoryStatus, 0, len(Categories))
	for _, cat := range Categories {
		items := make([]row, 0, 8)
		for _, r := range rows {
			if r.service == string(cat.Service) && r.kind == string(cat.Kind) {
				items = append(items, r)
			}
		}

		// Disabled entries are served to nobody, so they must not read as alive here.
		alive, premium, dead, pending := 0, 0, 0, 0
		var totalChecks, totalOk int
		// Deviation (documented in README): the TS sorts Date objects with the default comparator,
		// i.e. lexicographically by their toString() (weekday name first), and pops the result. This
		// port returns the true latest check instead of a weekday-ordered artefact.
		var latest *string
		for _, r := range items {
			if !r.disabled && (r.status == "alive" || r.status == "preview") {
				alive++
			}
			if !r.disabled && r.status == "alive" && r.premium {
				premium++
			}
			if r.status == "dead" {
				dead++
			}
			if r.status == "pending" {
				pending++
			}
			totalChecks += r.checkCount
			totalOk += r.okCount
			if r.lastCheckedAt != nil && (latest == nil || *r.lastCheckedAt > *latest) {
				latest = r.lastCheckedAt
			}
		}

		var uptime *float64
		if totalChecks > 0 {
			v := math.Round((float64(totalOk)/float64(totalChecks))*1000) / 10
			uptime = &v
		}

		health := "unknown"
		if len(items) > 0 {
			switch {
			case alive > 0 && premium > 0:
				health = "operational"
			case alive > 0:
				health = "degraded"
			default:
				health = "down"
			}
		}

		out = append(out, CategoryStatus{
			Service:       string(cat.Service),
			Kind:          string(cat.Kind),
			Label:         cat.Label,
			Total:         len(items),
			Alive:         alive,
			Premium:       premium,
			Dead:          dead,
			Pending:       pending,
			UptimePct:     uptime,
			LastCheckedAt: latest,
			Health:        health,
		})
	}
	return out, nil
}
