// SPDX-License-Identifier: GPL-3.0-or-later
package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"archivepool/server/internal/auth"
	"archivepool/server/internal/blob"
	"archivepool/server/internal/cache"
	"archivepool/server/internal/crypto"
	"archivepool/server/internal/db"
	"archivepool/server/internal/pool"
)

// Rate-limit posture for the credential feeds (lib/queries.ts callers in app/api/{sources,accounts}):
// per IP before auth bounds key guessing, per key after auth bounds pool-walking via lease rotation.
const (
	feedIPLimit     = 120
	feedIPWindowMs  = 60_000
	feedKeyLimit    = 30
	feedKeyWindowMs = 5 * 60_000

	// The instance/discovery feeds carry only URLs, so their bind is looser.
	discoveryIPLimit    = 60
	discoveryIPWindowMs = 60_000
)

type serviceAccountGroup struct {
	Accounts []pool.LeasedEntry `json:"accounts"`
}

// accountsResponse is /api/accounts: the token half of the split pool.
type accountsResponse struct {
	Version     string              `json:"version"`
	GeneratedAt string              `json:"generatedAt"`
	Encrypted   bool                `json:"encrypted"`
	Encryption  string              `json:"encryption"`
	Tidal       serviceAccountGroup `json:"tidal"`
	Qobuz       serviceAccountGroup `json:"qobuz"`
	Deezer      serviceAccountGroup `json:"deezer"`
	AppleMusic  serviceAccountGroup `json:"apple-music"`
	AmazonMusic serviceAccountGroup `json:"amazon-music"`
}

type servicePoolGroup struct {
	Apis     []pool.LeasedEntry `json:"apis"`
	Accounts []pool.LeasedEntry `json:"accounts"`
}

// sourcesResponse is the LEGACY combined feed: both halves per service, byte-compatible for app
// builds predating the split.
type sourcesResponse struct {
	Version       string           `json:"version"`
	GeneratedAt   string           `json:"generatedAt"`
	Encrypted     bool             `json:"encrypted"`
	Encryption    string           `json:"encryption"`
	AccountsFeed  string           `json:"accountsFeed"`
	InstancesFeed string           `json:"instancesFeed"`
	Tidal         servicePoolGroup `json:"tidal"`
	Qobuz         servicePoolGroup `json:"qobuz"`
	Deezer        servicePoolGroup `json:"deezer"`
	AppleMusic    servicePoolGroup `json:"apple-music"`
	AmazonMusic   servicePoolGroup `json:"amazon-music"`
}

type discoveryResponse struct {
	Streaming []string `json:"streaming"`
	API       []string `json:"api"`
	Error     string   `json:"error,omitempty"`
}

type statusHistory struct {
	Days       int                   `json:"days"`
	Overall    []pool.UptimePoint    `json:"overall"`
	Categories []pool.CategoryPoints `json:"categories"`
}

type statusResponse struct {
	GeneratedAt string                `json:"generatedAt"`
	Categories  []pool.CategoryStatus `json:"categories"`
	History     statusHistory         `json:"history"`
}

const unauthorizedDetail = "A valid API key is required to read the source pool. Create an account and request one on the site."

// handleAccounts serves /api/accounts: account credentials only, never instance URLs.
func (s *Server) handleAccounts(w http.ResponseWriter, r *http.Request) {
	if verdict := s.rateLimit("feed-ip:"+clientIP(r), feedIPLimit, feedIPWindowMs); !verdict.OK {
		tooManyRequests(w, verdict.RetryAfterSec, "feed")
		return
	}

	v2 := isV2Client(r)
	if !v2 && !crypto.ClientEncryptionEnabled() {
		// Account credentials must never fall back to a plaintext response when client encryption is
		// off — for legacy clients. v2 clients always get derived-key ciphertext.
		writeJSON(w, http.StatusServiceUnavailable, errJSON("security_not_configured", "Credential delivery is unavailable."),
			map[string]string{"cache-control": "private, no-store"})
		return
	}

	identity, err := auth.IdentifyReadKey(r.Context(), s.DB, r, true)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if !identity.OK {
		writeJSON(w, http.StatusUnauthorized, errJSON("unauthorized", unauthorizedDetail),
			map[string]string{"cache-control": "private, no-store"})
		return
	}

	readKey, _ := auth.ReadKeyFromRequest(r)
	if readKey != "" {
		if verdict := s.rateLimit("feed-key:"+keyID(readKey), feedKeyLimit, feedKeyWindowMs); !verdict.OK {
			tooManyRequests(w, verdict.RetryAfterSec, "feed")
			return
		}
	}

	var clientKey []byte
	if v2 && readKey != "" {
		clientKey = crypto.DeriveClientKey(readKey)
	}
	result, err := pool.LeaseAccounts(r.Context(), s.DB, clientKey, identity.KeyID, identity.Scope)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	groups := result.Groups

	encryption := "client-key"
	if v2 {
		encryption = "read-key"
	}
	writeJSON(w, http.StatusOK, accountsResponse{
		Version:     "2",
		GeneratedAt: nowISO(),
		Encrypted:   true,
		Encryption:  encryption,
		Tidal:       serviceAccountGroup{groups.Tidal},
		Qobuz:       serviceAccountGroup{groups.Qobuz},
		Deezer:      serviceAccountGroup{groups.Deezer},
		AppleMusic:  serviceAccountGroup{groups.AppleMusic},
		AmazonMusic: serviceAccountGroup{groups.AmazonMusic},
	}, map[string]string{
		"cache-control":               "private, no-store",
		"access-control-allow-origin": "*",
	})
}

