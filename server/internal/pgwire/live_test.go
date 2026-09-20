package pgwire

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveConnection exercises the wire protocol (startup, SCRAM/MD5 auth, the extended protocol with
// bound parameters, JSONB round-tripping and ErrorResponse mapping) against the connection string in
// DATABASE_URL.
//
// It is read-only by construction: every statement is a SELECT, so running the suite can never
// mutate a deployment's data. The test skips when DATABASE_URL is unset, which is the case in CI.
func TestLiveConnection(t *testing.T) {
	raw := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping the live protocol test")
	}
	cfg, err := ParseConfig(raw)
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	conn, err := Dial(ctx, cfg)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	t.Run("simple query", func(t *testing.T) {
		res, err := conn.SimpleQuery(ctx, "select 1 as one")
		if err != nil {
			t.Fatalf("SimpleQuery: %v", err)
		}
		if res.RowCount() != 1 || res.Data[0][0] != int64(1) {
			t.Fatalf("unexpected result: %#v", res.Data)
		}
	})

	t.Run("bound parameters", func(t *testing.T) {
		res, err := conn.Query(ctx, `select $1::int as n, $2::text as t, $3::bool as b, $4::jsonb as j`,
			7, "hello", true, `{"a":1,"b":"x"}`)
		if err != nil {
			t.Fatalf("Query: %v", err)
		}
		row := res.Data[0]
		if row[0] != int64(7) || row[1] != "hello" || row[2] != true {
			t.Fatalf("unexpected row: %#v", row)
		}
		if !strings.Contains(row[3].(string), `"a"`) {
			t.Fatalf("jsonb did not round-trip: %#v", row[3])
		}
	})

	t.Run("null parameter", func(t *testing.T) {
		res, err := conn.Query(ctx, `select $1::text as nullable`, nil)
		if err != nil {
			t.Fatalf("Query: %v", err)
		}
		if res.Data[0][0] != nil {
			t.Fatalf("expected NULL, got %#v", res.Data[0][0])
		}
	})

	t.Run("timestamptz decoding", func(t *testing.T) {
		res, err := conn.Query(ctx, `select now() as ts`)
		if err != nil {
			t.Fatalf("Query: %v", err)
		}
		if _, ok := res.Data[0][0].(time.Time); !ok {
			t.Fatalf("expected time.Time, got %T", res.Data[0][0])
		}
	})

	t.Run("error mapping", func(t *testing.T) {
		_, err := conn.Query(ctx, `select * from archivepool_missing_table_xyz`)
		if err == nil {
			t.Fatal("expected an error for a missing relation")
		}
		if !strings.Contains(err.Error(), "archivepool_missing_table_xyz") {
			t.Fatalf("error message lost the relation name: %v", err)
		}
	})

	t.Run("connection still usable after error", func(t *testing.T) {
		res, err := conn.Query(ctx, `select 2 as two`)
		if err != nil {
			t.Fatalf("Query after error: %v", err)
		}
		if res.Data[0][0] != int64(2) {
			t.Fatalf("unexpected result: %#v", res.Data)
		}
	})
}
