// SPDX-License-Identifier: GPL-3.0-or-later
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool, type PoolConfig } from "pg"
import { cfBindings, cfExecutionContext } from "@/lib/cf-env"
import { chargeResource, prepareResource } from "@/lib/resource-budget"
import * as schema from "./schema"

/**
 * Connection-pool bounds for serverless.
 *
 * `pg` defaults to 10 connections per pool with a 10 s idle timeout. On Vercel every warm function
 * instance owns its own pool, so a burst that fans out to N instances could hold N × 10 Neon
 * connections, and each idle one keeps the compute awake. These bounds keep a single instance to a
 * handful of short-lived connections that close as soon as the burst is over. The same reasoning
 * holds on Cloudflare Workers — except there the pool is per REQUEST (see below), so this cap is
 * really a per-request query-concurrency cap.
 *
 * POOL_DB_MAX_CONNECTIONS (2–20, default 3) lets a deployment raise the cap without a code change.
 */
export function poolOptions(env: Record<string, string | undefined> = process.env): PoolConfig {
  const configured = Number(env.POOL_DB_MAX_CONNECTIONS ?? 3)
  const max = Number.isInteger(configured) && configured >= 2 && configured <= 20 ? configured : 3
  return {
    max,
    min: 0,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    maxLifetimeSeconds: 60,
    allowExitOnIdle: true,
    statement_timeout: 20_000,
    query_timeout: 20_000,
    application_name: "archivepool",
  }
}

interface HyperdriveLike {
  connectionString?: string
}

/**
 * Where the pool connects, resolved per deployment:
 *  - Cloudflare Workers: the `HYPERDRIVE` binding's generated connection string (a
 *    postgres:// URL to the in-colo Hyperdrive endpoint, which pools real TCP
 *    connections to Neon for us). `pg` reaches it over a Workers socket
 *    (pg-cloudflare), never the public internet.
 *  - Everywhere else (Vercel, Railway, `next dev`): plain DATABASE_URL, as before.
 */
export function resolveConnectionString(): string | undefined {
  const hyperdrive = cfBindings()?.HYPERDRIVE as HyperdriveLike | undefined
  return hyperdrive?.connectionString ?? process.env.DATABASE_URL
}

/** True when either path can produce a connection string. */
export function databaseConfigured(): boolean {
  return Boolean(resolveConnectionString())
}

type DbBundle = { pool: Pool; db: NodePgDatabase<typeof schema> }

const globalForDb = globalThis as unknown as { __dbBundle?: DbBundle }
const requestBundles = new WeakMap<object, DbBundle>()

function createBundle(): DbBundle {
  const created = new Pool({ connectionString: resolveConnectionString(), ...poolOptions() })
  const connect = created.connect.bind(created)
  created.connect = ((callback?: (err: unknown, client?: unknown, release?: unknown) => void) => {
    const run = async () => { await prepareResource("sql"); return connect() }
    if (callback) { void run().then((client) => callback(null, client, client.release.bind(client)), callback); return }
    return run()
  }) as typeof created.connect
  // An idle client dropped mid-request (Neon restart, socket reaped by the runtime) emits on the
  // pool; without a listener that is an uncaught exception that kills the whole isolate.
  created.on("error", (err) => console.error("[db] idle client error:", err.message))
  created.on("connect", (client) => {
    const query = client.query.bind(client)
    client.query = ((...args: unknown[]) => {
      const callback = typeof args[args.length - 1] === "function" ? args.pop() as (err: unknown, result?: unknown) => void : null
      const run = async () => {
        await chargeResource("sql")
        return (query as (...params: unknown[]) => Promise<unknown>)(...args)
      }
      if (callback) { void run().then((result) => callback(null, result), callback); return }
      return run()
    }) as typeof client.query
  })
  return { pool: created, db: drizzle(created, { schema }) }
}

/**
 * Pool lifetime, per runtime.
 *
 * On Vercel/Railway/`next dev` one pool per warm instance (cached on globalThis) is right: a
 * socket outlives any single request and the pool amortizes TCP+SCRAM across a burst.
 *
 * On Workers that pooling would be a trap: the runtime closes every JS-created socket the moment
 * the request that opened it completes, so a pooled client reused on the NEXT request is dead —
 * the first query on it hangs until `query_timeout` (20 s) fires. Workers therefore get one pool
 * per request, keyed on the ExecutionContext — which has exactly the lifetime a Workers socket
 * is allowed to have. Reconnecting is cheap where it matters: through Hyperdrive the handshake
 * is an in-colo hop (the upstream Neon connection stays pooled on Cloudflare's side).
 */
function bundle(): DbBundle {
  const ctx = cfExecutionContext()
  if (!ctx) {
    globalForDb.__dbBundle ??= createBundle()
    return globalForDb.__dbBundle
  }
  let found = requestBundles.get(ctx)
  if (!found) {
    found = createBundle()
    requestBundles.set(ctx, found)
  }
  return found
}

/**
 * Deferred access to the pool/database.
 *
 * Module scope evaluates at isolate cold start — before bindings exist in env and before any
 * request context does — so the Pool cannot be created eagerly like it was for Vercel. These
 * proxies keep every call site (`db.select()`, `pool.connect()`) identical while resolving the
 * right bundle on first use inside a request.
 */
function lazy<T extends object>(load: () => T): T {
  return new Proxy({} as T, {
    get(_, prop) {
      const target = load()
      const value = Reflect.get(target, prop)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export const pool: Pool = lazy(() => bundle().pool)

export const db: NodePgDatabase<typeof schema> = lazy(() => bundle().db)
