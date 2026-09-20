// Package kdf holds the key-derivation primitives the port needs but the standard library does not
// provide: PBKDF2-HMAC-SHA256 (used by SCRAM) and scrypt (used for password hashing, replacing
// Node's crypto.scrypt).
//
// Both are implemented here rather than pulled from golang.org/x/crypto because the deployment has
// no module proxy: every dependency must come from the standard library.
package kdf

import (
	"crypto/hmac"
	"crypto/sha256"
)

// PBKDF2SHA256 is PBKDF2-HMAC-SHA256 (RFC 8018 §5.2), byte-identical to Node's
// crypto.pbkdf2Sync(secret, salt, iterations, keylen, "sha256").
func PBKDF2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	if iterations < 1 {
		iterations = 1
	}
	prf := hmac.New(sha256.New, password)
	hashLen := prf.Size()
	blocks := (keyLen + hashLen - 1) / hashLen
	out := make([]byte, 0, blocks*hashLen)
	buf := make([]byte, 4)
	u := make([]byte, hashLen)
	for block := 1; block <= blocks; block++ {
		prf.Reset()
		prf.Write(salt)
		buf[0] = byte(block >> 24)
		buf[1] = byte(block >> 16)
		buf[2] = byte(block >> 8)
		buf[3] = byte(block)
		prf.Write(buf)
		u = prf.Sum(u[:0])
		t := make([]byte, hashLen)
		copy(t, u)
		for i := 1; i < iterations; i++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}
