// SPDX-License-Identifier: GPL-3.0-or-later
package db

import (
	"encoding/json"
	"strconv"
	"time"

	"archivepool/server/internal/pgwire"
)

// Rows is a materialised result set with accessors by column name. Column lookups are by name
// (not ordinal) so a changed SELECT list cannot silently shift a field, which is how the TS reads
// rows too (drizzle's select({...}) keys).
type Rows struct {
	cols []string
	idx  map[string]int
	data [][]any
}

func newRows(res *pgwire.Result) *Rows {
	r := &Rows{data: res.Data}
	if len(res.Columns) > 0 {
		r.cols = make([]string, len(res.Columns))
		r.idx = make(map[string]int, len(res.Columns))
		for i, c := range res.Columns {
			r.cols[i] = c.Name
			r.idx[c.Name] = i
		}
	}
	return r
}

// NewRowsForTest builds a Rows from raw values (used by the table-driven tests).
func NewRowsForTest(cols []string, data [][]any) *Rows {
	r := &Rows{cols: cols, data: data, idx: map[string]int{}}
	for i, c := range cols {
		r.idx[c] = i
	}
	return r
}

func (r *Rows) Len() int {
	if r == nil {
		return 0
	}
	return len(r.data)
}

func (r *Rows) Row(i int) Row {
	if r == nil || i < 0 || i >= len(r.data) {
		return Row{rows: r, i: -1}
	}
	return Row{rows: r, i: i}
}

func (r *Rows) All() []Row {
	out := make([]Row, 0, r.Len())
	for i := 0; i < r.Len(); i++ {
		out = append(out, Row{rows: r, i: i})
	}
	return out
}

// Row is one row of a Rows. A zero Row is invalid.
type Row struct {
	rows *Rows
	i    int
}

func (r Row) Valid() bool { return r.rows != nil && r.i >= 0 && r.i < len(r.rows.data) }

// Any returns the raw decoded value: nil, bool, int64, float64, string, []byte or time.Time.
func (r Row) Any(col string) any {
	if !r.Valid() {
		return nil
	}
	idx, ok := r.rows.idx[col]
	if !ok || idx >= len(r.rows.data[r.i]) {
		return nil
	}
	return r.rows.data[r.i][idx]
}

func (r Row) Str(col string) string {
	s, _ := toString(r.Any(col))
	return s
}

func (r Row) StrOK(col string) (string, bool) {
	return toString(r.Any(col))
}

// StrPtr maps SQL NULL to nil, which is what the routes need when they distinguish "absent" from
// an empty string (e.g. ledger.reason defaults to ” but reviewer notes are genuinely absent).
func (r Row) StrPtr(col string) *string {
	v := r.Any(col)
	if v == nil {
		return nil
	}
	s, ok := toString(v)
	if !ok {
		return nil
	}
	return &s
}

func (r Row) Int(col string) int {
	return int(r.Int64(col))
}

func (r Row) Int64(col string) int64 {
	switch v := r.Any(col).(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case bool:
		if v {
			return 1
		}
		return 0
	case string:
		var n int64
		for _, ch := range v {
			if ch < '0' || ch > '9' {
				return 0
			}
			n = n*10 + int64(ch-'0')
		}
		return n
	}
	return 0
}

func (r Row) IntPtr(col string) *int {
	if r.Any(col) == nil {
		return nil
	}
	n := r.Int(col)
	return &n
}

func (r Row) Bool(col string) bool {
	switch v := r.Any(col).(type) {
	case bool:
		return v
	case string:
		return v == "t" || v == "true"
	case int64:
		return v != 0
	}
	return false
}

func (r Row) BoolPtr(col string) *bool {
	if r.Any(col) == nil {
		return nil
	}
	b := r.Bool(col)
	return &b
}

// Time returns NULL as nil.
func (r Row) Time(col string) *time.Time {
	switch v := r.Any(col).(type) {
	case time.Time:
		t := v
		return &t
	case string:
		if t, ok := parseAnyTime(v); ok {
			return &t
		}
	}
	return nil
}

// JSON decodes a jsonb/json column into a map. A scalar or malformed value yields nil.
func (r Row) JSON(col string) map[string]any {
	switch v := r.Any(col).(type) {
	case string:
		var m map[string]any
		if err := json.Unmarshal([]byte(v), &m); err != nil {
			return nil
		}
		return m
	case []byte:
		var m map[string]any
		if err := json.Unmarshal(v, &m); err != nil {
			return nil
		}
		return m
	}
	return nil
}

func toString(v any) (string, bool) {
	switch x := v.(type) {
	case nil:
		return "", false
	case string:
		return x, true
	case []byte:
		return string(x), true
	case bool:
		if x {
			return "t", true
		}
		return "f", true
	case int64:
		return formatInt(x), true
	case float64:
		return formatFloat(x), true
	case time.Time:
		return ISOTime(x), true
	}
	return "", false
}

func formatInt(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [24]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func formatFloat(f float64) string {
	// Match JavaScript's number rendering (JSON.stringify / String): shortest round-trip form.
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// ISOTime formats a timestamp exactly as JavaScript's Date#toISOString does: UTC, milliseconds,
// three fractional digits (Go's RFC3339Nano would drop them for whole seconds).
func ISOTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// ISOPtr renders a nullable timestamp as the TS does (`value == null ? null : new Date(value).toISOString()`).
func ISOPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := ISOTime(*t)
	return &s
}

// AnyISOPtr is ISOPtr for a raw column value.
func AnyISOPtr(v any) *string {
	switch x := v.(type) {
	case nil:
		return nil
	case time.Time:
		s := ISOTime(x)
		return &s
	case string:
		if t, ok := parseAnyTime(x); ok {
			s := ISOTime(t)
			return &s
		}
		return nil
	}
	return nil
}

func parseAnyTime(s string) (time.Time, bool) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999-07:00",
		"2006-01-02 15:04:05.999999-07",
		"2006-01-02",
	}
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
