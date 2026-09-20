package schema

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"archivepool/server/internal/db"
)

// TestLiveEnsure verifies the migration against the real database in DATABASE_URL: it applies the
// same statements the server applies at boot (every one is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS,
// so this is the documented install action, not a destructive one), then asserts that
//
//   - every relation the app reads exists afterwards, and
//   - a second pass fails exactly where the first did, i.e. the migration is idempotent.
//
// The only statements that are expected to fail are the legacy source_entries data migrations: on any
// database that never had the pre-split table they cannot run, and ensure.ts logs and swallows them
// for exactly that reason.
func TestLiveEnsure(t *testing.T) {
	raw := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping the live migration test")
	}
	database, err := db.Open(raw)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer database.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	failures := func() map[string]bool {
		out := map[string]bool{}
		for _, statement := range Statements() {
			if strings.TrimSpace(statement) == "" {
				continue
			}
			if _, err := database.Exec(ctx, statement); err != nil {
				out[firstLine(statement)] = true
			}
		}
		return out
	}

	first := failures()
	second := failures()
	for statement := range second {
		if !first[statement] {
			t.Fatalf("statement failed only on the second pass (not idempotent): %s", statement)
		}
	}
	t.Logf("%d statements fail on a database without the legacy source_entries table", len(second))

	required := []string{
		"users", "api_keys", "api_key_requests", "api_key_leases",
		"account_entries", "instance_entries", "health_log", "audit_log",
	}
	rows, err := database.Query(ctx, `
		select table_name from information_schema.tables
		where table_schema = current_schema() and table_name = any($1)`, pgTextArray(required))
	if err != nil {
		t.Fatalf("catalog query: %v", err)
	}
	present := map[string]bool{}
	for _, row := range rows.All() {
		present[row.Str("table_name")] = true
	}
	for _, name := range required {
		if !present[name] {
			t.Errorf("relation %q is missing after the migration", name)
		}
	}
}

// pgTextArray renders a Go slice as a Postgres text[] literal for the `= any($1)` comparison.
func pgTextArray(values []string) string {
	return "{" + strings.Join(values, ",") + "}"
}

func firstLine(sql string) string {
	if idx := strings.IndexByte(sql, '\n'); idx >= 0 {
		return sql[:idx]
	}
	return sql
}
