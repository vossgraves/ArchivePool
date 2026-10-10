// SPDX-License-Identifier: GPL-3.0-or-later
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool, type PoolConfig } from "pg"
import * as schema from "./schema"

/**
 * Connection-pool bounds for serverless.
 *
 * `pg` defaults to 10 connections per pool with a 10 s idle timeout. On Vercel every warm function
 * instance owns its own pool, so a burst that fans out to N instances could hold N × 10 Neon
 * connections, and each idle one keeps the compute awake. These bounds keep a single instance to a
 * handful of short-lived connections that close as soon as the burst is over.
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

const globalForDb = globalThis as unknown as { __pool?: Pool }

function createPool(): Pool {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ...poolOptions() })
  // An idle client dropped by Neon (scale-to-zero, pooler restart) emits on the pool; without a
  // listener that is an uncaught exception that kills the function instance.
  pool.on("error", (err) => console.error("[db] idle client error:", err.message))
  return pool
}

// Cached on globalThis in every environment so hot reloads in dev and repeated module evaluation
// in a warm serverless instance never open a second pool.
export const pool: Pool = (globalForDb.__pool ??= createPool())

export const db = drizzle(pool, { schema })
