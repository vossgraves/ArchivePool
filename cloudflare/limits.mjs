// SPDX-License-Identifier: GPL-3.0-or-later
import { DurableObject, RpcTarget } from "cloudflare:workers"
import { BudgetLedger } from "./budget.mjs"

class ResourceLease extends RpcTarget {
  constructor(ledger) {
    super()
    this.ledger = ledger
  }
  reserve(kind, cron) { return this.ledger.reserve(kind, cron) }
  claimSchema(version) { return this.ledger.claimSchema(version) }
}

export class FreeTierBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    this.ledger = new BudgetLedger({
      get: () => {
        const row = ctx.storage.sql.exec("SELECT value FROM budget WHERE id = 1").toArray()[0]
        return row ? JSON.parse(row.value) : null
      },
      put: (value) => ctx.storage.sql.exec(
        "INSERT INTO budget (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
        JSON.stringify(value),
      ),
    })
  }
  open() { return new ResourceLease(this.ledger) }
}
