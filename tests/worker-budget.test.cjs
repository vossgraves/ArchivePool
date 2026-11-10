// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { Miniflare, convertV4MiniflareOptions } = require(require.resolve('miniflare', { paths: [require.resolve('wrangler/package.json')] }))

test('SQLite Durable Object RPC shares a persistent ledger and disposes its session', async () => {
  const root = path.resolve(__dirname, '..')
  const budget = fs.readFileSync(path.join(root, 'cloudflare/budget.mjs'), 'utf8').replace(/^export /gm, '')
  const limits = fs.readFileSync(path.join(root, 'cloudflare/limits.mjs'), 'utf8').replace('import { BudgetLedger } from "./budget.mjs"', '')
  const options = { cf: false,
    modules: true, compatibilityDate: '2025-10-11',
    durableObjects: { BUDGET: { className: 'FreeTierBudget', useSQLite: true } },
    script: `${budget}\n${limits}\nexport default { async fetch(request, env) {
      const lease = await env.BUDGET.get(env.BUDGET.idFromName('global')).open();
      try {
        const outage = await lease.databaseUnavailable();
        await lease.reportDatabaseUnavailable();
        return Response.json({ sql: await lease.reserve('sql', true), claim: await lease.claimSchema('fixture'), outage });
      }
      finally { lease[Symbol.dispose](); }
    } }`,
  }
  const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options)
  try {
    const first = await (await mf.dispatchFetch('http://fixture.invalid')).json()
    const second = await (await mf.dispatchFetch('http://fixture.invalid')).json()
    assert.equal(first.sql.amount, 8)
    assert.equal(second.sql.amount, 8)
    assert.equal(first.claim, true); assert.equal(second.claim, false)
    assert.equal(first.outage,false); assert.equal(second.outage,true)
  } finally { await mf.dispose() }
})
