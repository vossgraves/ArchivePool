// SPDX-License-Identifier: GPL-3.0-or-later
package health

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestMonochromeFeedURLs pins the reader against the document shapes monochrome actually serves.
//
// The feed used to be read as `[]string` only, but the project's own reader accepts a URL string OR
// a `{url, version}` object (`typeof item === 'string' ? item : item.url` in js/storage.js) — and
// the list it falls back to internally is exactly the object shape. Reading one shape threw on the
// other, which turned a readable feed into a failed cron. The official hosts are seeded on top of
// the feed because upstream now ships `INSTANCES_URLS: []` and no longer consumes any document.
func TestMonochromeFeedURLs(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{
			"string entries",
			`{"api":["https://a.example"],"streaming":["https://b.example"]}`,
			[]string{"https://a.example", "https://b.example", "https://tracks.monochrome.st", "https://api.monochrome.tf"},
		},
		{
			"object entries carry a version",
			`{"api":[{"url":"https://a.example","version":"2.10"}],"streaming":[{"url":"https://b.example","version":"3.5"}]}`,
			[]string{"https://a.example", "https://b.example", "https://tracks.monochrome.st", "https://api.monochrome.tf"},
		},
		{
			"mixed shapes in one document",
			`{"api":["https://a.example",{"url":"https://b.example"}],"streaming":[]}`,
			[]string{"https://a.example", "https://b.example", "https://tracks.monochrome.st", "https://api.monochrome.tf"},
		},
		{
			"empty entries contribute nothing",
			`{"api":[{"url":""},{},null,""],"streaming":["  https://b.example  "]}`, // null/blank must not throw
			[]string{"https://b.example", "https://tracks.monochrome.st", "https://api.monochrome.tf"},
		},
		{
			// The document upstream falls back to when its own list is empty.
			"an empty feed still seeds the official hosts",
			`{"api":[],"streaming":[]}`,
			[]string{"https://tracks.monochrome.st", "https://api.monochrome.tf"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var raw MonochromeInstances
			if err := json.Unmarshal([]byte(tc.body), &raw); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			got := monochromeFeedURLs(raw)
			if len(got) != len(tc.want) {
				t.Fatalf("urls = %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if strings.TrimSpace(got[i]) != tc.want[i] {
					t.Fatalf("urls = %v, want %v", got, tc.want)
				}
			}
		})
	}
}
