// Package pool is the domain layer for the credential/instance pool: the service vocabulary,
// fingerprinting, the servable predicates, the lease queries and the dashboard reads.
// It mirrors lib/sources.ts, lib/queries.ts and the pool half of lib/health-sweep.ts.
package pool

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strconv"
	"strings"
)

// Service is one of the five pooled services (lib/sources.ts Service).
type Service string

// Kind distinguishes instance URLs from account credentials.
type Kind string

const (
	ServiceTidal       Service = "tidal"
	ServiceQobuz       Service = "qobuz"
	ServiceDeezer      Service = "deezer"
	ServiceAppleMusic  Service = "apple-music"
	ServiceAmazonMusic Service = "amazon-music"

	KindAPI     Kind = "api"
	KindAccount Kind = "account"
)

// Services is the canonical order; the discovery snapshot is keyed by it.
var Services = []Service{ServiceTidal, ServiceQobuz, ServiceDeezer, ServiceAppleMusic, ServiceAmazonMusic}

// ServiceLabels and KindLabels are the public display names.
var ServiceLabels = map[Service]string{
	ServiceTidal:       "Tidal",
	ServiceQobuz:       "Qobuz",
	ServiceDeezer:      "Deezer",
	ServiceAppleMusic:  "Apple Music",
	ServiceAmazonMusic: "Amazon Music",
}

var KindLabels = map[Kind]string{
	KindAPI:     "API / Instance",
	KindAccount: "Account",
}

// Category is one public status category.
type Category struct {
	Service Service
	Kind    Kind
	Label   string
}

// Categories are the four-plus public status categories. Deezer, Apple Music and Amazon Music are
// account-only: there is no self-hosted instance tier to pool beside them.
var Categories = []Category{
	{ServiceTidal, KindAPI, "Tidal API"},
	{ServiceTidal, KindAccount, "Tidal Account"},
	{ServiceQobuz, KindAPI, "Qobuz API"},
	{ServiceQobuz, KindAccount, "Qobuz Account"},
	{ServiceDeezer, KindAccount, "Deezer Account"},
	{ServiceAppleMusic, KindAccount, "Apple Music Account"},
	{ServiceAmazonMusic, KindAccount, "Amazon Music Account"},
}

// Status is an entry's health verdict.
type Status string

// The four statuses the pool persists.
const (
	StatusPending Status = "pending"
	StatusAlive   Status = "alive"
	StatusPreview Status = "preview"
	StatusDead    Status = "dead"
)

// IsService reports whether v is one of the five known services.
func IsService(v string) bool {
	switch Service(v) {
	case ServiceTidal, ServiceQobuz, ServiceDeezer, ServiceAppleMusic, ServiceAmazonMusic:
		return true
	}
	return false
}

// IsKind reports whether v is "api" or "account".
func IsKind(v string) bool { return v == string(KindAPI) || v == string(KindAccount) }

// NormalizeURL is lib/sources.ts normalizeUrl: trim, strip trailing slashes, lowercase.
func NormalizeURL(raw string) string {
	return strings.ToLower(strings.TrimRight(strings.TrimSpace(raw), "/"))
}

// Fingerprint is the deterministic dedupe key for a contribution. The basis selection is
// transcribed from lib/sources.ts — a different basis here would re-insert every existing row.
func Fingerprint(service Service, kind Kind, payload map[string]any) string {
	basis := ""
	switch {
	case kind == KindAPI:
		basis = NormalizeURL(str(payload["baseUrl"]))
	case service == ServiceDeezer:
		// Deezer's credential is the ARL cookie; there is no token or username to fall back to.
		basis = strings.TrimSpace(str(payload["arl"]))
	case service == ServiceAmazonMusic:
		// Amazon's credential is the web-session artifact stored under `session`; without its own
		// basis every Amazon entry would fingerprint identically and collapse to one row.
		basis = strings.TrimSpace(str(payload["session"]))
	default:
		token := strings.TrimSpace(str(payload["token"]))
		if token != "" {
			basis = token
		} else {
			basis = strings.ToLower(strings.TrimSpace(str(payload["username"]))) + ":" + strings.TrimSpace(str(payload["password"]))
		}
	}
	sum := sha256.Sum256([]byte(string(service) + "|" + string(kind) + "|" + basis))
	return hex.EncodeToString(sum[:])
}

// MaskLabel is a short, non-reversible label safe to show publicly.
func MaskLabel(service Service, kind Kind, payload map[string]any) string {
	svc := ServiceLabels[service]
	if kind == KindAPI {
		if host, ok := urlHost(str(payload["baseUrl"])); ok {
			return svc + " API · " + host
		}
		return svc + " API"
	}
	if service == ServiceDeezer {
		arl := strings.TrimSpace(str(payload["arl"]))
		// Show only the last 4 characters: an ARL is a bearer credential, so the label must stay
		// non-reversible even though it renders on the public status page.
		if arl != "" {
			return svc + " Account · ****" + tail(arl, 4)
		}
		return svc + " Account"
	}
	if user := strings.TrimSpace(str(payload["username"])); user != "" {
		shown := ""
		if len([]rune(user)) <= 2 {
			r := []rune(user)
			if len(r) > 0 {
				shown = string(r[0])
			}
		} else {
			shown = string([]rune(user)[:2]) + "…"
		}
		return svc + " Account · " + shown
	}
	if token := strings.TrimSpace(str(payload["token"])); token != "" {
		return svc + " Account · ****" + tail(token, 4)
	}
	if session := strings.TrimSpace(str(payload["session"])); session != "" {
		return svc + " Account · ****" + tail(session, 4)
	}
	return svc + " Account"
}

// urlHost reproduces `new URL(value).host` — including its failure on a relative or host-less
// value, where the TS falls back to the bare service label.
func urlHost(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", false
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" {
		host += ":" + port
	}
	return host, true
}

func tail(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return string(r)
	}
	return string(r[len(r)-n:])
}

// str is `String(value ?? "")` for the values payloads actually carry.
func str(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	}
	return ""
}
