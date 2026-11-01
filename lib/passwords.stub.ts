// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Workers-bundle stub for lib/passwords.ts.
 *
 * The Cloudflare build (CF_BUILD=1, see next.config.mjs) rewrites every
 * import("@/lib/passwords") to this file, so scrypt and its node:crypto chunk
 * never reach the Worker — free-tier CPU could not afford the ~30-80 ms hash,
 * and the bundle size stays down. The Vercel build keeps the real module
 * untouched.
 *
 * The login/signup routes only lazy-import the module after a
 * webLoginDisabled() check that is always true on Workers, so reaching a call
 * here is impossible in production; throwing is a tripwire, not a code path.
 */

function unavailable(): never {
  throw new Error("web_login_unavailable: password hashing is not in the Workers bundle")
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function hashPassword(_password: string): Promise<string> {
  return unavailable()
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function verifyPassword(_password: string, _stored: string): Promise<boolean> {
  return unavailable()
}
