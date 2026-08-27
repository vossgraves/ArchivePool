import "server-only"
import { createHmac, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"

/**
 * Stateless, HMAC-signed session cookies.
 *
 * Cookie value: `<userId>.<expiresAtMs>.<hmac>`; the HMAC covers the first two
 * fields with SESSION_SECRET. No server-side session store is needed, and a
 * forged cookie fails signature verification. `SESSION_SECRET` failing to be
 * configured must fail CLOSED — signing must never fall back to a default.
 */
const COOKIE_NAME = "atp_session"
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

export async function setSessionCookie(userId: number): Promise<void> {
  const { value, maxAgeMs } = createSessionToken(userId)
  const store = await cookies()
  store.set(COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.set(COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 })
}

export async function getSessionUserId(): Promise<number | null> {
  const store = await cookies()
  return verifySessionToken(store.get(COOKIE_NAME)?.value)
}
