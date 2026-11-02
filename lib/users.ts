// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { and, desc, eq, gte } from "drizzle-orm"
import { db } from "@/lib/db"
import { ensureSchema } from "@/lib/db/ensure"
import { users } from "@/lib/db/schema"
import { deriveGithubUsernameCandidates } from "@/lib/github-cookies"

// scrypt hashing moved to lib/passwords.ts, which the web login routes import lazily
// — the Workers code path never loads it (see webLoginDisabled in lib/cf-env).

export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/

export function validateCredentials(username: string, password: string): string | null {
  if (!USERNAME_PATTERN.test(username)) {
    return "Username must be 3-24 characters: lowercase letters, digits, underscores."
  }
  if (password.length < 8 || password.length > 128) {
    return "Password must be 8-128 characters."
  }
  return null
}

export async function findUserByUsername(username: string) {
  await ensureSchema()
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1)
  return row ?? null
}

/**
 * Username for a session id, or null when the account no longer exists.
 * Used where only the id is at hand (server actions) and a public credit name is needed.
 */
export async function findUsernameById(userId: number): Promise<string | null> {
  await ensureSchema()
  const [row] = await db
    .select({ username: users.username, disabled: users.disabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row || row.disabled) return null
  return row.username
}

/**
 * Insert an account row. Callers supply the password hash — "github" for OAuth-only
 * accounts (never a valid scrypt string, so password verification can never succeed
 * for them) or the output of lib/passwords hashPassword for password accounts.
 */
export async function createUser(
  username: string,
  passwordHash: string,
  ip = "",
  ua = "",
  githubId: number | null = null,
  githubLogin = "",
) {
  await ensureSchema()
  const [row] = await db
    .insert(users)
    .values({ username, passwordHash, githubId, githubLogin, createdIp: ip, createdUa: ua, lastLoginIp: ip, lastLoginUa: ua })
    .returning({ id: users.id, username: users.username })
  return row
}

/** True when [err] is a Postgres unique-constraint violation (23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505"
}

/**
 * Create the account for a first-time GitHub sign-in — no username prompt. The
 * username is DERIVED from the GitHub login (deriveGithubUsernameCandidates):
 * the first free candidate wins, so a GitHub login can never silently take over
 * an existing account's name. Collisions get a gh_/numeric-suffixed variant;
 * the final fallback (github_<base36>) makes "every candidate taken"
 * unreachable in practice.
 *
 * Returns { user } on success, { conflict: "github_id" } when this GitHub
 * identity already has an account (a second tab completed first) — the caller
 * re-reads and signs that one in instead.
 */
export async function createGithubUser(
  githubId: number,
  githubLogin: string,
  ip = "",
  ua = "",
): Promise<{ user: { id: number; username: string } } | { conflict: "github_id" }> {
  await ensureSchema()
  const candidates = deriveGithubUsernameCandidates(githubLogin)
  candidates.push(`github_${(githubId % 36 ** 10).toString(36)}`)
  for (const username of candidates) {
    if (await findUserByUsername(username)) continue
    try {
      // "github" is never a valid scrypt string, so password verification can
      // never succeed on OAuth-only accounts.
      const user = await createUser(username, "github", ip, ua, githubId, githubLogin)
      return { user }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      // A unique violation on username retries with the next candidate; one on
      // github_id means this identity was linked between our read and insert.
    }
  }
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.githubId, githubId)).limit(1)
  if (existing) return { conflict: "github_id" }
  throw new Error("no free username candidate for GitHub sign-in")
}

export async function updateLastLogin(userId: number, ip: string, ua: string) {
  await ensureSchema()
  await db.update(users).set({ lastLoginIp: ip, lastLoginUa: ua }).where(eq(users.id, userId))
}

export async function countRecentUsersByIpUa(ip: string, ua: string, hours = 24): Promise<number> {
  if (!ip || !ua) return 0
  await ensureSchema()
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.createdIp, ip), eq(users.createdUa, ua), gte(users.createdAt, cutoff)))
  return rows.length
}

export async function isAdminUser(userId: number): Promise<boolean> {
  await ensureSchema()
  const [row] = await db
    .select({ role: users.role, disabled: users.disabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return Boolean(row) && !row.disabled && row.role === "admin"
}

export async function setUserRole(userId: number, role: "user" | "admin") {
  await ensureSchema()
  const [row] = await db
    .update(users)
    .set({ role })
    .where(eq(users.id, userId))
    .returning({ id: users.id, username: users.username, role: users.role })
  return row ?? null
}

/** Account list for the admin panel. Never selects password_hash. */
export async function listUsersForAdmin() {
  await ensureSchema()
  return db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      disabled: users.disabled,
      createdAt: users.createdAt,
      lastLoginIp: users.lastLoginIp,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
}
