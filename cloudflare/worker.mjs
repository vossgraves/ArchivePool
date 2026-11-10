// SPDX-License-Identifier: GPL-3.0-or-later
import { AsyncLocalStorage } from "node:async_hooks"
import openNext from "../.open-next/worker.js"
import { boundedRequest } from "./input-limits.mjs"
export { FreeTierBudget } from "./limits.mjs"
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../.open-next/worker.js"

const key = Symbol.for("archivepool.resourceBudget")
const scope = globalThis[key] ??= new AsyncLocalStorage()

export default {
  ...openNext,
  async fetch(request, env, ctx) {
    const bounded = await boundedRequest(request)
    if (bounded instanceof Response) return bounded
    request = bounded
    const state = { namespace: env.FREE_TIER_BUDGET, env, tickets: {}, lease: null, cron: new URL(request.url).pathname.startsWith("/api/cron/") }
    const background = []
    const execution = new Proxy(ctx, {
      get(target, name) {
        if (name === "waitUntil") return (work) => { background.push(work); ctx.waitUntil(work) }
        const value = Reflect.get(target, name)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    state.context = execution
    return scope.run(state, async () => {
      try {
        const response = await openNext.fetch(request, env, execution)
        if (response.status === 429 || response.status === 503) {
          const headers = new Headers(response.headers)
          if (!headers.has("retry-after")) headers.set("retry-after", "60")
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
        }
        return response
      } finally {
        // waitUntil work uses the same scope and must finish before releasing its RPC session.
        if (state.lease) ctx.waitUntil(Promise.allSettled(background).then(async () => {
          const lease = await state.lease.catch(() => null)
          lease?.[Symbol.dispose]?.()
        }))
      }
    })
  },
}
