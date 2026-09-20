# Credential encryption

## Why fields, not rows

Individual payload values (tokens, app IDs, secrets) are encrypted rather than whole rows, so the
non-sensitive fields the server needs in the clear keep working — most importantly an instance
`baseUrl`, which `/api/discovery/*` must be able to read and compare.

`SENSITIVE_KEYS` in `lib/crypto.ts` is an explicit allowlist, not a heuristic. A credential field
missing from that set is stored in plaintext, which is how `arl` and `masterSecret` have to be
listed by name even though "it's obviously a secret" — as do Amazon Music's `session`,
`bypassToken` and `turnstileJwt`. `turnstileJwtExpiresAt` is deliberately absent: it is a
timestamp a client needs in the clear.

## Two keys

| Env | Layer | Protects against |
|---|---|---|
| `POOL_ENCRYPTION_KEY` | At rest. Encrypts what goes into the database. Never leaves the server. | A database dump or backup leak |
| `POOL_CLIENT_KEY` | Response. Values from `/api/sources` are re-encrypted with it. | A browser hitting the feed URL seeing real tokens |

Both are base64 32-byte values: `openssl rand -base64 32`.

Callers handling account credentials must check `atRestEncryptionEnabled()` /
`clientEncryptionEnabled()` and fail closed when a key is absent. The transform functions still
pass plaintext through only so an operator can migrate rows written before the keys existed.

## Derived client keys (v2)

`deriveClientKey(readKey)` is `SHA-256("archivepool-client:" + readKey)`, and must match
`PoolCrypto.kt` byte for byte.

An app holding a valid read key can always decrypt its own feed, because the encryption key is a
pure function of the read key it sent. Nothing has to be kept in sync between the deployment and
the APK build, which removes a whole class of outage — old database deleted, secret rotated on one
side only, CI secret not equal to the Vercel env. Clients opt in with `X-Pool-Client: v2`;
`POOL_CLIENT_KEY` remains only for older clients.

The end-to-end property improves rather than degrades: intercepted ciphertext is readable only by
holders of that one read key, instead of by holders of a single global client key.

## Wire format

`enc:1:<iv>:<ciphertext+authTag>` — colon-delimited, all base64, AES-256-GCM with a 12-byte IV.

The 16-byte GCM auth tag is appended to the ciphertext because Java's `AES/GCM/NoPadding` expects
tag-trailing input, so the Android side decrypts without extra parsing.
