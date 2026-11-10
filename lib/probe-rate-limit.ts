// SPDX-License-Identifier: GPL-3.0-or-later
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit"

export function probeRateLimit(headers: Headers, scope: string, limit = 10): Response | null {
  const verdict = rateLimit(`probe:${scope}:${clientIp(headers)}`, limit, 5 * 60_000)
  return verdict.ok ? null : tooManyRequests(verdict.retryAfterSec, scope)
}
