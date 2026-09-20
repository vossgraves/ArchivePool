package httpapi

import (
	"net/url"
	"reflect"
	"testing"

	"archivepool/server/internal/pool"
)

// buildSubmitPayload mirrors app/actions/submit.ts. These cases pin the two properties a
// transcription can silently lose: every other service's payload keeps its exact field set, and the
// Amazon instance auth material is carried (blank fields omitted, never sent as "").
func TestBuildSubmitPayload(t *testing.T) {
	amazonInstanceForm := url.Values{
		"baseUrl":               {"https://inst.example.com/"},
		"healthPath":            {"/health"},
		"probeUrl":              {" /track/1 "},
		"bypassToken":           {"  btok  "},
		"turnstileJwt":          {"jwt-value"},
		"turnstileJwtExpiresAt": {"2026-09-20T12:00:00Z"},
		"note":                  {" eu-west "},
	}

	cases := []struct {
		name    string
		service pool.Service
		kind    pool.Kind
		form    url.Values
		want    map[string]any
	}{
		{
			"amazon instance carries the auth material",
			pool.ServiceAmazonMusic, pool.KindAPI, amazonInstanceForm,
			map[string]any{
				"baseUrl":               "https://inst.example.com/",
				"healthPath":            "/health",
				"probeUrl":              "/track/1",
				"bypassToken":           "btok",
				"turnstileJwt":          "jwt-value",
				"turnstileJwtExpiresAt": "2026-09-20T12:00:00Z",
				"note":                  "eu-west",
			},
		},
		{
			"amazon instance without auth material keeps the plain instance shape",
			pool.ServiceAmazonMusic, pool.KindAPI, url.Values{"baseUrl": {"https://inst.example.com"}},
			map[string]any{"baseUrl": "https://inst.example.com"},
		},
		{
			// The auth fields are Amazon-only: a Tidal instance that happens to receive them must not
			// start storing them.
			"other instance services ignore the auth fields",
			pool.ServiceTidal, pool.KindAPI, amazonInstanceForm,
			map[string]any{
				"baseUrl":    "https://inst.example.com/",
				"healthPath": "/health",
				"probeUrl":   "/track/1",
				"note":       "eu-west",
			},
		},
		{
			"amazon account carries the session and the auth material",
			pool.ServiceAmazonMusic, pool.KindAccount,
			url.Values{"session": {"abcdefghijklmnop"}, "premium": {"true"}, "bypassToken": {"btok"}},
			map[string]any{"session": "abcdefghijklmnop", "premium": true, "bypassToken": "btok"},
		},
		{
			"amazon account with a blank bypass token keeps the old shape",
			pool.ServiceAmazonMusic, pool.KindAccount,
			url.Values{"session": {"abcdefghijklmnop"}, "bypassToken": {"   "}},
			map[string]any{"session": "abcdefghijklmnop", "premium": false},
		},
		{
			"qobuz account is unchanged",
			pool.ServiceQobuz, pool.KindAccount,
			url.Values{"token": {"qtok"}, "appId": {"123"}, "appSecret": {"sec"}, "bypassToken": {"btok"}},
			map[string]any{"token": "qtok", "appId": "123", "appSecret": "sec"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildSubmitPayload(tc.service, tc.kind, tc.form)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("payload = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// validateSubmit must keep accepting a well-formed Amazon instance and account, and keep rejecting
// the malformed session the app-side floor exists for.
func TestValidateSubmitAmazon(t *testing.T) {
	cases := []struct {
		name    string
		kind    pool.Kind
		payload map[string]any
		want    string
	}{
		{"instance with a base URL", pool.KindAPI, map[string]any{"baseUrl": "https://inst.example.com"}, ""},
		{"instance without a base URL", pool.KindAPI, map[string]any{"baseUrl": ""}, "Base URL must be http(s)."},
		{"instance with a non-http scheme", pool.KindAPI, map[string]any{"baseUrl": "ftp://inst.example.com"}, "Base URL must be http(s)."},
		// url.Parse returns (nil, err) here; reading the scheme off that nil panicked before.
		{"instance with an unparseable base URL", pool.KindAPI, map[string]any{"baseUrl": "%zz"}, "Enter a valid base URL (including https://)."},
		{"account with a session", pool.KindAccount, map[string]any{"session": "abcdefghijklmnop"}, ""},
		{"account without a session", pool.KindAccount, map[string]any{"session": ""}, "Amazon Music submissions need the account session artifact."},
		{"truncated session", pool.KindAccount, map[string]any{"session": "tooshort"}, "That session value looks truncated — paste the whole thing."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := validateSubmit(pool.ServiceAmazonMusic, tc.kind, tc.payload); got != tc.want {
				t.Fatalf("validateSubmit = %q, want %q", got, tc.want)
			}
		})
	}
}
