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

/**
 * Create the account for a first-time GitHub sign-in — no username prompt. The
 * username is DERIVED from the GitHub login (deriveGithubUsernameCandidates):
 * the first free candidate wins, so a GitHub login can never silently take over
 * an existing account's name. Collisions get a gh_/numeric-suffixed variant;
 * the final fallback (github_<base36>) makes "every candidate taken"
 * unreachable in practice.
 *
 * INSERT ... ON CONFLICT DO NOTHING decides atomicity at the row itself — a
 * pre-check SELECT would still race the unique index. A zero-row RETURNING is
 * ambiguous (username taken vs github_id taken), so the github_id lookup runs
 * next: a hit means a racing creation for the same GitHub identity already won
 * and the caller signs that user in ({ conflict: "github_id" }); a miss means
 * the username was taken and the next candidate is tried.
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
    const [row] = await db
      .insert(users)
      // "github" is never a valid scrypt string, so password verification can
      // never succeed on OAuth-only accounts.
      .values({ username, passwordHash: "github", githubId, githubLogin, createdIp: ip, createdUa: ua, lastLoginIp: ip, lastLoginUa: ua })
      .onConflictDoNothing()
      .returning({ id: users.id, username: users.username })
    if (row) return { user: row }
    const [winner] = await db.select({ id: users.id }).from(users).where(eq(users.githubId, githubId)).limit(1)
    if (winner) return { conflict: "github_id" }
  }
  throw new Error("no free username candidate for GitHub sign-in")
}

/**
 * Whether a session for [userId] should still be honoured. Stateless cookies
 * cannot be revoked, so resolution itself must refuse dead accounts: a missing,
 * disabled or claimed legacy row (claims mark it claimed_by + disabled) means
 * every outstanding session for it is over.
 */
export async function isSessionUserLive(userId: number): Promise<boolean> {
  await ensureSchema()
  const [row] = await db
    .select({ disabled: users.disabled, claimedBy: users.claimedBy })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return Boolean(row) && !row.disabled && row.claimedBy == null
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
