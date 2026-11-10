// SPDX-License-Identifier: GPL-3.0-or-later
package health

import "testing"

func TestTidalSubscriptionIsPremium(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"free account names premiumAccess false", `{"subscription":{"type":"FREE"},"highestSoundQuality":null,"premiumAccess":false,"status":"ACTIVE"}`, false},
		{"paid account", `{"subscription":{"type":"PREMIUM"},"highestSoundQuality":"HI_RES_LOSSLESS","premiumAccess":true}`, true},
		{"premiumAccess wins over quality", `{"highestSoundQuality":"LOSSLESS","premiumAccess":false}`, false},
		{"free type without premiumAccess", `{"subscription":{"type":"FREE"}}`, false},
		{"lossless quality only", `{"highestSoundQuality":"LOSSLESS"}`, true},
		{"lossy quality only", `{"highestSoundQuality":"HIGH"}`, false},
		{"no signal stays optimistic", `{"status":"ACTIVE"}`, true},
		{"unreadable stays optimistic", `<html>`, true},
	}
	for _, c := range cases {
		if got := tidalSubscriptionIsPremium(c.body); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
