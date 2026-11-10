// SPDX-License-Identifier: GPL-3.0-or-later
package pool

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"archivepool/server/internal/db"
)

// TestServableForLease pins the rule that stops a lease from handing out a credential the pool
// already knows is dead. Tidal access tokens expire roughly hourly while the sweep runs every six, so
// a stored token is regularly expired; the pool must serve the rows the freshness hook renewed or
// confirmed, and skip the rest — including the rows a bounded hook window never reached, because
// their tokens may be just as dead.
func TestServableForLease(t *testing.T) {
	ids := []int{11, 12, 13, 14, 15, 16}

	cases := []struct {
		name    string
		service Service
		hookRan bool
		checked,
		excluded map[int]bool
		limit int
		want  []int
	}{
		{
			name:    "every service serves its first limit rows when no hook ran",
			service: ServiceTidal, hookRan: false, limit: 3,
			want: []int{11, 12, 13},
		},
		{
			name:    "tidal serves only the rows the hook cleared",
			service: ServiceTidal, hookRan: true, limit: 3,
			checked:  map[int]bool{11: true, 12: true, 13: true, 14: true, 15: true, 16: true},
			excluded: map[int]bool{11: true, 13: true},
			want:     []int{12, 14, 15},
		},
		{
			// The substitute rows move up instead of the group coming back short.
			name:    "an excluded row is replaced by the next cleared candidate",
			service: ServiceTidal, hookRan: true, limit: 3,
			checked:  map[int]bool{11: true, 12: true, 13: true, 14: true},
			excluded: map[int]bool{11: true, 12: true},
			want:     []int{13, 14},
		},
		{
			name:    "a row outside the hook window is not served",
			service: ServiceTidal, hookRan: true, limit: 3,
			checked: map[int]bool{11: true, 12: true, 13: true},
			want:    []int{11, 12, 13},
		},
		{
			name:    "other services ignore the tidal freshness maps",
			service: ServiceQobuz, hookRan: true, limit: 3,
			checked: map[int]bool{}, excluded: map[int]bool{11: true, 12: true},
			want: []int{11, 12, 13},
		},
		{
			name:    "all rows excluded yields nothing rather than an expired token",
			service: ServiceTidal, hookRan: true, limit: 3,
			checked:  map[int]bool{11: true, 12: true},
			excluded: map[int]bool{11: true, 12: true},
			want:     []int{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := servableForLease(tc.service, ids, tc.hookRan, tc.checked, tc.excluded, tc.limit)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("servable rows = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestAccountsLeaseQuerySelectsFingerprint pins the column the freshness hook persists rotations
// with. row.Str("fingerprint") yields "" for a missing column instead of failing, which silently
// disables that write — the lease serves a rotated token while the row keeps the spent single-use
// refresh token — so the query itself must select it.
func TestAccountsLeaseQuerySelectsFingerprint(t *testing.T) {
	for _, keyed := range []bool{false, true} {
		for _, scoped := range []bool{false, true} {
			if q := accountsLeaseQuery(keyed, scoped); !strings.Contains(q, "a.fingerprint") {
				t.Errorf("accountsLeaseQuery(heldByKey=%v, scoped=%v) must select a.fingerprint:\n%s", keyed, scoped, q)
			}
		}
	}
}

// tidalCandidateRows builds the row shape the accounts lease query returns: id, fingerprint and the
// payload column (plaintext here; DecryptAtRest leaves an unencrypted payload untouched).
func tidalCandidateRows(n int) []db.Row {
	data := make([][]any, 0, n)
	for i := 1; i <= n; i++ {
		data = append(data, []any{
			int64(i),
			fmt.Sprintf("fp-%d", i),
			fmt.Sprintf(`{"token":"tok-%d"}`, i),
		})
	}
	return db.NewRowsForTest([]string{"id", "fingerprint", "payload"}, data).All()
}

// TestRefreshTidalCandidatesReceivesFingerprintAndMergesResults pins the contract the lease path
// depends on: the freshness hook receives each candidate's fingerprint — the health layer uses it to
// persist a rotated credential onto the row — and its decrypted payload, and the per-candidate
// outcomes merge into exactly the maps servableForLease consumes.
func TestRefreshTidalCandidatesReceivesFingerprintAndMergesResults(t *testing.T) {
	candidates := tidalCandidateRows(7)
	seen := map[string]string{}
	var mu sync.Mutex
	hook := func(_ context.Context, fingerprint string, payload map[string]any) (map[string]any, bool) {
		mu.Lock()
		seen[fingerprint] = payload["token"].(string)
		mu.Unlock()
		switch fingerprint {
		case "fp-3":
			return nil, true
		case "fp-5":
			return map[string]any{"token": "rotated-5"}, false
		}
		return nil, false
	}

	got := refreshTidalCandidates(context.Background(), candidates, hook)

	for i := 1; i <= 7; i++ {
		fp := fmt.Sprintf("fp-%d", i)
		if want := fmt.Sprintf("tok-%d", i); seen[fp] != want {
			t.Errorf("hook saw %s with payload token %q, want %q", fp, seen[fp], want)
		}
	}
	if len(got.checked) != 7 {
		t.Errorf("checked = %v, want every candidate", got.checked)
	}
	if len(got.excluded) != 1 || !got.excluded[3] {
		t.Errorf("excluded = %v, want only 3", got.excluded)
	}
	if len(got.freshPayloads) != 1 || got.freshPayloads[5]["token"] != "rotated-5" {
		t.Errorf("freshPayloads = %v, want only 5 with the rotated token", got.freshPayloads)
	}
}

// TestRefreshTidalCandidatesRunsWorkersConcurrently keeps one full wave of workers inside the hook
// at once, with each of them producing a fresh or an excluded outcome, so `go test -race` covers the
// pass end to end: a result map written from the hook instead of merged after the join is a
// concurrent map write and fails here.
func TestRefreshTidalCandidatesRunsWorkersConcurrently(t *testing.T) {
	if leaseRefreshConcurrency < 2 {
		t.Skip("concurrency below 2 cannot exercise overlapping workers")
	}
	candidates := tidalCandidateRows(leaseRefreshConcurrency)
	ready := make(chan struct{}, leaseRefreshConcurrency)
	release := make(chan struct{})
	var calls atomic.Int64
	hook := func(_ context.Context, _ string, _ map[string]any) (map[string]any, bool) {
		n := calls.Add(1)
		ready <- struct{}{}
		<-release
		if n%2 == 0 {
			return nil, true
		}
		return map[string]any{"token": "rotated"}, false
	}
	done := make(chan tidalFreshness, 1)
	go func() { done <- refreshTidalCandidates(context.Background(), candidates, hook) }()
	for i := 0; i < leaseRefreshConcurrency; i++ {
		select {
		case <-ready:
		case <-time.After(10 * time.Second):
			t.Fatal("the freshness hook never ran with every worker in flight")
		}
	}
	close(release)
	got := <-done
	if len(got.checked) != leaseRefreshConcurrency {
		t.Fatalf("checked = %v, want every candidate", got.checked)
	}
	if len(got.excluded)+len(got.freshPayloads) != leaseRefreshConcurrency {
		t.Fatalf("merged freshness = %+v, want one outcome per candidate", got)
	}
}

// TestRefreshTidalCandidatesSkippedRowsAreNotChecked covers a request whose context ends before the
// freshness pass reaches a row: that row was never looked at, so it must stay out of `checked` and
// therefore out of the lease, instead of being served on a token nobody verified.
func TestRefreshTidalCandidatesSkippedRowsAreNotChecked(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls := 0
	hook := func(_ context.Context, _ string, _ map[string]any) (map[string]any, bool) {
		calls++
		return nil, false
	}
	got := refreshTidalCandidates(ctx, tidalCandidateRows(4), hook)
	if calls != 0 {
		t.Fatalf("hook ran %d times on a cancelled context, want 0", calls)
	}
	if len(got.checked) != 0 {
		t.Fatalf("checked = %v, want no row marked as consulted", got.checked)
	}
	ids := []int{1, 2, 3, 4}
	if served := servableForLease(ServiceTidal, ids, true, got.checked, got.excluded, 4); len(served) != 0 {
		t.Fatalf("served = %v, want none: no row went through the freshness hook", served)
	}
}
