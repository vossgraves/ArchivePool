// SPDX-License-Identifier: GPL-3.0-or-later
// NOTE: no "server-only" import and no runtime dependencies — this module is also
// compiled standalone for the node regression sim (scripts/sim-github-auth.mjs).

function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  for (const b of view) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function hmacKeyBytes(): Uint8Array {
  const secret = process.env.SESSION_SECRET?.trim()
  if (!secret) {
    throw new Error("SESSION_SECRET is not configured; refusing to sign")
  }
  return new TextEncoder().encode(secret)
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", hmacKeyBytes() as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
}

/** HMAC-SHA-256 over [payload] with SESSION_SECRET, base64url — identical wire format
 *  to the node:crypto signer in lib/sessions.ts, so either verifies the other. */
export async function signWithSessionSecret(payload: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(payload))
  return bytesToBase64Url(sig)
}

/** Constant-time equality for two equal-length strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** True only when [signature] matches the SESSION_SECRET HMAC of [payload]. */
export async function verifyWithSessionSecret(payload: string, signature: string): Promise<boolean> {
  const expected = await signWithSessionSecret(payload)
  return safeEqual(expected, signature)
}
