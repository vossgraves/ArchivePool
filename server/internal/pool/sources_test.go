// SPDX-License-Identifier: GPL-3.0-or-later
package pool

import "testing"

// The fingerprints below were produced by lib/sources.ts itself (transcribed verbatim into a Node
// script). A fingerprint is the dedupe key of every contribution, so a mismatch here would either
// duplicate every existing row or silently merge unrelated credentials.

func TestFingerprintMatchesTypeScript(t *testing.T) {
	cases := []struct {
		name     string
		service  Service
		kind     Kind
		payload  map[string]any
		expected string
	}{
		{
			"instance URL is normalized before hashing",
			ServiceTidal, KindAPI, map[string]any{"baseUrl": "HTTPS://Example.com/Foo//"},
			"53fb893fc19b7e5c5cbacd7b299ef11dacb4f7fc0790fdb6c713814f0eb41344",
		},
		{
			"empty instance URL still fingerprints",
			ServiceTidal, KindAPI, map[string]any{"baseUrl": ""},
			"defc41bd73910cb2af94de803b08e07364dcc94d5ae3d5366baa4ae603bbc34a",
		},
		{
			"token is trimmed",
			ServiceTidal, KindAccount, map[string]any{"token": "  tok123 "},
			"1335de144f38bc29ac5e9b2b8492050f3e36ab94b8d6e4cd9d088d15f7591d55",
		},
		{
			"username/password fallback lowercases the username",
			ServiceQobuz, KindAccount, map[string]any{"username": "User@Example.com", "password": "pw"},
			"7aaa0bec306a3c7955b1716d907e0c6ace879f264dcd7bd7168576a30c43c20b",
		},
		{
			"a token outranks the username",
			ServiceQobuz, KindAccount, map[string]any{"token": "qtok"},
			"d71b5728b9ba64502ef423087f60e0be22d639bcd0c48fc93998c6c85cc9207a",
		},
		{
			"deezer hashes only the ARL",
			ServiceDeezer, KindAccount, map[string]any{"arl": "abcDEF123"},
			"24aa1863519b5335c2dd1fcd30f47af67520aa92cac0133f73aa4c008780e0c7",
		},
		{
			"amazon hashes only the session artifact",
			ServiceAmazonMusic, KindAccount, map[string]any{"session": "  sess-xyz  "},
			"b6e8a0491012f6b01600c2f1a0938fe7f582b8f244f085e851c37a1b55fbe87a",
		},
		{
			// The instance tier fingerprints by URL like every other instance: the auth material on
			// the entry (a bypass token, a Turnstile JWT) must not become part of the dedupe key, or
			// rotating a token would insert a second row for the same instance.
			"amazon instances hash the base URL, not the auth material",
			ServiceAmazonMusic, KindAPI, map[string]any{"baseUrl": "HTTPS://Inst.example.com/Foo//", "bypassToken": "btok", "turnstileJwt": "jwt"},
			"50ada1eaca9c9d347a2f49cb5011ec595432b06bce8dbc1e801ad72de49f31fc",
		},
		{
			"apple music hashes the media-user-token",
			ServiceAppleMusic, KindAccount, map[string]any{"token": "0.abc"},
			"9e5a2200f2ba6f2b095e18961608a96f2487c412866964a02148d281495d238a",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Fingerprint(tc.service, tc.kind, tc.payload); got != tc.expected {
				t.Fatalf("fingerprint mismatch\n got: %s\nwant: %s", got, tc.expected)
			}
		})
	}
}

func TestFingerprintDistinguishesServicesAndKinds(t *testing.T) {
	payload := map[string]any{"baseUrl": "https://example.com"}
	if Fingerprint(ServiceTidal, KindAPI, payload) == Fingerprint(ServiceQobuz, KindAPI, payload) {
		t.Fatal("the service must be part of the fingerprint basis")
	}
	account := map[string]any{"token": "same"}
	if Fingerprint(ServiceTidal, KindAccount, account) == Fingerprint(ServiceTidal, KindAPI, account) {
		t.Fatal("the kind must be part of the fingerprint basis")
	}
	// Amazon and Deezer would collapse into one row without their own basis, so this is the case the
	// TS comments call out explicitly.
	if Fingerprint(ServiceDeezer, KindAccount, map[string]any{"arl": "x"}) ==
		Fingerprint(ServiceAmazonMusic, KindAccount, map[string]any{"session": "x"}) {
		t.Fatal("deezer and amazon-music must not share a basis")
	}
}

