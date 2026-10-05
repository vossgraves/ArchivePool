// SPDX-License-Identifier: GPL-3.0-or-later
// Package ratelimit is lib/rate-limit.ts: an in-memory sliding-window limiter, the per-key
// fingerprint helper and the client-IP extraction the routes key their buckets on.
//
// Windows are pruned lazily on access and the map is capped so a flood of distinct keys cannot grow
// memory without bound (oldest buckets are evicted first), exactly as the TS does.
package ratelimit

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxBuckets = 10000

// Verdict is the limiter's answer. Idempotent callers should only act on OK.
type Verdict struct {
	OK            bool
	RetryAfterSec int
	Remaining     int
}

type bucket struct {
	hits []int64 // unix milliseconds
	seq  uint64
}

// Limiter is a set of sliding windows.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	seq     uint64
	now     func() time.Time
}

// New returns an empty limiter.
func New() *Limiter {
	return &Limiter{buckets: map[string]*bucket{}, now: time.Now}
}

// Default is the process-wide limiter the handlers share.
var Default = New()

// RateLimit records one hit against id and reports whether it is allowed under limit requests per
// window.
func RateLimit(id string, limit int, window time.Duration) Verdict {
	return Default.RateLimit(id, limit, window)
}

func (l *Limiter) RateLimit(id string, limit int, window time.Duration) Verdict {
	now := l.now().UnixMilli()
	windowMs := window.Milliseconds()

	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[id]
	if !ok {
		b = &bucket{}
	}
	// Prune hits outside the window.
	kept := b.hits[:0]
	for _, t := range b.hits {
		if now-t < windowMs {
			kept = append(kept, t)
		}
	}
	b.hits = kept

	if len(b.hits) >= limit {
		oldest := b.hits[0]
		retry := int(math.Ceil(float64(windowMs-(now-oldest)) / 1000))
		if retry < 1 {
			retry = 1
		}
		l.buckets[id] = b
		return Verdict{OK: false, RetryAfterSec: retry, Remaining: 0}
	}

	b.hits = append(b.hits, now)
	if b.seq == 0 {
		l.seq++
		b.seq = l.seq
	}
	l.buckets[id] = b

	if len(l.buckets) > maxBuckets {
		for key, other := range l.buckets {
			if len(other.hits) == 0 || now-other.hits[len(other.hits)-1] >= windowMs {
				delete(l.buckets, key)
			}
		}
		for len(l.buckets) > maxBuckets {
			var oldestKey string
			var oldestSeq uint64 = math.MaxUint64
			for key, other := range l.buckets {
				if other.seq < oldestSeq {
					oldestSeq = other.seq
					oldestKey = key
				}
			}
			if oldestSeq == math.MaxUint64 {
				break
			}
			delete(l.buckets, oldestKey)
		}
	}

	return Verdict{OK: true, RetryAfterSec: 0, Remaining: limit - len(b.hits)}
}

// KeyID is a stable, non-reversible id for a presented read key (its sha256 hex, first 16 chars).
func KeyID(readKey string) string {
	sum := sha256.Sum256([]byte(readKey))
	return hex.EncodeToString(sum[:])[:16]
}

// ClientIP is the best-effort client address from the proxy headers Vercel sets; "unknown" when
// both are absent, truncated to 64 chars as the TS does.
func ClientIP(h http.Header) string {
	fwd := ""
	if raw := h.Get("x-forwarded-for"); raw != "" {
		fwd = strings.TrimSpace(strings.Split(raw, ",")[0])
	}
	ip := fwd
	if ip == "" {
		ip = h.Get("x-real-ip")
	}
	if ip == "" {
		ip = "unknown"
	}
	return truncate(ip, 64)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// SortedKeys is a test helper: it exposes bucket ids deterministically.
func (l *Limiter) SortedKeys() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	keys := make([]string, 0, len(l.buckets))
	for k := range l.buckets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
