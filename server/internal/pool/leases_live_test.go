package pool

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"archivepool/server/internal/db"
)

// These tests run only against the real database in DATABASE_URL, because the lease SQL is the one
// piece of the credential path whose syntax and ordering cannot be checked in isolation. They are
// deliberately WRITE-FREE:
//
//   - the query-builder tests execute the exact production SQL inside a transaction that is always
//     rolled back (Tx returns the sentinel error below), so nothing is committed;
//   - the function-level tests use a service that holds no rows of that kind, so the rows a lease
//     would stamp or record are empty and the write helpers no-op by construction.

func liveDB(t *testing.T) *db.DB {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping the live lease tests")
	}
	database, err := db.Open(raw)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

// errRollback is the sentinel that forces the transaction (and every read inside it) to roll back.
var errRollback = errors.New("test: roll back")

func TestLiveLeaseQueries(t *testing.T) {
	database := liveDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Any existing key id works: the query only ever reads the lease table.
	var keyID int
	row, err := database.QueryRow(ctx, `select id from api_keys order by id limit 1`)
	if err != nil {
		t.Fatalf("reading a key id: %v", err)
	}
	if row.Valid() {
		keyID = row.Int("id")
	}

	cases := []struct {
		name  string
		query string
		args  []any
	}{
		{"accounts lease, keyed and scoped", accountsLeaseQuery(true, true), []any{keyID, LEASE_TTL_HOURS, "tidal"}},
		{"accounts lease, keyed and global", accountsLeaseQuery(true, false), []any{keyID, LEASE_TTL_HOURS}},
		{"accounts lease, anonymous and scoped", accountsLeaseQuery(false, true), []any{"tidal"}},
		{"accounts lease, anonymous and global", accountsLeaseQuery(false, false), nil},
		{"instances lease, scoped", instancesLeaseQuery(true), []any{"tidal"}},
		{"instances lease, global", instancesLeaseQuery(false), nil},
		{"replacement lease", replacementLeaseQuery, []any{"tidal", 0, keyID, LEASE_TTL_HOURS}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var scanned int
			err := database.Tx(ctx, func(tx *db.Tx) error {
				rows, err := tx.Query(ctx, tc.query, tc.args...)
				if err != nil {
					return err
				}
				// Touch the columns the lease code reads, so a column-name slip fails here too.
				for _, r := range rows.All() {
					_ = r.Int("id")
					_ = r.Bool("premium")
					_ = r.Str("status")
					_ = r.IntPtr("latency_ms")
					_ = db.AnyISOPtr(r.Any("last_checked_at"))
					_ = r.JSON("payload")
					scanned++
				}
				return errRollback
			})
			if !errors.Is(err, errRollback) {
				t.Fatalf("query failed: %v", err)
			}
			t.Logf("%s: %d rows (rolled back)", tc.name, scanned)
		})
	}
}

// TestLiveLeaseFunctionsWriteNothing calls the four exported lease functions against services that
// hold no rows of the kind in question, so the stamping/recording helpers receive an empty slice.
func TestLiveLeaseFunctionsWriteNothing(t *testing.T) {
	database := liveDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Pick services that genuinely have no servable rows, so the "no write" property holds.
	emptyAccountService := emptyService(ctx, t, database, "account_entries")
	emptyInstanceService := emptyService(ctx, t, database, "instance_entries")

	var keyID *int
	rows, err := database.Query(ctx, `select id from api_keys order by id limit 1`)
	if err != nil {
		t.Fatalf("reading a key id: %v", err)
	}
	if rows.Len() > 0 {
		id := rows.Row(0).Int("id")
		keyID = &id
	}

	if emptyAccountService != "" {
		result, err := LeaseAccounts(ctx, database, nil, keyID, emptyAccountService)
		if err != nil {
			t.Fatalf("LeaseAccounts(%s): %v", emptyAccountService, err)
		}
		if result.LeasedCount != 0 {
			t.Fatalf("expected no leases for %s, got %d", emptyAccountService, result.LeasedCount)
		}
		group := result.Groups.For(emptyAccountService)
		if len(group) != 0 {
			t.Fatalf("expected an empty group, got %d entries", len(group))
		}
	} else {
		t.Log("every account service holds rows; skipped the write-free LeaseAccounts call")
	}

	if emptyInstanceService != "" {
		result, err := LeaseInstances(ctx, database, nil, emptyInstanceService)
		if err != nil {
			t.Fatalf("LeaseInstances(%s): %v", emptyInstanceService, err)
		}
		if result.LeasedCount != 0 {
			t.Fatalf("expected no leases for %s, got %d", emptyInstanceService, result.LeasedCount)
		}
	} else {
		t.Log("every instance service holds rows; skipped the write-free LeaseInstances call")
	}

	if emptyAccountService != "" && keyID != nil {
		picked, err := LeaseReplacement(ctx, database, emptyAccountService, *keyID, nil, 0)
		if err != nil {
			t.Fatalf("LeaseReplacement(%s): %v", emptyAccountService, err)
		}
		if picked != nil {
			t.Fatalf("expected no replacement from an empty service, got %#v", picked)
		}
	}

	// A release for an entry that was never leased deletes zero rows and reports false.
	if keyID != nil {
		if ReleaseLease(ctx, database, *keyID, 1<<30) {
			t.Fatal("ReleaseLease must report false for a lease that does not exist")
		}
	}
}

// emptyService returns a service with no rows in the given table, or "" when every service has rows.
func emptyService(ctx context.Context, t *testing.T, database *db.DB, table string) Service {
	t.Helper()
	rows, err := database.Query(ctx, `select service, count(*)::int as n from `+table+` group by service`)
	if err != nil {
		t.Fatalf("counting %s rows: %v", table, err)
	}
	populated := map[string]bool{}
	for _, r := range rows.All() {
		if r.Int("n") > 0 {
			populated[r.Str("service")] = true
		}
	}
	for _, service := range Services {
		if !populated[string(service)] {
			return service
		}
	}
	return ""
}
