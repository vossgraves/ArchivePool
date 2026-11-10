// SPDX-License-Identifier: GPL-3.0-or-later
import "server-only"
import type { AsyncLocalStorage } from "node:async_hooks"
import { cfBindings } from "@/lib/cf-env"

type Resource = "sql" | "reads" | "writes" | "probes"
type Ticket = { amount: number; day: number; expiresAt: number }
interface Lease {
  reserve(kind: Resource): Promise<Ticket | null>
  claimSchema(version: string): Promise<boolean>
}
interface BudgetScope {
  namespace?: { idFromName(name: string): unknown; get(id: unknown): { open(): Promise<Lease> } }
  lease: Promise<Lease> | null
  tickets: Partial<Record<Resource, Ticket>>
  pending?: Promise<void>
}

export class ResourceUnavailable extends Error {
  constructor() { super("Free-tier resource budget unavailable; retry later") }
}

function scope(): BudgetScope | null {
  if (!cfBindings()) return null
  const storage = (globalThis as Record<symbol, unknown>)[Symbol.for("archivepool.resourceBudget")] as
    AsyncLocalStorage<BudgetScope> | undefined
  const state = storage?.getStore()
  if (!state?.namespace) throw new ResourceUnavailable()
  return state
}

function lease(state: BudgetScope): Promise<Lease> {
  state.lease ??= Promise.resolve(state.namespace!.get(state.namespace!.idFromName("global-v1")).open())
  return state.lease
}

export async function chargeResource(kind: Resource): Promise<void> {
  return allocate(kind, true)
}

export async function prepareResource(kind: Resource): Promise<void> {
  return allocate(kind, false)
}

async function allocate(kind: Resource, spend: boolean): Promise<void> {
  const state = scope()
  if (!state) return
  // Serialize allocation within one request; parallel Drizzle queries share its tickets.
  const previous = state.pending ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    const now = Date.now()
    let ticket = state.tickets[kind]
    if (!ticket || ticket.amount === 0 || ticket.day !== Math.floor(now / 86_400_000) || ticket.expiresAt <= now) {
      ticket = (await (await lease(state)).reserve(kind)) ?? undefined
      if (!ticket) throw new ResourceUnavailable()
      state.tickets[kind] = ticket
    }
    if (spend) ticket.amount--
  })
  state.pending = operation
  try { await operation } catch { throw new ResourceUnavailable() }
}

export async function claimSchemaMigration(version: string): Promise<boolean> {
  const state = scope()
  return state ? (await lease(state)).claimSchema(version) : true
}
