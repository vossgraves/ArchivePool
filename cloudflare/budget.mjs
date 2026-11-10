// SPDX-License-Identifier: GPL-3.0-or-later
export const DAILY_LIMITS = { sql: 80_000, reads: 80_000, writes: 32, probes: 8_000 }
export const SQL_AWAKE_MS = 10 * 60 * 60 * 1000
export const TICKET_MS = 20_000
const WAKE_MS = 6 * 60_000
const CHUNKS = { sql: 8, reads: 2, writes: 1, probes: 8 }

export class BudgetLedger {
  constructor(storage, now = Date.now) {
    this.storage = storage
    this.now = now
    this.state = storage.get() ?? {}
  }

  reserve(kind) {
    const now = this.now()
    const day = Math.floor(now / 86_400_000)
    if (this.state.day !== day) {
      this.state = { day, sql: 0, reads: 0, writes: 0, probes: 0, awake: 0, wakeUntil: 0, schema: {} }
    }
    const amount = CHUNKS[kind]
    if (!amount || this.state[kind] + amount > DAILY_LIMITS[kind]) return null
    const awake = kind === "sql" ? Math.max(0, now + WAKE_MS - Math.max(now, this.state.wakeUntil)) : 0
    if (this.state.awake + awake > SQL_AWAKE_MS) return null
    const next = { ...this.state, [kind]: this.state[kind] + amount, awake: this.state.awake + awake }
    if (kind === "sql") next.wakeUntil = now + WAKE_MS
    this.storage.put(next)
    this.state = next
    return { amount, day, expiresAt: now + TICKET_MS }
  }

  claimSchema(version) {
    // A failed rollout can retry tomorrow; cold isolates cannot repeat DDL today.
    if (this.state.schema?.[version]) return false
    const next = { ...this.state, schema: { ...this.state.schema, [version]: true } }
    this.storage.put(next)
    this.state = next
    return true
  }
}
