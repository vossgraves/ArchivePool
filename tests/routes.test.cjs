// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { Harness, close } = require('./harness.cjs')
const { cases, runCase } = require('./route-cases.cjs')
const measured = require('../docs/route-costs.json').results.filter(row => !row.baseline)
before(require('./setup.cjs').setup)
after(close)

test('every API method and data-reading page has a reproducible cost measurement', () => {
  for (const file of fs.readdirSync(path.resolve(__dirname,'../app/api'), { recursive:true }).filter(file => file.endsWith('route.ts'))) {
    const source = fs.readFileSync(path.resolve(__dirname,'../app/api',file),'utf8')
    const route = '/api/'+file.replace(/\/route\.ts$/,'')
    for (const method of source.matchAll(/export async function (GET|POST|PATCH|DELETE|PUT|OPTIONS|HEAD)\(/g)) {
      assert.ok(cases.some(c => c.route===route && c.method===method[1]), `${method[1]} ${route} lacks a measured fixture`)
    }
  }
  for (const name of ['page /dashboard','page /submit','submit action — attributed instance']) assert.ok(measured.some(row=>row.name===name))
})

test('route, action, and page fixtures stay within their measured resource ceilings', async () => {
  for (const spec of cases) {
    const expected = measured.find(row=>row.name===spec.name)
    assert.ok(expected, spec.name)
    const result = await runCase(spec)
    for (const resource of ['sql','reads','writes','matches','puts','fetch']) {
      assert.ok(result.cost[resource] <= expected[resource], `${spec.name}: ${resource} ${result.cost[resource]} exceeds ${expected[resource]}`)
    }
    if (result.value instanceof Response) {
      assert.equal(result.value.status, expected.status, spec.name)
      if ([429,503].includes(result.value.status)) assert.ok(result.value.headers.get('retry-after'),spec.name)
    }
    assert.ok(result.cost.fetch + result.cost.matches + result.cost.puts <= 50, spec.name)
  }
})

test('schema bootstrap is measured once and an outage cannot publish a usable marker', async () => {
  const h = new Harness()
  h.kv.delete('schema:applied')
  const refused = await h.run(async()=> {
    try { await h.load('lib/db/ensure.ts').ensureSchema() } catch (error) { return error }
  })
  assert.match(refused.value.message,/budget unavailable/)
  assert.equal(refused.cost.sql,0); assert.equal(refused.cost.connections,0)
  const operator = new Harness({workers:false})
  const first = await operator.run(()=>operator.load('lib/db/ensure.ts').ensureSchema())
  assert.equal(first.cost.sql,74,'operator bootstrap includes DDL and legacy-copy verification')
  h.kv.set('schema:applied',h.load('lib/db/ensure.ts').SCHEMA_VERSION)
  const repeat = await h.run(()=>h.load('lib/db/ensure.ts').ensureSchema())
  assert.equal(repeat.cost.sql,0); assert.equal(repeat.cost.reads,1); assert.equal(repeat.cost.writes,0)
  const failed = new Harness(); failed.kv.delete('schema:applied'); failed.failDb=true
  await assert.rejects(failed.run(()=>failed.load('lib/db/ensure.ts').ensureSchema()), /budget unavailable/)
  assert.equal(failed.kv.get('schema:applied'),undefined)
})