func TestMaskLabelMatchesTypeScript(t *testing.T) {
	cases := []struct {
		name    string
		service Service
		kind    Kind
		payload map[string]any
		want    string
	}{
		{"instance host with port", ServiceTidal, KindAPI, map[string]any{"baseUrl": "https://api.example.com:8443/deep/path"}, "Tidal API · api.example.com:8443"},
		{"unparseable instance URL", ServiceTidal, KindAPI, map[string]any{"baseUrl": "not-a-url"}, "Tidal API"},
		{"empty instance URL", ServiceQobuz, KindAPI, map[string]any{"baseUrl": ""}, "Qobuz API"},
		{"deezer shows the ARL tail", ServiceDeezer, KindAccount, map[string]any{"arl": "abcdef1234"}, "Deezer Account · ****1234"},
		{"deezer without an ARL", ServiceDeezer, KindAccount, map[string]any{"arl": ""}, "Deezer Account"},
		{"one-character username", ServiceTidal, KindAccount, map[string]any{"username": "a"}, "Tidal Account · a"},
		{"longer usernames are elided", ServiceTidal, KindAccount, map[string]any{"username": "alice"}, "Tidal Account · al…"},
		{"token tail", ServiceQobuz, KindAccount, map[string]any{"token": "tok12345"}, "Qobuz Account · ****2345"},
		{"session tail", ServiceAmazonMusic, KindAccount, map[string]any{"session": "sess12345"}, "Amazon Music Account · ****2345"},
		{"amazon instance shows its host", ServiceAmazonMusic, KindAPI, map[string]any{"baseUrl": "https://inst.example.com/", "bypassToken": "btok"}, "Amazon Music API · inst.example.com"},
		{"amazon instance without a parseable URL", ServiceAmazonMusic, KindAPI, map[string]any{"baseUrl": ""}, "Amazon Music API"},
		{"no identifier at all", ServiceAppleMusic, KindAccount, map[string]any{}, "Apple Music Account"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := MaskLabel(tc.service, tc.kind, tc.payload); got != tc.want {
				t.Fatalf("maskLabel = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeURLMatchesTypeScript(t *testing.T) {
	if got := NormalizeURL(" HTTPS://Example.com/Foo//  "); got != "https://example.com/foo" {
		t.Fatalf("normalizeUrl = %q", got)
	}
	if got := NormalizeURL("https://example.com"); got != "https://example.com" {
		t.Fatalf("normalizeUrl must not strip the scheme separator: %q", got)
	}
}

func TestServiceAndKindValidation(t *testing.T) {
	for _, service := range Services {
		if !IsService(string(service)) {
			t.Errorf("%q should be a known service", service)
		}
	}
	if IsService("spotify") || IsService("") {
		t.Fatal("unknown services must be rejected")
	}
	if !IsKind("api") || !IsKind("account") || IsKind("token") {
		t.Fatal("kind validation drifted")
	}
}

func TestCategoriesCoverEveryPublicCategory(t *testing.T) {
	want := []struct {
		service Service
		kind    Kind
	}{
		{ServiceTidal, KindAPI}, {ServiceTidal, KindAccount},
		{ServiceQobuz, KindAPI}, {ServiceQobuz, KindAccount},
		{ServiceDeezer, KindAPI}, {ServiceDeezer, KindAccount}, {ServiceAppleMusic, KindAccount},
		{ServiceAmazonMusic, KindAPI}, {ServiceAmazonMusic, KindAccount},
	}
	if len(Categories) != len(want) {
		t.Fatalf("expected %d categories, got %d", len(want), len(Categories))
	}
	for i, cat := range Categories {
		if cat.Service != want[i].service || cat.Kind != want[i].kind {
			t.Errorf("category %d = %s/%s, want %s/%s", i, cat.Service, cat.Kind, want[i].service, want[i].kind)
		}
	}
}
