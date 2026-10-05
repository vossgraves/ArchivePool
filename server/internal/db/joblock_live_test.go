// SPDX-License-Identifier: GPL-3.0-or-later
package db

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveJobLease runs against the real database in DATABASE_URL, because the claim is a single
// `insert … on conflict do update … where` statement whose semantics are the whole guard: a second
// caller must not be able to take a lease somebody else holds, a release must free it, an expired one
// must become claimable again (so a crashed run cannot block the schedule forever), and a stale
// holder's late release must not free the lease that replaced it.
//
// It touches only the job_locks table, under a name no real job uses, and deletes its row afterwards.
func TestLiveJobLease(t *testing.T) {
	raw := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if raw == "" {
		t.Skip("DATABASE_URL is not set; skipping the live job-lease test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	// Two independent pools, standing in for two instances (or two replicas) sharing one database.
	first, err := Open(raw)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { first.Close() })
	second, err := Open(raw)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { second.Close() })

	const job = "live-test-lease"
	first.EnsureSchema(ctx)
	if _, err := first.Exec(ctx, `delete from job_locks where name = $1`, job); err != nil {
		t.Fatalf("preparing %s: %v", job, err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := first.Exec(cleanup, `delete from job_locks where name = $1`, job); err != nil {
			t.Logf("could not delete the %s lease row: %v", job, err)
		}
	})

	claim := func(database *DB, ttl time.Duration, want bool, what string) *JobLease {
		t.Helper()
		lease, ok, err := database.ClaimJob(ctx, job, ttl)
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		if ok != want {
			t.Fatalf("%s: lease=%v, want %v", what, ok, want)
		}
		if !ok {
			return nil
		}
		return lease
	}

	held := claim(first, time.Minute, true, "first claim")
	claim(second, time.Minute, false, "a second caller must not take a held lease")

	held.Release(ctx)
	short := claim(second, 3*time.Second, true, "claim after release")
	claim(first, time.Minute, false, "the released lease is still held by its new owner")

	// A lease that has run out is claimable again — how a process that dies mid-run stops holding
	// the job — and the dead holder's late release must not free the new one.
	time.Sleep(3500 * time.Millisecond)
	replacement := claim(first, time.Minute, true, "an expired lease must be claimable")
	short.Release(ctx)
	claim(second, time.Minute, false, "a stale holder's release must not free the current lease")
	replacement.Release(ctx)
	claim(second, time.Minute, true, "claim after the replacement released")
}
