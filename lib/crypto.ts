import "server-only"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

/** Field-level AES-256-GCM encryption for credential values. See docs/CRYPTO.md. */

const PREFIX = "enc:1:"
const IV_BYTES = 12
const SENSITIVE_KEYS: Record<string, true> = {
  token: true,
  refreshToken: true,
  accessToken: true,
  userAuthToken: true,
  authToken: true,
  appId: true,
  appSecret: true,
  secret: true,
  // An allowlist, not a heuristic: a credential field missing here is stored in plaintext.
  arl: true,
  masterSecret: true,
  password: true,
  cookie: true,
  username: true,
  email: true,
  userId: true,
  countryCode: true,
  note: true,
  // Amazon Music. `session` is the web-session artifact an account entry carries — the same kind
  // of bearer credential as `token`, and it was missing from this list. The other two are the
  // instance tier's auth material: the operator's long-lived `bypassToken` and a pre-minted
  // Cloudflare Turnstile `turnstileJwt` (short-lived, minted by solving a challenge against the
  // instance). `turnstileJwtExpiresAt` is deliberately absent: it is a timestamp, not a secret,
  // and a client reads it to skip a token that is already stale.
  session: true,
  bypassToken: true,
  turnstileJwt: true,
}

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
    if (SENSITIVE_KEYS[k] === true && typeof v === "string" && v.length > 0 && !isEncrypted(v)) {
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
        // Drop it rather than hand back ciphertext that reads like a real value.
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
  const key = loadKey("POOL_ENCRYPTION_KEY")
  if (!key && Object.entries(payload).some(([name, value]) => SENSITIVE_KEYS[name] === true && typeof value === "string" && value.length > 0)) {
    throw new Error("POOL_ENCRYPTION_KEY is required for credential storage")
  }
  return transformEncrypt(payload, key)
}

/** True only when database credential encryption is correctly configured. */
export function atRestEncryptionEnabled(): boolean {
  return loadKey("POOL_ENCRYPTION_KEY") !== null
}

/** Decrypt at-rest fields back to plaintext for server-side use (health checks, re-encryption). */
export function decryptAtRest(payload: Payload): Payload {
  return transformDecrypt(payload, loadKey("POOL_ENCRYPTION_KEY"))
}

/** Must match PoolCrypto.kt byte for byte. */
const CLIENT_KEY_DOMAIN = "archivepool-client:"

/** Per-requester client key, derived from the presented read key. See docs/CRYPTO.md. */
export function deriveClientKey(readKey: string): Buffer {
  return createHash("sha256").update(CLIENT_KEY_DOMAIN + readKey).digest()
}

/** Re-encrypt for the response layer. Input must already be `decryptAtRest`-ed. */
export function encryptForClient(payload: Payload, keyOverride?: Buffer | null): Payload {
  return transformEncrypt(payload, keyOverride ?? loadKey("POOL_CLIENT_KEY"))
}

/** True when a client key is configured, i.e. `/api/sources` will return ciphertext. */
export function clientEncryptionEnabled(): boolean {
  return loadKey("POOL_CLIENT_KEY") !== null
}
