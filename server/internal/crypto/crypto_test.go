package crypto

import (
	"encoding/base64"
	"strings"
	"testing"
)

// The vectors in this file were produced by the TypeScript implementation itself (lib/crypto.ts
// transcribed verbatim into a Node script). Asserting against them, rather than against Go's own
// round trip, is what makes "byte-for-byte parity" checkable: the Android client and any surviving
// Next deployment must be able to decrypt what this server emits, and vice versa.

// testReadKey is a realistic read key (`atp_` + 48 hex chars).
const testReadKey = "atp_0123456789abcdef0123456789abcdef0123456789abcdef"

// nodeDerivedClientKey is createHash("sha256").update("archivepool-client:" + testReadKey).digest("hex").
const nodeDerivedClientKey = "ab7c5854faacc76d498f04e371c614b5519ddff6d01d723cf33502853af10ee4"

// nodeAtRestKeyB64 is a base64-encoded 32-byte key (what POOL_ENCRYPTION_KEY holds).
const nodeAtRestKeyB64 = "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8="

// nodeAtRestCiphertext encrypts "super-secret-token" under nodeAtRestKeyB64 with IV 0102030405060708090a0b0c.
const nodeAtRestCiphertext = "enc:1:AQIDBAUGBwgJCgsM:tMjrKmeOr80S7UHA/tzmwKcWXzToHl+ndlmCBalmuNRm/A=="

// nodeClientCiphertext encrypts "client-facing-token" under the derived client key with IV 0c0b0a090807060504030201.
const nodeClientCiphertext = "enc:1:DAsKCQgHBgUEAwIB:+hO7Au0Tn8cPb4Pi1XI/D7XwQj2tRcGwwnbCpUH2yL1d3/8="

func TestDeriveClientKeyMatchesTypeScript(t *testing.T) {
	got := DeriveClientKey(testReadKey)
	if hex := toHex(got); hex != nodeDerivedClientKey {
		t.Fatalf("deriveClientKey mismatch\n got: %s\nwant: %s", hex, nodeDerivedClientKey)
	}
	if len(got) != 32 {
		t.Fatalf("derived key must be 32 bytes for AES-256, got %d", len(got))
	}
}

func TestDecryptsTypeScriptCiphertext(t *testing.T) {
	key, err := base64.StdEncoding.DecodeString(nodeAtRestKeyB64)
	if err != nil {
		t.Fatalf("decoding key: %v", err)
	}
	plain, err := decryptValue(nodeAtRestCiphertext, key)
	if err != nil {
		t.Fatalf("decrypting the TS-produced at-rest ciphertext: %v", err)
	}
	if plain != "super-secret-token" {
		t.Fatalf("decrypted %q, want %q", plain, "super-secret-token")
	}

	clientPlain, err := decryptValue(nodeClientCiphertext, DeriveClientKey(testReadKey))
	if err != nil {
		t.Fatalf("decrypting the TS-produced client-layer ciphertext: %v", err)
	}
	if clientPlain != "client-facing-token" {
		t.Fatalf("decrypted %q, want %q", clientPlain, "client-facing-token")
	}
}

func TestEncryptedFormatIsEnc1IvCiphertext(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	blob, err := encryptValue("hello", key)
	if err != nil {
		t.Fatalf("encryptValue: %v", err)
	}
	if !strings.HasPrefix(blob, Prefix) {
		t.Fatalf("missing enc:1: prefix: %q", blob)
	}
	body := strings.TrimPrefix(blob, Prefix)
	ivB64, dataB64, ok := strings.Cut(body, ":")
	if !ok {
		t.Fatalf("expected <iv>:<data>, got %q", body)
	}
	iv, err := base64.StdEncoding.DecodeString(ivB64)
	if err != nil || len(iv) != 12 {
		t.Fatalf("IV must be 12 base64 bytes, got %d (%v)", len(iv), err)
	}
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		t.Fatalf("ciphertext is not base64: %v", err)
	}
	if len(data) != len("hello")+16 {
		t.Fatalf("expected ciphertext+16-byte tag, got %d bytes", len(data))
	}
	round, err := decryptValue(blob, key)
	if err != nil || round != "hello" {
		t.Fatalf("round trip failed: %q %v", round, err)
	}
}