// handleSources serves the legacy combined pool feed.
func (s *Server) handleSources(w http.ResponseWriter, r *http.Request) {
	if verdict := s.rateLimit("feed-ip:"+clientIP(r), feedIPLimit, feedIPWindowMs); !verdict.OK {
		tooManyRequests(w, verdict.RetryAfterSec, "feed")
		return
	}

	v2 := isV2Client(r)
	if !v2 && !crypto.ClientEncryptionEnabled() {
		writeJSON(w, http.StatusServiceUnavailable, errJSON("security_not_configured", "Credential delivery is unavailable."),
			map[string]string{"cache-control": "private, no-store"})
		return
	}

	identity, err := auth.IdentifyReadKey(r.Context(), s.DB, r, true)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	if !identity.OK {
		writeJSON(w, http.StatusUnauthorized, errJSON("unauthorized", unauthorizedDetail),
			map[string]string{"cache-control": "private, no-store"})
		return
	}

	readKey, _ := auth.ReadKeyFromRequest(r)
	if readKey != "" {
		if verdict := s.rateLimit("feed-key:"+keyID(readKey), feedKeyLimit, feedKeyWindowMs); !verdict.OK {
			tooManyRequests(w, verdict.RetryAfterSec, "feed")
			return
		}
	}

	var clientKey []byte
	if v2 && readKey != "" {
		clientKey = crypto.DeriveClientKey(readKey)
	}

	accounts, err := pool.LeaseAccounts(r.Context(), s.DB, clientKey, identity.KeyID, identity.Scope)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	apis, err := pool.LeaseInstances(r.Context(), s.DB, clientKey, identity.Scope)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}

	encryption := "client-key"
	if v2 {
		encryption = "read-key"
	}
	bucket := func(service pool.Service) servicePoolGroup {
		return servicePoolGroup{Apis: apis.Groups.For(service), Accounts: accounts.Groups.For(service)}
	}
	writeJSON(w, http.StatusOK, sourcesResponse{
		Version:       "1",
		GeneratedAt:   nowISO(),
		Encrypted:     true,
		Encryption:    encryption,
		AccountsFeed:  "/api/accounts",
		InstancesFeed: "/api/instances/{service}",
		Tidal:         bucket(pool.ServiceTidal),
		Qobuz:         bucket(pool.ServiceQobuz),
		Deezer:        bucket(pool.ServiceDeezer),
		AppleMusic:    bucket(pool.ServiceAppleMusic),
		AmazonMusic:   bucket(pool.ServiceAmazonMusic),
	}, map[string]string{
		"cache-control":               "private, no-store",
		"access-control-allow-origin": "*",
	})
}

// handleInstances serves the URL half of the split pool for one service.
func (s *Server) handleInstances(w http.ResponseWriter, r *http.Request) {
	service := pool.Service(pathParam(r, "service"))
	if !pool.IsService(string(service)) {
		writeJSON(w, http.StatusNotFound, discoveryResponse{
			Streaming: []string{}, API: []string{}, Error: "unknown service",
		}, nil)
		return
	}
	s.serveDiscovery(w, r, service)
}

func (s *Server) handleDiscoveryTidal(w http.ResponseWriter, r *http.Request) {
	s.serveDiscovery(w, r, pool.ServiceTidal)
}

func (s *Server) handleDiscoveryQobuz(w http.ResponseWriter, r *http.Request) {
	s.serveDiscovery(w, r, pool.ServiceQobuz)
}

