package auth

import (
	"encoding/hex"
	"strings"
	"testing"
)

// nodeScryptHash was produced by lib/users.ts hashPassword with a fixed salt
// (00112233445566778899aabbccddeeff) for the password below. Verification here proves the stored
// `N:r:p:salt:hash` format and the scrypt derivation match Node's crypto.scrypt exactly — the format
// a deployment's existing password rows depend on.
const (
	nodeScryptPassword = "correct horse battery staple"
	nodeScryptHash     = "16384:8:1:00112233445566778899aabbccddeeff:fcd5a58d5301bbc44e90fc9a53f156134baee795eb7735ed6473da86e34ba93009476236665814fe08f7bd38ad1f5a2709832fb447b93b94e1a4a94dc5d1442e"
)

func TestVerifyPasswordAcceptsTypeScriptHash(t *testing.T) {
	if !VerifyPassword(nodeScryptPassword, nodeScryptHash) {
		t.Fatal("a hash written by lib/users.ts must verify")
	}
	if VerifyPassword("wrong password", nodeScryptHash) {
		t.Fatal("a wrong password must not verify")
	}
	// Parity note: a truncated stored hash still verifies, because the derived key length comes from
	// the stored value — lib/users.ts derives `expected.length` bytes for the same reason. That is the
	// documented behaviour of the TS implementation, so it is pinned here rather than "fixed".
	if !VerifyPassword(nodeScryptPassword, nodeScryptHash[:len(nodeScryptHash)-4]) {
		t.Fatal("key length follows the stored hash, as in lib/users.ts")
	}
}

func TestHashPasswordFormat(t *testing.T) {
	hash, err := HashPassword("hunter2hunter2")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	parts := strings.Split(hash, ":")
	if len(parts) != 5 {
		t.Fatalf("expected N:r:p:salt:hash, got %q", hash)
	}
	if parts[0] != "16384" || parts[1] != "8" || parts[2] != "1" {
		t.Fatalf("scrypt parameters must be 16384:8:1, got %s:%s:%s", parts[0], parts[1], parts[2])
	}
	salt, err := hex.DecodeString(parts[3])
	if err != nil || len(salt) != 16 {
		t.Fatalf("salt must be 16 hex-decoded bytes, got %d (%v)", len(salt), err)
	}
	derived, err := hex.DecodeString(parts[4])
	if err != nil || len(derived) != KeyLength {
		t.Fatalf("hash must be %d hex-decoded bytes, got %d (%v)", KeyLength, len(derived), err)
	}
	if !VerifyPassword("hunter2hunter2", hash) {
		t.Fatal("a freshly written hash must verify")
	}
	if VerifyPassword("HUNTER2hunter2", hash) {
		t.Fatal("verification must be case-sensitive")
	}
}

func TestVerifyPasswordRejectsMalformedHashes(t *testing.T) {
	cases := map[string]string{
		"too few parts": "16384:8:1:abcd",
		"non-numeric N": "x:8:1:00:11",
		"empty salt":    "16384:8:1::11",
		"empty hash":    "16384:8:1:00:",
		"non-hex salt":  "16384:8:1:zz:11",
		"non-hex hash":  "16384:8:1:00:zz",
		"empty string":  "",
	}
	for name, stored := range cases {
		if VerifyPassword("whatever", stored) {
			t.Errorf("%s: expected rejection", name)
		}
	}
}

func TestValidateCredentialsMatchesSignupRules(t *testing.T) {
	cases := []struct {
		username string
		password string
		wantOK   bool
	}{
		{"alice", "password1", true},
		{"a_b_9", "password1", true},
		{"al", "password1", false},                    // too short
		{strings.Repeat("a", 25), "password1", false}, // too long
		{"Alice", "password1", false},                 // uppercase is rejected before lowercasing upstream
		{"alice", "short", false},                     // < 8 characters
		{"alice", strings.Repeat("x", 129), false},
		{"alice", strings.Repeat("x", 128), true},
	}
	for _, tc := range cases {
		problem := ValidateCredentials(tc.username, tc.password)
		if gotOK := problem == ""; gotOK != tc.wantOK {
			t.Errorf("ValidateCredentials(%q, len %d) = %q; want ok=%v", tc.username, len(tc.password), problem, tc.wantOK)
		}
	}
}