func TestEncryptAtRestRequiresKeyForSensitiveFields(t *testing.T) {
	t.Setenv("POOL_ENCRYPTION_KEY", "")
	if _, err := EncryptAtRest(Payload{"token": "abc"}); err == nil {
		t.Fatal("expected an error when storing a credential without POOL_ENCRYPTION_KEY")
	}
	// A payload with no sensitive values is storable without a key, as the TS allows.
	out, err := EncryptAtRest(Payload{"baseUrl": "https://example.com"})
	if err != nil {
		t.Fatalf("non-sensitive payload: %v", err)
	}
	if out["baseUrl"] != "https://example.com" {
		t.Fatalf("payload was modified: %#v", out)
	}
	if AtRestEncryptionEnabled() {
		t.Fatal("atRestEncryptionEnabled must be false without a key")
	}
}

func TestTransformEncryptOnlyTouchesSensitiveStrings(t *testing.T) {
	t.Setenv("POOL_ENCRYPTION_KEY", nodeAtRestKeyB64)
	payload := Payload{
		"token":        "tok",
		"appId":        "12345",
		"baseUrl":      "https://example.com",
		"premium":      true,
		"latency":      float64(12),
		"empty":        "",
		"note":         "hello",
		"preEncrypted": nodeAtRestCiphertext,
	}
	stored, err := EncryptAtRest(payload)
	if err != nil {
		t.Fatalf("EncryptAtRest: %v", err)
	}
	for _, field := range []string{"token", "appId", "note"} {
		if !IsEncrypted(stored[field]) {
			t.Fatalf("%s should be encrypted, got %#v", field, stored[field])
		}
	}
	if stored["baseUrl"] != "https://example.com" {
		t.Fatalf("baseUrl must stay readable, got %#v", stored["baseUrl"])
	}
	if stored["premium"] != true || stored["latency"] != float64(12) {
		t.Fatalf("non-string fields must pass through: %#v", stored)
	}
	if stored["empty"] != "" {
		t.Fatalf("an empty sensitive value stays empty: %#v", stored["empty"])
	}
	// An already-encrypted value is not double-encrypted.
	if stored["preEncrypted"] != nodeAtRestCiphertext {
		t.Fatalf("already-encrypted value was re-encrypted: %#v", stored["preEncrypted"])
	}

	back := DecryptAtRest(stored)
	if back["token"] != "tok" || back["appId"] != "12345" || back["note"] != "hello" {
		t.Fatalf("round trip lost data: %#v", back)
	}
}

func TestDecryptWithoutKeyDropsCiphertext(t *testing.T) {
	t.Setenv("POOL_ENCRYPTION_KEY", "")
	out := DecryptAtRest(Payload{"token": nodeAtRestCiphertext, "baseUrl": "https://example.com"})
	// Dropping beats handing back ciphertext that reads like a real credential.
	if out["token"] != "" {
		t.Fatalf("expected the ciphertext to be dropped, got %#v", out["token"])
	}
	if out["baseUrl"] != "https://example.com" {
		t.Fatalf("plaintext fields must survive: %#v", out)
	}
}

func TestDecryptWithWrongKeyDropsValue(t *testing.T) {
	other := base64.StdEncoding.EncodeToString(make([]byte, 32))
	t.Setenv("POOL_ENCRYPTION_KEY", other)
	out := DecryptAtRest(Payload{"token": nodeAtRestCiphertext})
	if out["token"] != "" {
		t.Fatalf("a GCM auth failure must yield \"\", got %#v", out["token"])
	}
}

func TestClientEncryptionEnabledTracksEnv(t *testing.T) {
	t.Setenv("POOL_CLIENT_KEY", "")
	if ClientEncryptionEnabled() {
		t.Fatal("clientEncryptionEnabled must be false without POOL_CLIENT_KEY")
	}
	t.Setenv("POOL_CLIENT_KEY", nodeAtRestKeyB64)
	if !ClientEncryptionEnabled() {
		t.Fatal("clientEncryptionEnabled must be true with a valid POOL_CLIENT_KEY")
	}
	t.Setenv("POOL_CLIENT_KEY", "not-base64")
	if ClientEncryptionEnabled() {
		t.Fatal("a malformed key must disable the layer, not enable it")
	}
}

func TestLoadKeyRejectsWrongLength(t *testing.T) {
	t.Setenv("POOL_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString([]byte("short")))
	if key := LoadKey("POOL_ENCRYPTION_KEY"); key != nil {
		t.Fatalf("expected nil for a non-32-byte key, got %d bytes", len(key))
	}
}

func toHex(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, v := range b {
		out = append(out, digits[v>>4], digits[v&0x0f])
	}
	return string(out)
}
