#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Deterministic model of the batched-sweep fetch accounting in lib/cf-env.ts +
// lib/health-sweep.ts — reproduces the admission race that stalled an all-expensive
// queue, and verifies the fix (reserve a row's whole ceiling up front).
//
// Model:
//   chargeFetch()        -> used++; FetchBudgetExhausted once used reaches BUDGET
//   row ceiling (ALS)    -> row.remaining--; RowFetchBudgetExhausted at 0
//   admission, OLD       -> BUDGET - used >= CEILING          (no reservation)
//   admission, NEW       -> BUDGET - used - reserved >= CEILING; reserving CEILING
//                           up front, releasing the unspent share when the row ends
//
// A row "costs" N charged fetches before its check would return. In-flight rows
// charge one fetch per scheduling tick in worker order — the round-robin the event
// loop produces. A row killed by the request budget mid-check is UNCONSUMED (the
// verdict is tainted); a row killed by its own ceiling is consumed as `starved`.
//
// Run: node scripts/sim-fetch-budget.mjs   (exit 1 if any expectation fails)

const BUDGET = 40
const CEILING = 24
const WORKERS = 3
const MAX_ATTEMPTS = 12

function simulate({ costs, reserveOnAdmit }) {
  let used = 0
  let reserved = 0
  let i = 0
  let consumed = 0
  let checked = 0
  let starved = 0
  let budgetKilled = 0
  const queue = costs.map((cost, k) => ({ k, cost }))
  const active = []

  for (let tick = 0; tick < 10_000; tick++) {
    let progress = false

    // Admission phase: workers pull rows while headroom allows and caps hold.
    while (active.length < WORKERS && i < queue.length && consumed + active.length < MAX_ATTEMPTS) {
      const headroom = reserveOnAdmit ? BUDGET - used - reserved : BUDGET - used
      if (headroom < CEILING) break
      const row = queue[i++]
      if (reserveOnAdmit) reserved += CEILING
      active.push({ ...row, remaining: CEILING, spent: 0 })
      progress = true
    }
    if (active.length === 0) break

    // Charge phase: one charged fetch per in-flight row (worker order).
    for (const row of [...active]) {
      if (used >= BUDGET) {
        // FetchBudgetExhausted inside the check — tainted verdict, UNCONSUMED.
        active.splice(active.indexOf(row), 1)
        if (reserveOnAdmit) reserved -= row.remaining
        budgetKilled++
        progress = true
        continue
      }
      if (row.remaining <= 0) {
        // RowFetchBudgetExhausted — consumed as an explicit no-verdict skip.
        active.splice(active.indexOf(row), 1)
        consumed++
        starved++
        progress = true
        continue
      }
      used++
      row.remaining--
      row.spent++
      if (reserveOnAdmit) reserved--
      if (row.spent >= row.cost) {
        // Check returned a verdict — consumed.
        active.splice(active.indexOf(row), 1)
        if (reserveOnAdmit) reserved -= row.remaining
        consumed++
        checked++
      }
      progress = true
    }
    if (!progress) break
  }
  return { consumed, checked, starved, budgetKilled, cursorAdvances: consumed > 0 }
}

let failures = 0
function report(name, got, expect) {
  const ok = Object.entries(expect).every(([k, v]) => got[k] === v)
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  console.log(`     ${JSON.stringify(got)}`)
}

// The reported stall: 3 workers admit 3 expensive rows while all of them see 40
// fetches free, split the budget ~14/13/13, and all die unconsumed — attempted=0,
// cursor unchanged, done:false forever.
report(
  "old admission, 3 expensive rows (30 fetches each)",
  simulate({ costs: [30, 30, 30], reserveOnAdmit: false }),
  { consumed: 0, checked: 0, starved: 0, budgetKilled: 3, cursorAdvances: false },
)

// With the ceiling reserved at admission only one expensive row fits the budget at
// a time: it burns its 24-fetch ceiling, is consumed as `starved`, and the cursor
// moves. The next call's queue starts at row 2 — guaranteed progress per call.
report(
  "reserved admission, 3 expensive rows",
  simulate({ costs: [30, 30, 30], reserveOnAdmit: true }),
  { consumed: 1, checked: 0, starved: 1, budgetKilled: 0, cursorAdvances: true },
)

// One expensive row plus five cheap ones: the expensive row starves and is
// consumed; the cheap tail leads the next call (headroom no longer fits a ceiling).
report(
  "reserved admission, 1 expensive + 5 cheap rows",
  simulate({ costs: [30, 3, 3, 3, 3, 3], reserveOnAdmit: true }),
  { consumed: 1, checked: 0, starved: 1, budgetKilled: 0, cursorAdvances: true },
)

// Mid-cost rows self-limit by head-room: 6 rows at 3 fetches leave used=18, too
// little room for another full ceiling — the batch ends early and the cursor still
// advanced.
report(
  "reserved admission, 12 mid-cost rows (3 fetches each)",
  simulate({ costs: Array(12).fill(3), reserveOnAdmit: true }),
  { consumed: 6, checked: 6, starved: 0, budgetKilled: 0, cursorAdvances: true },
)

// All-cheap rows still flow: each reserves 24 but spends 1 and releases 23, so one
// worker drains the whole attempt cap — 12 consumed, all checked.
report(
  "reserved admission, 12 cheap rows (1 fetch each)",
  simulate({ costs: Array(12).fill(1), reserveOnAdmit: true }),
  { consumed: 12, checked: 12, starved: 0, budgetKilled: 0, cursorAdvances: true },
)

process.exit(failures === 0 ? 0 : 1)
