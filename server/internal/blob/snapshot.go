// SPDX-License-Identifier: GPL-3.0-or-later
// Package blob publishes the pool's servable instance URLs to Vercel Blob and reads them back, so
// the discovery routes can answer without waking the database compute (lib/edge-snapshot.ts).
//
// The Blob API is reached over plain HTTPS with the standard library. BLOB_READ_WRITE_TOKEN is
// optional: with no token the store is a no-op, every read returns "absent", and the routes fall
// back to their cached database read — exactly the TS behaviour.
package blob

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"archivepool/server/internal/db"
	"archivepool/server/internal/pool"
)

// SnapshotPathname is one stable pathname, rewritten in place each sweep, so a reader needs no
// lookup table.
const SnapshotPathname = "pool/instances.json"

// SnapshotTTL is twice the 12-hour instance-sync cadence: that lets one missed sweep fall back to
// the database instead of pinning every route to a day-old feed.
const SnapshotTTL = 24 * time.Hour

const blobEndpoint = "https://blob.vercel-storage.com/"

// Snapshot maps each service to its discovery payload.
type Snapshot map[string]pool.Discovery

// Store is the Blob interface. A nil Store, or one built without a token, is a no-op.
type Store interface {
	// Write publishes the snapshot.
	Write(ctx context.Context, snapshot Snapshot) error
	// Read returns the stored snapshot, or nil when it is absent or older than SnapshotTTL.
	Read(ctx context.Context) (Snapshot, bool)
	// Enabled reports whether this store actually talks to Blob.
	Enabled() bool
}

// NewFromEnv returns the HTTP store when BLOB_READ_WRITE_TOKEN is set, else the no-op store.
func NewFromEnv() Store {
	token := strings.TrimSpace(os.Getenv("BLOB_READ_WRITE_TOKEN"))
	if token == "" {
		return NoopStore{}
	}
	return &httpStore{
		token:      token,
		publicBase: publicBaseFromToken(token),
		client:     &http.Client{Timeout: 20 * time.Second},
	}
}

// publicBaseFromToken derives the store's read host.
//
// Writes go to the upload endpoint (blob.vercel-storage.com) but a public read does NOT: it is served
// from <storeId>.public.blob.vercel-storage.com, and a GET against the upload endpoint answers 404
// even for a pathname that exists. The store id is the fourth underscore-delimited field of the
// read-write token (`vercel_blob_rw_<storeId>_<secret>`), which is how the token is documented and how
// the SDK resolves a public URL.
func publicBaseFromToken(token string) string {
	storeID := storeIDFromToken(token)
	if storeID == "" {
		return ""
	}
	return "https://" + storeID + ".public.blob.vercel-storage.com/"
}

func storeIDFromToken(token string) string {
	parts := strings.Split(token, "_")
	if len(parts) < 5 || parts[0] != "vercel" || parts[1] != "blob" || parts[2] != "rw" || parts[3] == "" {
		return ""
	}
	return strings.ToLower(parts[3])
}

// NoopStore is the unconfigured fallback: writes are dropped and reads report "absent".
type NoopStore struct{}

func (NoopStore) Write(context.Context, Snapshot) error { return nil }
func (NoopStore) Read(context.Context) (Snapshot, bool) { return nil, false }
func (NoopStore) Enabled() bool                         { return false }

type httpStore struct {
	token      string
	publicBase string
	client     *http.Client
}

func (s *httpStore) Enabled() bool { return true }

func (s *httpStore) Write(ctx context.Context, snapshot Snapshot) error {
	body, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, blobEndpoint+SnapshotPathname, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+s.token)
	req.Header.Set("x-api-version", "7")
	req.Header.Set("x-content-type", "application/json")
	req.Header.Set("x-add-random-suffix", "0")
	req.Header.Set("x-allow-overwrite", "1")
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return &statusError{status: res.StatusCode}
	}
	return nil
}

func (s *httpStore) Read(ctx context.Context) (Snapshot, bool) {
	if s.publicBase == "" {
		// A token whose shape we do not recognise cannot be turned into a read URL; collapsing to
		// "absent" keeps the routes on their database fallback.
		return nil, false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.publicBase+SnapshotPathname, nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("x-api-version", "7")
	// useCache:false — the pathname is overwritten in place, so a CDN-cached copy could otherwise
	// serve a superseded sweep.
	req.Header.Set("cache-control", "no-cache")
	res, err := s.client.Do(req)
	if err != nil {
		return nil, false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, false
	}
	// The store's freshness signal is the upload time; an absent or unparseable header is treated as
	// stale, which collapses to the database fallback.
	if modified := res.Header.Get("last-modified"); modified != "" {
		if uploadedAt, err := http.ParseTime(modified); err == nil {
			if time.Since(uploadedAt) > SnapshotTTL {
				return nil, false
			}
		}
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, false
	}
	var parsed Snapshot
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, false
	}
	return parsed, true
}

type statusError struct{ status int }

func (e *statusError) Error() string { return "blob: HTTP " + itoa(e.status) }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// WriteInstanceSnapshot publishes every service's servable instance URLs. Nothing here propagates: a
// Blob outage must not fail a sweep whose database work already succeeded, and the routes treat an
// absent snapshot as "read Postgres" anyway.
func WriteInstanceSnapshot(ctx context.Context, database *db.DB, store Store) {
	if store == nil || !store.Enabled() {
		return
	}
	snapshot := Snapshot{}
	for _, service := range pool.Services {
		discovery, err := pool.GetDiscovery(ctx, database, service)
		if err != nil {
			logf("[pool] failed to read discovery for snapshot: %v", err)
			return
		}
		snapshot[string(service)] = discovery
	}
	if err := store.Write(ctx, snapshot); err != nil {
		logf("[pool] failed to write instance snapshot: %v", err)
	}
}

// ReadInstanceSnapshot returns the snapshot for one service, or nil when Blob is unconfigured, the
// copy is missing or stale, or the entry is malformed. Every failure collapses to the same nil
// because the caller's fallback — the cached database feed — is identical in each case.
func ReadInstanceSnapshot(ctx context.Context, store Store, service pool.Service) *pool.Discovery {
	if store == nil || !store.Enabled() {
		return nil
	}
	snapshot, ok := store.Read(ctx)
	if !ok {
		return nil
	}
	entry, ok := snapshot[string(service)]
	if !ok || entry.Streaming == nil || entry.API == nil {
		return nil
	}
	return &entry
}

// CacheControl is the Cache-Control a snapshot answer carries, resolved once per deployment.
//
// Public caching is only honest while the feed is public. With READ_KEYS_ENFORCED the answer is
// per-key and must stay private: the snapshot still saves the database read, it just cannot also
// save the function invocation.
func CacheControl() string {
	if os.Getenv("READ_KEYS_ENFORCED") == "true" {
		return "private, no-store"
	}
	return "public, s-maxage=300, stale-while-revalidate=3600"
}

// logf keeps a Blob failure one-line and non-fatal: an absent snapshot is a normal state the routes
// already handle.
func logf(format string, args ...any) { log.Printf(format, args...) }
