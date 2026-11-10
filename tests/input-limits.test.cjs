// SPDX-License-Identifier: GPL-3.0-or-later
const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { Pool } = require('pg')
const { Harness, localDatabase, close } = require('./harness.cjs')
const { seed } = require('./fixtures.cjs')
before(require('./setup.cjs').setup)
after(close)

test('Worker body admission rejects declared, streamed and multipart oversize before parsing or resource access', async () => {
  const { MAX_REQUEST_BODY_BYTES: limit } = await import('../cloudflare/input-limits.mjs')
  let called = 0, canceled = 0
  const h = new Harness({ mocks: {
    '../.open-next/worker.js': { fetch: async request => { called++; return new Response(await request.text()) } },
    './limits.mjs': {},
  } })
  const worker = h.load('cloudflare/worker.mjs').default
  const invoke = request => worker.fetch(request, {}, { waitUntil() {} })
  const stream = () => new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(limit + 1)) },
    cancel() { canceled++ },
  })
  for (const headers of [{ 'content-length': String(limit + 1) }, {}, { 'content-length': '1' }]) {
    const response = await invoke(new Request('https://archivepool.test/api/report', {
      method: 'POST', body: stream(), duplex: 'half', headers,
    }))
    assert.equal(response.status, 413)
    assert.equal((await response.json()).error, 'payload_too_large')
  }
  const form = new FormData(); form.set('session', 'a'.repeat(limit + 1))
  assert.equal((await invoke(new Request('https://archivepool.test/submit', { method:'POST', body:form }))).status, 413)
  assert.equal(called, 0)
  assert.equal(canceled, 3)
  const text = 'a'.repeat(limit)
  const response = await invoke(new Request('https://archivepool.test/api/report', { method:'POST', body:text }))
  assert.equal(response.status, 200); assert.equal(await response.text(), text)
  assert.equal(called, 1)
})

test('stored source limits count UTF-8, exact boundaries and at-rest encoding before DB or upstream work', async () => {
  const { MAX_STORED_SOURCE_PAYLOAD_BYTES: limit, assertSourcePayloadSize } = await import('../cloudflare/input-limits.mjs')
  assert.doesNotThrow(() => assertSourcePayloadSize({ baseUrl:'a'.repeat(limit - 14) }))
  assert.throws(() => assertSourcePayloadSize({ baseUrl:'a'.repeat(limit - 13) }), /storage limit/)
  const h = new Harness()
  const crypto = h.load('lib/crypto.ts')
  for (const session of ['a'.repeat(limit), '🙂'.repeat(limit / 4), 'a'.repeat(13 * 1024)]) {
    assert.throws(() => crypto.encryptAtRest({ session, premium:true }), /storage limit/)
    const result = await h.run(async () => {
      await assert.rejects(h.load('lib/ingest.ts').ingestSource('amazon-music', 'account', { session, premium:true }), /storage limit/)
    })
    assert.equal(result.cost.sql, 0); assert.equal(result.cost.reads, 0); assert.equal(result.cost.fetch, 0)
  }
  assert.ok(Buffer.byteLength(JSON.stringify(crypto.encryptAtRest({session:'a'.repeat(10 * 1024),premium:true}))) <= limit)
})

test('anonymous admissions share a persisted UTC cap across isolates, including resubmissions', async () => {
  await seed({ accounts:0, instances:0 })
  const { BudgetLedger } = await import('../cloudflare/budget.mjs')
  const { ANONYMOUS_ADMISSIONS_PER_DAY: limit } = await import('../cloudflare/input-limits.mjs')
  let value
  const storage = { get:()=>value, put:next=>{ value=structuredClone(next) } }
  const namespace = { idFromName:()=> 'global', get:()=>({ open:async()=> {
    const ledger = new BudgetLedger(storage)
    return { reserve:(kind,cron)=>ledger.reserve(kind,cron), databaseUnavailable:()=>false, reportDatabaseUnavailable:()=>{} }
  } }) }
  for (let i=0;i<limit;i++) {
    const h = new Harness(); h.namespace = namespace
    const result = await h.run(()=>h.load('lib/ingest.ts').ingestSource('amazon-music','account',{session:`fixture-session-${i}`,premium:true}))
    assert.equal(result.value.saved,true)
    assert.equal(result.cost.fetch,0,'Amazon shape acceptance requires a separate admission cap')
  }
  const h = new Harness(); h.namespace=namespace
  const rejected = await h.run(async()=> {
    await assert.rejects(h.load('lib/ingest.ts').ingestSource('amazon-music','account',{session:'fixture-session-0',premium:true}), /daily anonymous submission limit/)
  })
  assert.equal(rejected.cost.sql,0)
  const p = new Pool({connectionString:localDatabase()})
  try { assert.equal(Number((await p.query('SELECT count(*) FROM account_entries')).rows[0].count),limit) }
  finally { await p.end() }
  const attributed = await h.run(()=>h.load('lib/ingest.ts').ingestSource('amazon-music','account',{session:'fixture-attributed-session',premium:true},{contributor:'fixture'}))
  assert.equal(attributed.value.saved,true)
  assert.equal(value.admissions,limit)
  let now=Date.now()+86400000
  const nextDay=new BudgetLedger(storage,()=>now)
  assert.equal(nextDay.reserve('admissions').amount,1)
  now+=1000
  assert.equal(new BudgetLedger(storage,()=>now).reserve('admissions').amount,1)
})

test('an anonymous admission remains spent when its database save fails', async () => {
  const { BudgetLedger } = await import('../cloudflare/budget.mjs')
  let value
  const ledger = new BudgetLedger({ get:()=>value, put:next=>{ value=structuredClone(next) } })
  const h = new Harness({ mocks:{
    '@/lib/db/ensure':{ ensureSchema:async()=>{} },
    '@/lib/db':{ db:{ insert:()=>({ values:()=>({ onConflictDoUpdate:async()=>{throw new Error('fixture save failure')} }) }) } },
  } })
  h.namespace = { idFromName:()=> 'global', get:()=>({open:async()=>({reserve:(kind,cron)=>ledger.reserve(kind,cron)})}) }
  await h.run(()=>assert.rejects(h.load('lib/ingest.ts').ingestSource('amazon-music','account',{session:'fixture-session-failure',premium:true}), /fixture save failure/))
  assert.equal(value.admissions,1)
  assert.equal(ledger.reserve('admissions').amount,1)
  assert.equal(value.admissions,2)
})

test('off Workers the anonymous admission bucket is atomic across concurrent requests and new isolates', async () => {
  await seed({accounts:0,instances:0})
  const { ANONYMOUS_ADMISSIONS_PER_DAY: limit } = await import('../cloudflare/input-limits.mjs')
  const results = await Promise.all(Array.from({length:limit+8},()=>{
    const h=new Harness({workers:false})
    return h.run(()=>h.load('lib/resource-budget.ts').reserveAnonymousAdmission()).then(()=>true,()=>false)
  }))
  assert.equal(results.filter(Boolean).length,limit)
  const h=new Harness({workers:false})
  await h.run(()=>assert.rejects(h.load('lib/resource-budget.ts').reserveAnonymousAdmission(), /daily anonymous submission limit/))
})

test('anonymous admission fails closed off Workers when its atomic database bucket is unavailable', async () => {
  const h = new Harness({ workers:false, mocks:{ '@/lib/rate-limit':{dbRateLimit:async()=>{throw new Error('fixture outage')}} } })
  await h.run(()=>assert.rejects(h.load('lib/resource-budget.ts').reserveAnonymousAdmission(), /daily anonymous submission limit/))
})
