// SPDX-License-Identifier: GPL-3.0-or-later
package pgwire

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	"archivepool/server/internal/kdf"
)

// SCRAM-SHA-256 (RFC 5802 with the SHA-256 hash from RFC 7677). Required in practice: Neon and
// Railway default `password_encryption = scram-sha-256`, so a client that only speaks MD5 cannot
// connect to the deployments this port targets.
//
// Channel binding is not negotiated: we always pick the plain SCRAM-SHA-256 mechanism, which
// servers advertising SCRAM-SHA-256-PLUS still accept (the `channel_binding=require` parameter
// some connection strings carry is a client-side preference, not a server-side demand).

const (
	scramMech       = "SCRAM-SHA-256"
	scramNonceBytes = 18
)

type scramClient struct {
	user     string
	password string

	nonce           string
	clientFirstBare string
	saltedPassword  []byte
	authMessage     string
	serverSignature []byte
}

func newSCRAM(user, password string) *scramClient {
	return &scramClient{user: user, password: password}
}

// scramEscape applies the `=`/`,` escaping SCRAM mandates in the username.
func scramEscape(s string) string {
	s = strings.ReplaceAll(s, "=", "=3D")
	return strings.ReplaceAll(s, ",", "=2C")
}

func randomNonce() (string, error) {
	buf := make([]byte, scramNonceBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(buf), nil
}

// clientFirst returns the SASLInitialResponse payload body (the `client-first-message`).
func (s *scramClient) clientFirst() ([]byte, error) {
	nonce, err := randomNonce()
	if err != nil {
		return nil, err
	}
	s.nonce = nonce
	s.clientFirstBare = "n=" + scramEscape(s.user) + ",r=" + nonce
	return []byte("n,," + s.clientFirstBare), nil
}

// scramFields splits a SCRAM message into its `k=v` attributes (the gs2 header is skipped). It is
// deliberately permissive: the server-first-message carries a nonce, the server-final only a
// signature, so validation belongs to the caller that knows which message it has.
func scramFields(msg string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(msg, ",") {
		k, v, ok := strings.Cut(part, "=")
		if !ok || len(k) != 1 {
			continue
		}
		out[k] = v
	}
	return out
}

// clientFinal consumes the server-first-message and produces the client-final-message.
func (s *scramClient) clientFinal(serverFirst []byte) ([]byte, error) {
	fields := scramFields(string(serverFirst))
	serverNonce := fields["r"]
	if serverNonce == "" {
		return nil, fmt.Errorf("pgwire: SCRAM server-first-message has no nonce")
	}
	if !strings.HasPrefix(serverNonce, s.nonce) {
		return nil, fmt.Errorf("pgwire: SCRAM server nonce does not extend the client nonce")
	}
	salt, err := base64.StdEncoding.DecodeString(fields["s"])
	if err != nil {
		return nil, fmt.Errorf("pgwire: SCRAM salt is not valid base64: %w", err)
	}
	iterations, err := strconv.Atoi(fields["i"])
	if err != nil || iterations <= 0 {
		return nil, fmt.Errorf("pgwire: SCRAM iteration count is invalid")
	}

	s.saltedPassword = kdf.PBKDF2SHA256([]byte(s.password), salt, iterations, sha256.Size)

	clientKey := hmacSHA256(s.saltedPassword, []byte("Client Key"))
	storedKey := sha256Sum(clientKey)
	clientFinalWithoutProof := "c=" + base64.StdEncoding.EncodeToString([]byte("n,,")) + ",r=" + serverNonce
	s.authMessage = s.clientFirstBare + "," + string(serverFirst) + "," + clientFinalWithoutProof

	clientSignature := hmacSHA256(storedKey, []byte(s.authMessage))
	proof := make([]byte, len(clientKey))
	for i := range clientKey {
		proof[i] = clientKey[i] ^ clientSignature[i]
	}

	serverKey := hmacSHA256(s.saltedPassword, []byte("Server Key"))
	s.serverSignature = hmacSHA256(serverKey, []byte(s.authMessage))

	return []byte(clientFinalWithoutProof + ",p=" + base64.StdEncoding.EncodeToString(proof)), nil
}

// verifyServerFinal checks the server's `v=` signature, proving the server also knew the password.
func (s *scramClient) verifyServerFinal(serverFinal []byte) error {
	fields := scramFields(string(serverFinal))
	if e := fields["e"]; e != "" {
		return fmt.Errorf("pgwire: SCRAM authentication failed: %s", e)
	}
	sig, err := base64.StdEncoding.DecodeString(fields["v"])
	if err != nil {
		return fmt.Errorf("pgwire: SCRAM server signature is not valid base64: %w", err)
	}
	if !hmac.Equal(sig, s.serverSignature) {
		return fmt.Errorf("pgwire: SCRAM server signature verification failed")
	}
	return nil
}

func hmacSHA256(key, msg []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(msg)
	return mac.Sum(nil)
}

func sha256Sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}
