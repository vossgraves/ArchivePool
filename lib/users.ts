import "server-only"
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { eq } from "drizzle-orm"
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

export async function createUser(username: string, password: string) {
  const passwordHash = await hashPassword(password)
  const [row] = await db
    .insert(users)
    .values({ username, passwordHash })
    .returning({ id: users.id, username: users.username })
  return row
}
