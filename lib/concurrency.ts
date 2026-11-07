// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"

/**
 * Run [fn] over [items] with at most [limit] calls in flight, preserving result order.
 *
 * The pool fans out in a few places whose concurrency used to be bounded only by the input
 * size: refreshing the Tidal candidates a lease will serve, and the per-service snapshot read.
 * On Workers the practical ceilings are six simultaneous outbound connections per invocation
 * and 50 subrequests, so an unbounded `Promise.all` is both a provider-rate-limit amplifier
 * (Tidal answers `abuse_detected`) and a source of subrequest-limit failures. A small cap
 * makes the fan-out predictable without serialising it.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const width = Math.max(1, Math.min(Math.floor(limit), items.length))
  const results = new Array<R>(items.length)
  let next = 0

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}
