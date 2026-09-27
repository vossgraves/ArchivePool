// Package cache is the process-local read-through TTL cache from lib/ttl-cache.ts.
//
// It exists for the same reason there: every poll from an app client costs a database query, and on
// a scale-to-zero Postgres the compute stays awake for minutes after the last query. Collapsing a
// burst of polls into one query is what lets the compute sleep. Deliberately NOT used for leasing
// (leaseAccounts/leaseInstances write last_leased_at on every call, so caching them would silently
// stop the pool rotating).
package cache

import (
	"context"
	"errors"
	"sync"
	"time"
)

// errLoadPanicked is what callers sharing a flight receive when its load panicked: without it
// they would read the flight's zero value, which Cached reports as a successful empty result.
var errLoadPanicked = errors.New("cache: load panicked")

// DISCOVERY_TTL_MS and STATUS_TTL_MS from lib/ttl-cache.ts: sweeps run hours apart, so minutes of
// staleness are free.
const (
	DiscoveryTTL = 5 * time.Minute
	StatusTTL    = 5 * time.Minute
)

type entry struct {
	value     any
	expiresAt time.Time
}

// flight is an in-progress load shared by every concurrent caller: without it, ten clients arriving
// together would still run ten queries, which is the burst this exists to absorb.
type flight struct {
	done  chan struct{}
	value any
	err   error
}

// Cache is a keyed TTL store. The zero value is not usable; use New or the package-level helpers.
type Cache struct {
	mu       sync.Mutex
	store    map[string]entry
	inflight map[string]*flight
	now      func() time.Time
}

// New returns an empty cache.
func New() *Cache {
	return &Cache{store: map[string]entry{}, inflight: map[string]*flight{}, now: time.Now}
}

// StartEviction begins background cleanup of expired entries.
func (c *Cache) StartEviction(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			c.evictExpired()
		}
	}()
}

func (c *Cache) evictExpired() {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, v := range c.store {
		if v.expiresAt.Before(now) {
			delete(c.store, k)
		}
	}
}

// Default is the process-wide cache the routes share (the TS keeps module-scope state).
var Default = New()

func init() {
	// Start eviction on the default cache (runs every 5 minutes)
	Default.StartEviction(5 * time.Minute)
}

// Cached reads through the cache under key, loading on a miss or an expired entry.
func Cached[T any](c *Cache, ctx context.Context, key string, ttl time.Duration, load func(context.Context) (T, error)) (T, error) {
	if c == nil {
		c = Default
	}
	var zero T
	value, err := c.load(ctx, key, ttl, func(ctx context.Context) (any, error) {
		return load(ctx)
	})
	if err != nil {
		return zero, err
	}
	typed, ok := value.(T)
	if !ok {
		return zero, nil
	}
	return typed, nil
}

func (c *Cache) load(ctx context.Context, key string, ttl time.Duration, load func(context.Context) (any, error)) (any, error) {
	c.mu.Lock()
	if hit, ok := c.store[key]; ok && hit.expiresAt.After(c.now()) {
		c.mu.Unlock()
		return hit.value, nil
	}
	if f, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		select {
		case <-f.done:
			return f.value, f.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	c.inflight[key] = f
	c.mu.Unlock()

	// Cleanup runs even if load panics, so waiters are released instead of blocking forever, and
	// they are released with an error; the panic itself continues in this caller.
	completed := false
	defer func() {
		c.mu.Lock()
		if !completed {
			f.err = errLoadPanicked
		}
		delete(c.inflight, key)
		close(f.done)
		c.mu.Unlock()
	}()

	value, err := load(ctx)

	c.mu.Lock()
	if err == nil {
		c.store[key] = entry{value: value, expiresAt: c.now().Add(ttl)}
	}
	f.value, f.err = value, err
	completed = true
	c.mu.Unlock()
	return value, err
}

// Invalidate drops every entry whose key starts with prefix — used after a sweep so its results
// show at once rather than waiting out the TTL.
func (c *Cache) Invalidate(prefix string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.store {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			delete(c.store, key)
		}
	}
}

// Invalidate drops matching entries from the process-wide cache.
func Invalidate(prefix string) { Default.Invalidate(prefix) }
