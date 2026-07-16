import "server-only"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Field-level AES-256-GCM encryption for sensitive credential values.
 *
 * We encrypt individual payload values (tokens, app IDs, secrets) rather than the whole row so that
 * non-sensitive fields the server needs in the clear — most importantly an API instance `baseUrl`,
 * which the discovery endpoint must expose — keep working unchanged.
 *
 * Two independent keys are used:
 *  - `POOL_ENCRYPTION_KEY` — at-rest key. Encrypts values stored in the database. Never leaves the
 *    server. Protects against a database dump / backup leak.
 *  - `POOL_CLIENT_KEY` — end-to-end key. Values returned by `/api/sources` are re-encrypted with it,
 *    so a browser hitting the URL sees ciphertext, not tokens. The ArchiveTune app ships the same
 *    key and decrypts locally.
 *
 * Both keys are base64-encoded 32-byte values. Generate with: `openssl rand -base64 32`.
 * Callers that handle account credentials must check the exported configuration helpers and fail
 * closed when a key is absent. The transform functions retain plaintext compatibility only so an
 * operator can migrate rows written by an older deployment after configuring the keys.
 *
 * Wire format (colon-delimited, all base64): `enc:1:<iv>:<ciphertext+authTag>`
 * The 16-byte GCM auth tag is appended to the ciphertext so the blob decrypts with Java's
 * `AES/GCM/NoPadding` (which expects tag-trailing input) on the Android side without extra parsing.
 */

const PREFIX = "enc:1:"
const IV_BYTES = 12
const SENSITIVE_KEYS = new Set([
  "token",
  "refreshToken",
  "accessToken",
  "userAuthToken",
  "authToken",
  "appId",
  "appSecret",
  "secret",
  "password",
  "cookie",
  "username",
  "email",
  "userId",
  "countryCode",
  "note",
])

function loadKey(envName: string): Buffer | null {
  const raw = process.env[envName]
  if (!raw) return null
  const key = Buffer.from(raw, "base64")
  if (key.length !== 32) {
    console.log(`[v0] ${envName} must be a base64-encoded 32-byte key; encryption for this layer is disabled`)
    return null
  }
  return key
}

function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString("base64")}:${Buffer.concat([ct, tag]).toString("base64")}`
}

function decryptValue(blob: string, key: Buffer): string {
  const body = blob.slice(PREFIX.length)
  const [ivB64, dataB64] = body.split(":")
  const iv = Buffer.from(ivB64, "base64")
  const data = Buffer.from(dataB64, "base64")
  const tag = data.subarray(data.length - 16)
  const ct = data.subarray(0, data.length - 16)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
}

function isEncrypted(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(PREFIX)
}

type Payload = Record<string, unknown>

/** Encrypt sensitive fields with the given key. Non-string / non-sensitive fields pass through. */
function transformEncrypt(payload: Payload, key: Buffer | null): Payload {
  if (!key) return payload
  const out: Payload = {}
  for (const [k, v] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.has(k) && typeof v === "string" && v.length > 0 && !isEncrypted(v)) {
      out[k] = encryptValue(v, key)
    } else {
      out[k] = v
    }
  }
  return out
}

/** Decrypt any encrypted fields with the given key. Values that aren't encrypted pass through. */
function transformDecrypt(payload: Payload, key: Buffer | null): Payload {
  const out: Payload = {}
  for (const [k, v] of Object.entries(payload)) {
    if (isEncrypted(v)) {
      if (!key) {
        // Can't decrypt without the key — drop the value rather than leak ciphertext as if it were real.
        out[k] = ""
      } else {
        try {
          out[k] = decryptValue(v, key)
        } catch {
          out[k] = ""
        }
      }
    } else {
      out[k] = v
    }
  }
  return out
}

/** Encrypt sensitive fields for storage in the database (at-rest layer). */
export function encryptAtRest(payload: Payload): Payload {
  return transformEncrypt(payload, loadKey("POOL_ENCRYPTION_KEY"))
}

/** True only when database credential encryption is correctly configured. */
export function atRestEncryptionEnabled(): boolean {
  return loadKey("POOL_ENCRYPTION_KEY") !== null
}

/** Decrypt at-rest fields back to plaintext for server-side use (health checks, re-encryption). */
export function decryptAtRest(payload: Payload): Payload {
  return transformDecrypt(payload, loadKey("POOL_ENCRYPTION_KEY"))
}

/**
 * Re-encrypt sensitive fields with the client key for the response layer. Input must be plaintext
 * (i.e. already `decryptAtRest`-ed). The source route verifies configuration before calling this;
 * the transform's no-key compatibility exists only for migration and non-sensitive internal use.
 */
export function encryptForClient(payload: Payload): Payload {
  return transformEncrypt(payload, loadKey("POOL_CLIENT_KEY"))
}

/** True when a client key is configured, i.e. `/api/sources` will return ciphertext. */
export function clientEncryptionEnabled(): boolean {
  return loadKey("POOL_CLIENT_KEY") !== null
}
