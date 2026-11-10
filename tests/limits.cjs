// SPDX-License-Identifier: GPL-3.0-or-later
const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { Pool } = require('pg')
const { Harness, close, localDatabase } = require('./harness.cjs')
const { seed, snapshots, KEY, jwt } = require('./fixtures.cjs')
before(require('./setup.cjs').setup)
after(close)
function ceiling(result, sql) {
  assert.ok(result.cost.sql <= sql, `${result.cost.sql} statements exceeds ${sql}:\n${result.sql.join('\n')}`)
  assert.equal(result.cost.writes, 0, 'read paths must not write KV')
  return result.value
}
test('hot feeds have fixed SQL ceilings with many pooled entries', async () => {
  await seed({accounts:12,instances:100})
  const h = new Harness()
  await snapshots(h)
  for (const route of ['/api/instances/[service]','/api/discovery/tidal','/api/discovery/qobuz']) {
    const result = await h.route(route, 'GET', {auth:KEY, params:{service:'tidal'}})
    const res = ceiling(result,0); assert.equal(res.status,200)
    assert.ok(result.cost.reads <= 2)
  }
  const status = await h.route('/api/status'); assert.equal(ceiling(status,0).status,200)
  const accounts = await h.route('/api/accounts','GET',{auth:KEY,headers:{'x-pool-client':'v2'}})
  const body = await ceiling(accounts,4).json()
  assert.equal(body.tidal.accounts.length,3)
  assert.equal(body.qobuz.accounts.length,3)
  assert.ok(!JSON.stringify(body).includes('password'))
  ceiling(await h.route('/api/accounts','GET',{auth:KEY,headers:{'x-pool-client':'v2'}}),2)
  ceiling(await h.route('/api/sources','GET',{auth:KEY,headers:{'x-pool-client':'v2'}}),4)
  ceiling(await h.route('/api/sources','GET',{auth:KEY,headers:{'x-pool-client':'v2'}}),4)
})
test('unknown and missing keys, invalid paths, and rate-limited reports reject early', async () => {
  const h = new Harness()
  for (const route of ['/api/accounts','/api/sources','/api/report','/api/discovery/tidal']) {
    const r=await h.route(route,route === '/api/report' ? 'POST':'GET',{headers:{'x-pool-client':'v2'}})
    assert.equal(ceiling(r,0).status,401)
  }
  const invalid=await h.route('/api/instances/[service]','GET',{params:{service:'invalid'}})
  assert.equal(ceiling(invalid,0).status,404)
  const req = new (require('next/server').NextRequest)('https://archivepool.test/api/report',{method:'POST',headers:{authorization:`Bearer ${KEY}`,'cf-connecting-ip':'192.0.2.1'},body:'{}'})
  const result=await h.run(async()=>{
    const limiter=h.load('lib/rate-limit.ts')
    for(let i=0;i<20;i++) limiter.rateLimit('report-ip:192.0.2.1',20,300000)
    return h.load('app/api/report/route.ts').POST(req)
  })
  assert.equal(ceiling(result,0).status,429)
  assert.ok(result.value.headers.get('retry-after'))
})
test('snapshots survive SQL outages and staleness; cache keys ignore URL/header variants', async () => {
  const h = new Harness(); await snapshots(h,{stale:true}); h.failDb=true
  const status=await h.route('/api/status','GET',{query:'?nonce=1'})
  assert.equal((await ceiling(status,0).json()).stale,true)
  const feed=await h.route('/api/instances/[service]','GET',{auth:KEY,params:{service:'tidal'},query:'?nonce=1'})
  const res=ceiling(feed,0); assert.equal((await res.clone().json()).stale,true)
  const etag=res.headers.get('etag')
  const repeat=await h.route('/api/discovery/tidal','GET',{auth:KEY,query:'?nonce=2',headers:{'cache-control':'no-cache','if-none-match':etag}})
  assert.equal(ceiling(repeat,0).status,304)
  assert.equal(repeat.cost.reads,0)
  const missing=new Harness(); missing.failDb=true
  const unavailable=await missing.route('/api/status')
  assert.equal(ceiling(unavailable,0).status,503); assert.ok(unavailable.value.headers.get('retry-after'))
})
test('renewed Tidal lease includes rotated refresh token, including replacement', async () => {
  await seed({tidalExpired:true,accounts:1,instances:0})
  const h=new Harness()
  h.fetch=async()=>new Response(JSON.stringify({access_token:jwt(),refresh_token:'rotated-refresh'}),{headers:{'content-type':'application/json'}})
  const r=await h.route('/api/accounts','GET',{auth:KEY,headers:{'x-pool-client':'v2'}})
  const body=await ceiling(r,8).json()
  const crypto=h.load('lib/crypto.ts')
  const credentials=crypto.decryptAtRest // client fields use a different key
  const {createDecipheriv}=require('node:crypto')
  function decrypt(value) { const [, , iv, ct]=value.split(':'); const bytes=Buffer.from(ct,'base64');const d=createDecipheriv('aes-256-gcm',crypto.deriveClientKey(KEY),Buffer.from(iv,'base64'));d.setAuthTag(bytes.subarray(-16));return Buffer.concat([d.update(bytes.subarray(0,-16)),d.final()]).toString() }
  assert.equal(decrypt(body.tidal.accounts[0].refreshToken),'rotated-refresh')
  assert.ok(!JSON.stringify(body).includes('spent-refresh'))
  const p=new Pool({connectionString:localDatabase()})
  await p.query("UPDATE account_entries SET payload=$1 WHERE service='tidal'",[crypto.encryptAtRest({token:jwt(true),refreshToken:'spent-again'})])
  await p.query("DELETE FROM api_key_leases WHERE entry_id IN (SELECT id FROM account_entries WHERE service='tidal')")
  await p.end()
  const replacement=await h.run(()=>h.load('lib/queries.ts').leaseReplacement('tidal',1,crypto.deriveClientKey(KEY),9999))
  assert.equal(decrypt(replacement.value.refreshToken),'rotated-refresh')
  assert.ok(replacement.cost.sql<=7)
})
test('sweep batch statement ceiling is independent of pool size', async () => {
  await seed({accounts:0,instances:100,stale:true})
  const h=new Harness({check:true})
  const r=await h.route('/api/cron/health','GET',{auth:'fixture-cron',query:'?batch=8'})
  assert.equal(r.value.status,200)
  const body=await r.value.json(); assert.equal(body.checked,8); assert.equal(body.done,false)
  assert.ok(r.cost.sql<=18,`${r.cost.sql} exceeds two reads + two writes/check`)
  assert.equal(r.cost.writes,0,'only finishing batches publish')
  const repeat=await h.route('/api/cron/health','GET',{auth:'fixture-cron',query:`?batch=8&cursor=${body.cursor}`})
  assert.ok(repeat.cost.sql<=18)
})
test('shared ledger persists bounds across colos, restarts and UTC rollover', async () => {
  const {BudgetLedger,DAILY_LIMITS,SQL_AWAKE_MS}=await import('../cloudflare/budget.mjs')
  let value; let now=Date.UTC(2026,10,10,0)
  const storage={get:()=>value,put:v=>{value=structuredClone(v)}}
  let ledger=new BudgetLedger(storage,()=>now)
  for(const kind of ['sql','reads','writes']) {
    let granted=0,ticket
    while((ticket=ledger.reserve(kind))) granted+=ticket.amount
    assert.equal(granted,DAILY_LIMITS[kind])
    ledger=new BudgetLedger(storage,()=>now)
    assert.equal(ledger.reserve(kind),null)
  }
  now+=86400000; assert.ok(ledger.reserve('sql'))
  // Sparse traffic also has a bounded conservative compute-awake allowance.
  for(let i=0;i<200;i++) {now+=7*60000;ledger.reserve('sql')}
  assert.ok(value.awake<=SQL_AWAKE_MS)
})
test('SQL/KV guard fails closed when the shared coordinator denies admission', async () => {
  const h=new Harness();h.denyBudget=true
  const r=await h.run(async()=>{
    try {await h.load('lib/db/index.ts').db.execute(require('drizzle-orm').sql`select 1`)} catch(e){return e}
  })
  assert.equal(r.cost.sql,0)
  assert.match((r.value.cause ?? r.value).message,/budget unavailable/)
  const status=await h.route('/api/status')
  assert.equal(status.cost.sql,0);assert.equal(status.cost.reads,0)
})
