// SPDX-License-Identifier: GPL-3.0-or-later
package pool

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"archivepool/server/internal/db"
)

// HISTORY_DAYS is deliberately short: health_log is pruned at 30 days by the sweep, so a longer
// window would silently flatten out.
const HISTORY_DAYS = 14

// UptimePoint is one day of health-check history; Pct is null for a day nothing was checked.
type UptimePoint struct {
	Day     string   `json:"day"`
	Label   string   `json:"label"`
	Checks  int      `json:"checks"`
	OK      int      `json:"ok"`
	Pct     *float64 `json:"pct"`
	Partial bool     `json:"partial"`
}

// CategoryPoints is one public category's daily series.
type CategoryPoints struct {
	Service string        `json:"service"`
	Kind    string        `json:"kind"`
	Points  []UptimePoint `json:"points"`
}

// PoolHistory is the pool-wide series plus the same series split per public category.
type PoolHistory struct {
	Overall    []UptimePoint    `json:"overall"`
	Categories []CategoryPoints `json:"categories"`
}

type HistoryRow struct {
	Service string
	Kind    string
	Day     string
	Checks  int
	OK      int
}

var months = [12]string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}

// ReadHistory reads daily pass rates per category. health_log records only an entry id, so the
// join back to the entry tables is what recovers the service — and ids are unique across the pair,
// which is what makes one join per table safe.
//
// entryIDs == nil means "every entry"; an empty slice means "no entries" (the dashboard's
// contribution history for a user with no contributions).
func ReadHistory(ctx context.Context, database *db.DB, entryIDs []int) ([]HistoryRow, error) {
	database.EnsureSchema(ctx)

	args := []any{HISTORY_DAYS}
	scope := "true"
	if entryIDs != nil {
		if len(entryIDs) == 0 {
			scope = "false"
		} else {
			placeholders := make([]string, 0, len(entryIDs))
			for _, id := range entryIDs {
				args = append(args, id)
				placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
			}
			scope = "h.entry_id in (" + strings.Join(placeholders, ", ") + ")"
		}
	}

	rows, err := database.Query(ctx, `
		with entries as (
		  select id, service, 'account' as kind from account_entries
		  union all
		  select id, service, 'api' as kind from instance_entries
		)
		select e.service as service,
		       e.kind as kind,
		       to_char(date_trunc('day', h.checked_at at time zone 'utc'), 'YYYY-MM-DD') as day,
		       count(*)::int as checks,
		       count(*) filter (where h.ok)::int as ok
		from health_log h
		join entries e on e.id = h.entry_id
		where h.checked_at >= now() - make_interval(days => $1) and `+scope+`
		group by 1, 2, 3`, args...)
	if err != nil {
		return nil, err
	}

	out := make([]HistoryRow, 0, rows.Len())
	for _, r := range rows.All() {
		out = append(out, HistoryRow{
			Service: r.Str("service"),
			Kind:    r.Str("kind"),
			Day:     r.Str("day"),
			Checks:  r.Int("checks"),
			OK:      r.Int("ok"),
		})
	}
	return out, nil
}

// GetPoolHistory reads the pool-wide series and the per-category split.
func GetPoolHistory(ctx context.Context, database *db.DB) (PoolHistory, error) {
	rows, err := ReadHistory(ctx, database, nil)
	if err != nil {
		return PoolHistory{}, err
	}
	out := PoolHistory{Overall: ToPoints(BucketBy(rows, nil))}
	out.Categories = make([]CategoryPoints, 0, len(Categories))
	for _, cat := range Categories {
		service, kind := cat.Service, cat.Kind
		points := ToPoints(BucketBy(rows, func(r HistoryRow) bool {
			return r.Service == string(service) && r.Kind == string(kind)
		}))
		out.Categories = append(out.Categories, CategoryPoints{
			Service: string(cat.Service),
			Kind:    string(cat.Kind),
			Points:  points,
		})
	}
	return out, nil
}

// BucketBy sums the daily rows, optionally filtered.
func BucketBy(rows []HistoryRow, match func(HistoryRow) bool) map[string]*bucket {
	buckets := map[string]*bucket{}
	for _, row := range rows {
		if match != nil && !match(row) {
			continue
		}
		b := buckets[row.Day]
		if b == nil {
			b = &bucket{}
			buckets[row.Day] = b
		}
		b.checks += row.Checks
		b.ok += row.OK
	}
	return buckets
}

type bucket struct {
	checks int
	ok     int
}

// ToPoints renders a bucket map onto the day grid.
func ToPoints(buckets map[string]*bucket, days ...int) []UptimePoint {
	n := HISTORY_DAYS
	if len(days) > 0 {
		n = days[0]
	}
	out := make([]UptimePoint, 0, n)
	for _, slot := range dayGrid(n) {
		var checks, ok int
		if b := buckets[slot.day]; b != nil {
			checks, ok = b.checks, b.ok
		}
		var pct *float64
		if checks > 0 {
			v := math.Round((float64(ok)/float64(checks))*1000) / 10
			pct = &v
		}
		out = append(out, UptimePoint{
			Day:     slot.day,
			Label:   slot.label,
			Checks:  checks,
			OK:      ok,
			Pct:     pct,
			Partial: slot.partial,
		})
	}
	return out
}

type daySlot struct {
	day     string
	label   string
	partial bool
}

// dayGrid builds the UTC days the charts draw, oldest first, with today flagged partial (it is
// still accumulating checks, so charts draw it dashed rather than as a fall).
func dayGrid(days int) []daySlot {
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	out := make([]daySlot, 0, days)
	for i := 0; i < days; i++ {
		date := today.AddDate(0, 0, -(days - 1 - i))
		out = append(out, daySlot{
			day:     date.Format("2006-01-02"),
			label:   fmt.Sprintf("%d %s", date.Day(), months[int(date.Month())-1]),
			partial: i == days-1,
		})
	}
	return out
}
