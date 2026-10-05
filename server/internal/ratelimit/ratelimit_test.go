// SPDX-License-Identifier: GPL-3.0-or-later
package ratelimit

import (
	"net/http"
	"testing"
	"time"
)

// newTestLimiter returns a limiter whose clock the test controls, so window behaviour is asserted
// without sleeping.
func newTestLimiter(now *time.Time) *Limiter {
	l := New()
	l.now = func() time.Time { return *now }
	return l
}

func TestSlidingWindowAllowsUpToTheLimit(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newTestLimiter(&now)

	for i := 1; i <= 3; i++ {
		verdict := l.RateLimit("feed-key:abc", 3, time.Minute)
		if !verdict.OK {
			t.Fatalf("hit %d should be allowed under a limit of 3", i)
		}
		if verdict.Remaining != 3-i {
			t.Fatalf("hit %d: remaining = %d, want %d", i, verdict.Remaining, 3-i)
		}
	}

	blocked := l.RateLimit("feed-key:abc", 3, time.Minute)
	if blocked.OK {
		t.Fatal("the fourth hit must be refused")
	}
	if blocked.Remaining != 0 {
		t.Fatalf("remaining = %d, want 0", blocked.Remaining)
	}
	// The hint is seconds until the oldest hit leaves the window: 60s minus the (zero) elapsed time.
	if blocked.RetryAfterSec != 60 {
		t.Fatalf("retryAfterSec = %d, want 60", blocked.RetryAfterSec)
	}
}

func TestRetryAfterShrinksAsTheWindowSlides(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newTestLimiter(&now)

	for i := 0; i < 2; i++ {
		l.RateLimit("k", 2, 60*time.Second)
	}
	now = now.Add(45 * time.Second)
	blocked := l.RateLimit("k", 2, 60*time.Second)
	if blocked.OK {
		t.Fatal("still inside the window: must be refused")
	}
	if blocked.RetryAfterSec != 15 {
		t.Fatalf("retryAfterSec = %d, want 15", blocked.RetryAfterSec)
	}
}

func TestWindowExpiryFreesTheBucket(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newTestLimiter(&now)

	for i := 0; i < 2; i++ {
		l.RateLimit("k", 2, 60*time.Second)
	}
	if l.RateLimit("k", 2, 60*time.Second).OK {
		t.Fatal("expected the third hit to be refused")
	}
	now = now.Add(60 * time.Second) // exactly the window: every hit is outside it
	if verdict := l.RateLimit("k", 2, 60*time.Second); !verdict.OK {
		t.Fatal("a hit after the window must be allowed again")
	}
}

func TestBucketsAreIndependent(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newTestLimiter(&now)

	l.RateLimit("report-ip:1.2.3.4", 1, time.Minute)
	if l.RateLimit("report-ip:1.2.3.4", 1, time.Minute).OK {
		t.Fatal("same bucket must be limited")
	}
	if !l.RateLimit("report-ip:5.6.7.8", 1, time.Minute).OK {
		t.Fatal("a different id must have its own window")
	}
	if !l.RateLimit("report-key:deadbeef", 1, time.Minute).OK {
		t.Fatal("a different scope must have its own window")
	}
}

func TestBucketMapIsCapped(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	l := newTestLimiter(&now)

	// Fill past the cap with ids that expire immediately, so eviction must reclaim them.
	for i := 0; i < maxBuckets+50; i++ {
		l.RateLimit("flood:"+itoa(i), 5, time.Millisecond)
	}
	now = now.Add(time.Second)
	l.RateLimit("newcomer", 5, time.Minute)

	if size := len(l.SortedKeys()); size > maxBuckets {
		t.Fatalf("bucket map grew to %d, above the %d cap", size, maxBuckets)
	}
}

func TestKeyIDIsStableAndShort(t *testing.T) {
	id := KeyID("atp_0123456789abcdef")
	if len(id) != 16 {
		t.Fatalf("keyId must be 16 hex chars, got %q", id)
	}
	if id != KeyID("atp_0123456789abcdef") {
		t.Fatal("keyId must be deterministic")
	}
	if id == KeyID("atp_0123456789abcdee") {
		t.Fatal("keyId must change with the key")
	}
}

func TestClientIPMatchesProxyHeaderSemantics(t *testing.T) {
	cases := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{"forwarded list takes the first entry", map[string]string{"x-forwarded-for": "1.2.3.4, 5.6.7.8"}, "1.2.3.4"},
		{"x-real-ip fallback", map[string]string{"x-real-ip": "9.9.9.9"}, "9.9.9.9"},
		{"neither header", map[string]string{}, "unknown"},
		{"forwarded wins over real-ip", map[string]string{"x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2"}, "1.1.1.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			header := http.Header{}
			for k, v := range tc.headers {
				header.Set(k, v)
			}
			if got := ClientIP(header); got != tc.want {
				t.Fatalf("ClientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClientIPIsTruncatedTo64Chars(t *testing.T) {
	header := http.Header{}
	header.Set("x-forwarded-for", string(make([]byte, 0))+"1.2.3.4"+string(make([]byte, 0)))
	if got := ClientIP(header); len(got) > 64 {
		t.Fatalf("client ip must be truncated to 64 chars, got %d", len(got))
	}
	long := ""
	for i := 0; i < 200; i++ {
		long += "a"
	}
	header.Set("x-forwarded-for", long)
	if got := ClientIP(header); len(got) != 64 {
		t.Fatalf("expected 64 chars, got %d", len(got))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
