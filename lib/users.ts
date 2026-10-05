// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { and, desc, eq, gte } from "drizzle-orm"
import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

// OWASP-recommended scrypt parameters for interactive logins.
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64

export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${derived.toString("hex")}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":")
  if (parts.length !== 5) return false
  const [, r, p, saltHex, hashHex] = [parts[0], parts[1], parts[2], parts[3], parts[4]]
  const n = Number.parseInt(parts[0], 10)
  const rNum = Number.parseInt(r, 10)
  const pNum = Number.parseInt(p, 10)
  if (!Number.isFinite(n) || !Number.isFinite(rNum) || !Number.isFinite(pNum)) return false
  const salt = Buffer.from(saltHex, "hex")
  const expected = Buffer.from(hashHex, "hex")
  if (salt.length === 0 || expected.length === 0) return false
  const derived = await scrypt(password, salt, expected.length, { N: n, r: rNum, p: pNum })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

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

export async function createUser(username: string, password: string, ip = "", ua = "") {
  const passwordHash = await hashPassword(password)
  const [row] = await db
    .insert(users)
    .values({ username, passwordHash, createdIp: ip, createdUa: ua, lastLoginIp: ip, lastLoginUa: ua })
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
