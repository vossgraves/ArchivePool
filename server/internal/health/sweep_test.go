// SPDX-License-Identifier: GPL-3.0-or-later
package health

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"archivepool/server/internal/crypto"
)

// TestMigrateAtRest pins the two properties that keep the sweep from undoing a credential rotation
// the lease path made while the sweep was running: a row that is already encrypted is not written
// at all, and a plaintext row is only written if it still holds the payload this run read.
func TestMigrateAtRest(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	t.Setenv("POOL_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(key))

	t.Run("an encrypted row is left alone", func(t *testing.T) {
		stored, err := crypto.EncryptAtRest(map[string]any{"token": "access", "refreshToken": "refresh"})
		if err != nil {
			t.Fatalf("encrypt: %v", err)
		}
		store := &recordingStore{}
		migrateAtRest(context.Background(), store, "account_entries", Entry{ID: 7, Payload: stored})
		if len(store.execs) != 0 {
			t.Fatalf("writes = %v, want none for an encrypted row", store.execs)
		}
	})

	t.Run("a row without credentials is left alone", func(t *testing.T) {
		store := &recordingStore{}
		migrateAtRest(context.Background(), store, "instance_entries",
			Entry{ID: 8, Payload: map[string]any{"baseUrl": "https://example.invalid"}})
		if len(store.execs) != 0 {
			t.Fatalf("writes = %v, want none for a row with nothing to encrypt", store.execs)
		}
	})

	t.Run("a plaintext row is encrypted only if unchanged", func(t *testing.T) {
		snapshot := map[string]any{"token": "access", "refreshToken": "refresh", "label": "x"}
		store := &recordingStore{}
		migrateAtRest(context.Background(), store, "account_entries", Entry{ID: 9, Payload: snapshot})
		if len(store.execs) != 1 {
			t.Fatalf("writes = %d, want exactly 1", len(store.execs))
		}
		rec := store.execs[0]
		if !strings.Contains(rec.sql, "where id = $2 and payload = $3::jsonb") {
			t.Fatalf("migration is not conditional on the payload read: %s", rec.sql)
		}
		if len(rec.args) != 3 || rec.args[1] != 9 {
			t.Fatalf("args = %v, want the new payload, the id and the payload read", rec.args)
		}
		var written, expected map[string]any
		if err := json.Unmarshal([]byte(rec.args[0].(string)), &written); err != nil {
			t.Fatalf("written payload is not JSON: %v", err)
		}
		if !crypto.IsEncrypted(written["token"]) || !crypto.IsEncrypted(written["refreshToken"]) {
			t.Fatalf("written payload = %v, want both credentials encrypted", written)
		}
		if plain := crypto.DecryptAtRest(written); plain["token"] != "access" || plain["refreshToken"] != "refresh" {
			t.Fatalf("written payload decrypts to %v, want the original credentials", plain)
		}
		if err := json.Unmarshal([]byte(rec.args[2].(string)), &expected); err != nil {
			t.Fatalf("compared payload is not JSON: %v", err)
		}
		if expected["token"] != "access" || expected["refreshToken"] != "refresh" {
			t.Fatalf("compared payload = %v, want the snapshot this run read", expected)
		}
	})
}
