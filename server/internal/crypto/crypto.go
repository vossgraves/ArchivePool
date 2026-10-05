// SPDX-License-Identifier: GPL-3.0-or-later
// Package crypto mirrors lib/crypto.ts byte for byte: field-level AES-256-GCM at rest plus the
// re-encryption layer handed to clients.
//
// The wire format is fixed by the shipped Android client (PoolCrypto.kt):
//
//	enc:1:<base64(iv)>:<base64(ciphertext||tag)>       GCM, 12-byte IV, 16-byte tag
//
// and the derived client key is sha256("archivepool-client:" + readKey).
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
)

const (
	// Prefix marks an encrypted value. A value without it is never touched on decrypt.
	Prefix  = "enc:1:"
	ivBytes = 12
)

// clientKeyDomain must match PoolCrypto.kt exactly; changing it breaks every v2 client.
const clientKeyDomain = "archivepool-client:"

// sensitiveKeys is an allowlist, not a heuristic: a credential field missing here is stored in
// plaintext, so it is transcribed verbatim from lib/crypto.ts.
var sensitiveKeys = map[string]bool{
	"token":         true,
	"refreshToken":  true,
	"accessToken":   true,
	"userAuthToken": true,
	"authToken":     true,
	"appId":         true,
	"appSecret":     true,
	"secret":        true,
	"arl":           true,
	"masterSecret":  true,
	"password":      true,
	"cookie":        true,
	"username":      true,
	"email":         true,
	"userId":        true,
	"countryCode":   true,
	"note":          true,
	// Amazon Music: the account's web-session artifact (the same kind of bearer value as `token`,
	// and previously missing from this list), plus the instance tier's operator `bypassToken` and a
	// pre-minted Turnstile `turnstileJwt`. `turnstileJwtExpiresAt` is a timestamp, not a secret, so
	// a client can read it to skip an already-stale token.
	"session":      true,
	"bypassToken":  true,
	"turnstileJwt": true,
}

// Payload is a decrypted/encrypted credential object (a jsonb column value).
type Payload = map[string]any

// ErrEncryptionRequired is returned when credentials would have to be stored in plaintext.
var ErrEncryptionRequired = errors.New("POOL_ENCRYPTION_KEY is required for credential storage")

// LoadKey reads a base64-encoded 32-byte key from the environment. A missing or wrong-length value
// disables that layer and logs the same line the TS does, so log-scraping stays identical.
func LoadKey(envName string) []byte {
	raw := envValue(envName)
	if raw == "" {
		return nil
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(key) != 32 {
		log.Printf("[v0] %s must be a base64-encoded 32-byte key; encryption for this layer is disabled", envName)
		return nil
	}
	return key
}

// envValue is the process environment (a variable so tests can inject keys).
var envValue = os.Getenv

// IsEncrypted reports whether a column value is ciphertext in the enc:1: format.
func IsEncrypted(v any) bool {
	s, ok := v.(string)
	return ok && strings.HasPrefix(s, Prefix)
}

// EncryptAtRest encrypts the sensitive fields for storage in the database.
func EncryptAtRest(payload Payload) (Payload, error) {
	key := LoadKey("POOL_ENCRYPTION_KEY")
	if key == nil && hasSensitiveValue(payload) {
		return nil, ErrEncryptionRequired
	}
	return transformEncrypt(payload, key), nil
}

// AtRestEncryptionEnabled mirrors atRestEncryptionEnabled(): true only when the key is valid.
func AtRestEncryptionEnabled() bool { return LoadKey("POOL_ENCRYPTION_KEY") != nil }

// DecryptAtRest decrypts at-rest fields for server-side use (health checks, re-encryption).
func DecryptAtRest(payload Payload) Payload {
	return transformDecrypt(payload, LoadKey("POOL_ENCRYPTION_KEY"))
}

// DeriveClientKey is sha256("archivepool-client:" + readKey): the v2 one-secret scheme, where the
// client needs only its read key.
func DeriveClientKey(readKey string) []byte {
	sum := sha256.Sum256([]byte(clientKeyDomain + readKey))
	return sum[:]
}

// EncryptForClient re-encrypts a decrypted payload for the response layer. A nil keyOverride falls
// back to the deployment's static POOL_CLIENT_KEY (legacy clients).
func EncryptForClient(payload Payload, keyOverride []byte) Payload {
	key := keyOverride
	if key == nil {
		key = LoadKey("POOL_CLIENT_KEY")
	}
	return transformEncrypt(payload, key)
}

// ClientEncryptionEnabled mirrors clientEncryptionEnabled(): true when POOL_CLIENT_KEY is set.
func ClientEncryptionEnabled() bool { return LoadKey("POOL_CLIENT_KEY") != nil }

func hasSensitiveValue(payload Payload) bool {
	for name, value := range payload {
		if !sensitiveKeys[name] {
			continue
		}
		if s, ok := value.(string); ok && s != "" {
			return true
		}
	}
	return false
}

func transformEncrypt(payload Payload, key []byte) Payload {
	if key == nil {
		return payload
	}
	out := make(Payload, len(payload))
	for _, k := range sortedKeys(payload) {
		v := payload[k]
		if s, ok := v.(string); ok && sensitiveKeys[k] && s != "" && !strings.HasPrefix(s, Prefix) {
			enc, err := encryptValue(s, key)
			if err != nil {
				// Encryption of a single field cannot fail for a valid key; keep plaintext rather
				// than dropping the credential, matching the TS, which would throw.
				out[k] = v
				continue
			}
			out[k] = enc
			continue
		}
		out[k] = v
	}
	return out
}

func transformDecrypt(payload Payload, key []byte) Payload {
	out := make(Payload, len(payload))
	for _, k := range sortedKeys(payload) {
		v := payload[k]
		if s, ok := v.(string); ok && strings.HasPrefix(s, Prefix) {
			if key == nil {
				// Drop it rather than hand back ciphertext that reads like a real value.
				out[k] = ""
				continue
			}
			plain, err := decryptValue(s, key)
			if err != nil {
				out[k] = ""
				continue
			}
			out[k] = plain
			continue
		}
		out[k] = v
	}
	return out
}

func encryptValue(plaintext string, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, ivBytes)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	return fmt.Sprintf("%s%s:%s", Prefix,
		base64.StdEncoding.EncodeToString(iv),
		base64.StdEncoding.EncodeToString(sealed)), nil
}

func decryptValue(blob string, key []byte) (string, error) {
	body := strings.TrimPrefix(blob, Prefix)
	ivB64, dataB64, ok := strings.Cut(body, ":")
	if !ok {
		return "", errors.New("crypto: malformed ciphertext")
	}
	iv, err := base64.StdEncoding.DecodeString(ivB64)
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return "", err
	}
	if len(data) < 16 {
		return "", errors.New("crypto: ciphertext too short")
	}
	tag := data[len(data)-16:]
	ct := data[:len(data)-16]
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, iv, append(append([]byte(nil), ct...), tag...), nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func sortedKeys(payload Payload) []string {
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