// serveDiscovery is the shared body of /api/instances/{service} and the two legacy discovery
// aliases: snapshot first (public URLs, zero database cost), then the cached database read.
func (s *Server) serveDiscovery(w http.ResponseWriter, r *http.Request, service pool.Service) {
	if verdict := s.rateLimit("feed-ip:"+clientIP(r), discoveryIPLimit, discoveryIPWindowMs); !verdict.OK {
		writeJSON(w, http.StatusTooManyRequests, discoveryResponse{Streaming: []string{}, API: []string{}},
			map[string]string{"retry-after": itoa(verdict.RetryAfterSec)})
		return
	}

	identity, err := auth.IdentifyReadKey(r.Context(), s.DB, r, false)
	if err != nil {
		writeEmpty(w, http.StatusInternalServerError)
		return
	}
	// An empty scope is "every service"; an anonymous caller (valid key absent, unenforced) is the
	// same. A key scoped elsewhere is refused.
	if !identity.OK || (identity.Scope != "" && identity.Scope != service) {
		writeJSON(w, http.StatusUnauthorized, discoveryResponse{Streaming: []string{}, API: []string{}}, nil)
		return
	}

	ctx := r.Context()
	snapshot, err := cache.Cached(s.Cache, ctx, "snapshot:"+string(service), cache.DiscoveryTTL, func(ctx context.Context) (*pool.Discovery, error) {
		return blob.ReadInstanceSnapshot(ctx, s.Blob, service), nil
	})
	if err != nil {
		writeJSON(w, http.StatusOK, discoveryResponse{Streaming: []string{}, API: []string{}}, nil)
		return
	}
	if snapshot != nil {
		writeJSON(w, http.StatusOK, discoveryResponse{Streaming: snapshot.Streaming, API: snapshot.API},
			map[string]string{"cache-control": blob.CacheControl()})
		return
	}

	data, err := cache.Cached(s.Cache, ctx, "discovery:"+string(service), cache.DiscoveryTTL, func(ctx context.Context) (pool.Discovery, error) {
		return pool.GetDiscovery(ctx, s.DB, service)
	})
	if err != nil {
		writeJSON(w, http.StatusOK, discoveryResponse{Streaming: []string{}, API: []string{}}, nil)
		return
	}
	writeJSON(w, http.StatusOK, discoveryResponse{Streaming: data.Streaming, API: data.API},
		map[string]string{"cache-control": "private, no-store"})
}

// handleStatus is the public, always-open aggregate feed.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	categories, err := cache.Cached(s.Cache, ctx, "status", cache.StatusTTL, func(ctx context.Context) ([]pool.CategoryStatus, error) {
		return pool.GetStatus(ctx, s.DB)
	})
	if err != nil {
		// getStatus() is the one call that cannot be degraded around: without it there are no figures
		// at all. The message is a connection error, never a credential, so returning it turns a blank
		// board into a diagnosis.
		writeJSON(w, http.StatusServiceUnavailable, errJSON("database_unavailable", db.ErrorMessage(err)),
			map[string]string{
				"cache-control":               "no-store",
				"access-control-allow-origin": "*",
			})
		return
	}

	// History is additive and non-fatal: the board's figures matter more than its trend line, so a
	// slow aggregate must not take the whole feed down with it.
	history := pool.PoolHistory{}
	if history, err = pool.GetPoolHistory(ctx, s.DB); err != nil {
		history = pool.PoolHistory{Overall: []pool.UptimePoint{}, Categories: []pool.CategoryPoints{}}
	}

	writeJSON(w, http.StatusOK, statusResponse{
		GeneratedAt: nowISO(),
		Categories:  categories,
		History: statusHistory{
			Days:       pool.HISTORY_DAYS,
			Overall:    history.Overall,
			Categories: history.Categories,
		},
	}, map[string]string{
		// Five minutes at the edge, an hour of stale-while-revalidate behind it.
		"cache-control":               "public, s-maxage=300, stale-while-revalidate=3600",
		"access-control-allow-origin": "*",
	})
}

// isV2Client detects the one-secret client (`X-Pool-Client: v2`).
func isV2Client(r *http.Request) bool {
	return strings.ToLower(strings.TrimSpace(r.Header.Get("x-pool-client"))) == "v2"
}

// nowISO is `new Date().toISOString()`.
func nowISO() string { return isoTime(time.Now()) }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	negative := n < 0
	if negative {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if negative {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// isoTime mirrors Date#toISOString (millisecond precision, UTC, three fractional digits).
func isoTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
