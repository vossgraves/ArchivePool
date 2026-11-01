// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { and, desc, eq, gte } from "drizzle-orm"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"

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
) {
  const [row] = await db
    .insert(users)
    .values({ username, passwordHash, githubId, createdIp: ip, createdUa: ua, lastLoginIp: ip, lastLoginUa: ua })
    .returning({ id: users.id, username: users.username })
  return row
}

export async function updateLastLogin(userId: number, ip: string, ua: string) {
  await db.update(users).set({ lastLoginIp: ip, lastLoginUa: ua }).where(eq(users.id, userId))
}

export async function countRecentUsersByIpUa(ip: string, ua: string, hours = 24): Promise<number> {
  if (!ip || !ua) return 0
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.createdIp, ip), eq(users.createdUa, ua), gte(users.createdAt, cutoff)))
  return rows.length
}

export async function isAdminUser(userId: number): Promise<boolean> {
  const [row] = await db
    .select({ role: users.role, disabled: users.disabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return Boolean(row) && !row.disabled && row.role === "admin"
}

export async function setUserRole(userId: number, role: "user" | "admin") {
  const [row] = await db
    .update(users)
    .set({ role })
    .where(eq(users.id, userId))
    .returning({ id: users.id, username: users.username, role: users.role })
  return row ?? null
}

/** Account list for the admin panel. Never selects password_hash. */
export async function listUsersForAdmin() {
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
