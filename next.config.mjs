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
  images: {
    unoptimized: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }]
  },
}

export default nextConfig
