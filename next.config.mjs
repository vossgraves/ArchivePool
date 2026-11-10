// SPDX-License-Identifier: GPL-3.0-or-later
import { MAX_REQUEST_BODY_BYTES } from "./cloudflare/input-limits.mjs"

/** @type {import('next').NextConfig} */

/**
 * Baseline response headers. None of these are required for the app to run; they are
 * defence-in-depth for the deployed site.
 *
 * `X-Frame-Options: SAMEORIGIN` is included deliberately because /admin is state-changing UI
 * (creating and revoking read keys, hard-removing entries), which makes clickjacking a real
 * concern. The pool status page is not intended to be embedded elsewhere.
 *
 * The CSP is intentionally Report-Only for now: an over-tight policy would break the live pool,
 * and report-only lets violations surface in the console first. Note that report-only ENFORCES
 * NOTHING -- it must be switched to `Content-Security-Policy` once the reports are clean.
 * `connect-src` has to keep covering the app's own origin for the admin fetches.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      // Next.js emits inline hydration scripts; a nonce is the real fix, so keep this
      // report-only rather than pretending 'unsafe-inline' is a policy.
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
]

const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: MAX_REQUEST_BODY_BYTES },
  },
  images: {
    unoptimized: true,
  },
  // pg lazily requires "pg-cloudflare" for its Workers socket, but that package's
  // exports map serves a stub (dist/empty.js) under the default condition — so the
  // file tracer only copies the stub while the Worker bundle (workerd condition)
  // resolves dist/index.js. Tracing-include the real files so the bundle finds them.
  outputFileTracingIncludes: {
    "*": ["./node_modules/pg-cloudflare/dist/**/*", "./node_modules/pg-cloudflare/esm/**/*"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
}

// Cloudflare build only (deploy:cf/build:cf set CF_BUILD=1): every
// import("@/lib/passwords") — login/signup's lazy scrypt module — is
// rewritten to lib/passwords.stub.ts, so scrypt and its node:crypto chunk
// never ship in the Worker bundle. The Vercel build leaves the real module
// untouched; Turbopack's resolveAlias matches the raw specifier before
// tsconfig-paths expansion, so it cannot be shadowed by the "@" prefix alias.
if (process.env.CF_BUILD === "1") {
  nextConfig.turbopack = {
    ...(nextConfig.turbopack ?? {}),
    resolveAlias: {
      ...(nextConfig.turbopack?.resolveAlias ?? {}),
      "@/lib/passwords": "./lib/passwords.stub.ts",
    },
  }
}

export default nextConfig
