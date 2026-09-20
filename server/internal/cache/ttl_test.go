package cache

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testCache returns a cache whose clock the test controls.
func testCache(now *time.Time) *Cache {
	c := New()
	c.now = func() time.Time { return *now }
	return c
}

func TestCachedLoadsOnceThenServesFromMemory(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := testCache(&now)
	ctx := context.Background()
	loads := 0
	load := func(context.Context) (string, error) {
		loads++
		return "value", nil
	}

	for i := 0; i < 3; i++ {
		got, err := Cached(c, ctx, "status", time.Minute, load)
		if err != nil || got != "value" {
			t.Fatalf("call %d: %q %v", i, got, err)
		}
	}
	if loads != 1 {
		t.Fatalf("expected one load for three reads, got %d", loads)
	}
}

func TestCachedReloadsAfterTheTTL(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := testCache(&now)
	ctx := context.Background()
	value := "first"
	load := func(context.Context) (string, error) { return value, nil }

	if got, _ := Cached(c, ctx, "discovery:tidal", 5*time.Minute, load); got != "first" {
		t.Fatalf("got %q", got)
	}
	now = now.Add(4 * time.Minute)
	value = "second"
	if got, _ := Cached(c, ctx, "discovery:tidal", 5*time.Minute, load); got != "first" {
		t.Fatalf("still inside the TTL, got %q", got)
	}
	now = now.Add(61 * time.Second)
	if got, _ := Cached(c, ctx, "discovery:tidal", 5*time.Minute, load); got != "second" {
		t.Fatalf("after the TTL the loader must run again, got %q", got)
	}
}

func TestConcurrentMissesShareOneLoad(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := testCache(&now)
	ctx := context.Background()

	var loads int32
	release := make(chan struct{})
	load := func(context.Context) (int, error) {
		atomic.AddInt32(&loads, 1)
		<-release // hold the load open so every caller arrives during the miss
		return 42, nil
	}

	const callers = 25
	var wg sync.WaitGroup
	wg.Add(callers)
	results := make([]int, callers)
	errs := make([]error, callers)
	for i := 0; i < callers; i++ {
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = Cached(c, ctx, "status", time.Minute, load)
		}(i)
	}
	// Give the goroutines time to pile up on the in-flight load, then let it finish.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := atomic.LoadInt32(&loads); got != 1 {
		t.Fatalf("expected a single shared load, got %d", got)
	}
	for i := range results {
		if errs[i] != nil || results[i] != 42 {
			t.Fatalf("caller %d got %d, %v", i, results[i], errs[i])
		}
	}
}

func TestErrorsAreNotCached(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := testCache(&now)
	ctx := context.Background()
	wantErr := errors.New("database unavailable")
	calls := 0
	load := func(context.Context) (string, error) {
		calls++
		if calls == 1 {
			return "", wantErr
		}
		return "recovered", nil
	}

	if _, err := Cached(c, ctx, "status", time.Minute, load); !errors.Is(err, wantErr) {
		t.Fatalf("expected the load error to propagate, got %v", err)
	}
	got, err := Cached(c, ctx, "status", time.Minute, load)
	if err != nil || got != "recovered" {
		t.Fatalf("a failed load must not be cached: %q %v", got, err)
	}
	// The in-flight entry must have been released, otherwise the second call would hang or reuse the
	// failed result.
	if calls != 2 {
		t.Fatalf("expected two loads, got %d", calls)
	}
}

func TestInvalidateDropsMatchingPrefixesOnly(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := testCache(&now)
	ctx := context.Background()
	loads := map[string]int{}
	load := func(key string) func(context.Context) (string, error) {
		return func(context.Context) (string, error) {
			loads[key]++
			return key, nil
		}
	}

	for _, key := range []string{"snapshot:tidal", "snapshot:qobuz", "discovery:tidal", "status"} {
		if _, err := Cached(c, ctx, key, time.Minute, load(key)); err != nil {
			t.Fatalf("warm %s: %v", key, err)
		}
	}

	c.Invalidate("snapshot:")
	for _, key := range []string{"snapshot:tidal", "snapshot:qobuz"} {
		if _, err := Cached(c, ctx, key, time.Minute, load(key)); err != nil {
			t.Fatal(err)
		}
		if loads[key] != 2 {
			t.Fatalf("%s should have been invalidated (loads=%d)", key, loads[key])
		}
	}
	for _, key := range []string{"discovery:tidal", "status"} {
		if _, err := Cached(c, ctx, key, time.Minute, load(key)); err != nil {
			t.Fatal(err)
		}
		if loads[key] != 1 {
			t.Fatalf("%s must survive an unrelated invalidation (loads=%d)", key, loads[key])
		}
	}
}

func TestCacheIsolatesKeys(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := testCache(&now)
	ctx := context.Background()

	tidal, _ := Cached(c, ctx, "discovery:tidal", time.Minute, func(context.Context) (string, error) { return "tidal-urls", nil })
	qobuz, _ := Cached(c, ctx, "discovery:qobuz", time.Minute, func(context.Context) (string, error) { return "qobuz-urls", nil })
	if tidal != "tidal-urls" || qobuz != "qobuz-urls" {
		t.Fatalf("keys must not alias: %q %q", tidal, qobuz)
	}
}

func TestTTLConstantsMatchTheTypeScript(t *testing.T) {
	if DiscoveryTTL != 5*time.Minute {
		t.Fatalf("DISCOVERY_TTL_MS must be 5 minutes, got %s", DiscoveryTTL)
	}
	if StatusTTL != 5*time.Minute {
		t.Fatalf("STATUS_TTL_MS must be 5 minutes, got %s", StatusTTL)
	}
}
