// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { createHmac, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import type { NextResponse } from "next/server"
import { signWithSessionSecret } from "@/lib/hmac-cookie"

export { signWithSessionSecret, verifyWithSessionSecret } from "@/lib/hmac-cookie"

/**
 * Stateless, HMAC-signed session cookies.
 *
 * Cookie value: `<userId>.<expiresAtMs>.<hmac>`; the HMAC covers the first two
 * fields with SESSION_SECRET. No server-side session store is needed, and a
 * forged cookie fails signature verification. `SESSION_SECRET` failing to be
 * configured must fail CLOSED — signing must never fall back to a default.
 */
export const SESSION_COOKIE_NAME = "atp_session"
const COOKIE_NAME = SESSION_COOKIE_NAME
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim()
  if (!secret) {
    throw new Error("SESSION_SECRET is not configured; refusing to issue sessions")
  }
  return secret
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url")
}

// HMAC helpers live in lib/hmac-cookie.ts (re-exported above): crypto.subtle
// signing, same base64url wire format as the node:crypto `sign` here, so either
// signer verifies the other's cookies.

/** Session token identical to createSessionToken's, signed via crypto.subtle. */
export async function createSessionTokenWeb(userId: number): Promise<{ value: string; maxAgeMs: number }> {
  const expiresAtMs = Date.now() + SESSION_TTL_MS
  const payload = `${userId}.${expiresAtMs}`
  return { value: `${payload}.${await signWithSessionSecret(payload)}`, maxAgeMs: SESSION_TTL_MS }
}

/**
 * Whether the `Secure` attribute belongs on cookies set for [reqUrl].
 * Scheme-derived, not NODE_ENV-derived: on https (production, any host) the
 * cookie is Secure; on plain http (local dev, wrangler preview) it is not —
 * a Secure cookie over http is silently dropped by the browser, which is the
 * classic "sign-in succeeded but the UI still shows Sign in" failure.
 */
export function cookieSecure(reqUrl: string): boolean {
  try {
    return new URL(reqUrl).protocol === "https:"
  } catch {
    return process.env.NODE_ENV === "production"
  }
}

/**
 * Route-handler variant of setSessionCookie — writes onto the NextResponse being
 * returned (redirect responses in OAuth callbacks cannot use the cookies() store).
 * Pass the request URL so `secure` follows the real scheme.
 */
export async function applySessionCookie(
  res: NextResponse,
  userId: number,
  reqUrl?: string,
): Promise<void> {
  const { value, maxAgeMs } = await createSessionTokenWeb(userId)
  res.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: reqUrl !== undefined ? cookieSecure(reqUrl) : process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  })
}

export function createSessionToken(userId: number): { value: string; maxAgeMs: number } {
  const expiresAtMs = Date.now() + SESSION_TTL_MS
  const payload = `${userId}.${expiresAtMs}`
  return { value: `${payload}.${sign(payload)}`, maxAgeMs: SESSION_TTL_MS }
}

/** Returns the authenticated user id, or null when absent/forged/expired. */
export function verifySessionToken(token: string | undefined): number | null {
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [userIdRaw, expiresRaw, signature] = parts
  const expected = sign(`${userIdRaw}.${expiresRaw}`)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const userId = Number.parseInt(userIdRaw, 10)
  const expiresAtMs = Number.parseInt(expiresRaw, 10)
  if (!Number.isFinite(userId) || !Number.isFinite(expiresAtMs)) return null
  if (expiresAtMs <= Date.now()) return null
  return userId
}

export async function setSessionCookie(userId: number, reqUrl?: string): Promise<void> {
  const { value, maxAgeMs } = createSessionToken(userId)
  const store = await cookies()
  store.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: reqUrl !== undefined ? cookieSecure(reqUrl) : process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.set(COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 })
}

/**
 * Authenticated user id, or null when absent/forged/expired — OR when the
 * account is dead. Session cookies are stateless and cannot be revoked, so
 * resolution itself refuses them: a deleted, disabled or claimed legacy
 * account (claims mark it claimed_by + disabled) loses every outstanding
 * session the instant the row changes.
 */
export async function getSessionUserId(): Promise<number | null> {
  const store = await cookies()
  const userId = verifySessionToken(store.get(COOKIE_NAME)?.value)
  if (userId === null) return null
  const { isSessionUserLive } = await import("@/lib/users")
  return (await isSessionUserLive(userId)) ? userId : null
}
