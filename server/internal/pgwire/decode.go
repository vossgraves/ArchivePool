package pgwire

import (
	"strconv"
	"time"
)

// PostgreSQL type OIDs the app can encounter, in text format.
const (
	oidBool        = 16
	oidBytea       = 17
	oidName        = 19
	oidInt8        = 20
	oidInt2        = 21
	oidInt4        = 23
	oidText        = 25
	oidJSON        = 114
	oidFloat4      = 700
	oidFloat8      = 701
	oidVarchar     = 1043
	oidChar        = 1042
	oidDate        = 1082
	oidTimestamp   = 1114
	oidTimestamptz = 1184
	oidNumeric     = 1700
	oidJSONB       = 3802
)

// decodeText converts one text-format column value into a Go value: nil, bool, int64, float64,
// string, []byte or time.Time. Everything else falls back to the raw string, so an unexpected type
// degrades instead of failing the query.
func decodeText(oid uint32, raw []byte) any {
	s := string(raw)
	switch oid {
	case oidBool:
		return s == "t"
	case oidInt2, oidInt4, oidInt8:
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
		return s
	case oidFloat4, oidFloat8, oidNumeric:
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
		return s
	case oidTimestamptz, oidTimestamp:
		if t, ok := parsePGTime(s); ok {
			return t
		}
		return s
	case oidBytea:
		return raw
	case oidText, oidVarchar, oidChar, oidName, oidJSON, oidJSONB, oidDate:
		return s
	default:
		return s
	}
}

// pgTimeLayouts covers the ISO DateStyle output PostgreSQL sends for timestamp/timestamptz,
// including the `+00` and `+02:30` offset forms.
var pgTimeLayouts = []string{
	"2006-01-02 15:04:05.999999-07:00",
	"2006-01-02 15:04:05.999999-07",
	"2006-01-02 15:04:05-07:00",
	"2006-01-02 15:04:05-07",
	"2006-01-02 15:04:05.999999",
	"2006-01-02 15:04:05",
	"2006-01-02T15:04:05.999999Z07:00",
}

func parsePGTime(s string) (time.Time, bool) {
	for _, layout := range pgTimeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
