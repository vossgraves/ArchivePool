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
  const {BudgetLedger,DAILY_LIMITS,ORDINARY_LIMITS,SQL_AWAKE_MS}=await import('../cloudflare/budget.mjs')
  let value; let now=Date.UTC(2026,10,10,0)
  const storage={get:()=>value,put:v=>{value=structuredClone(v)}}
  let ledger=new BudgetLedger(storage,()=>now)
  for(const kind of ['sql','reads','writes']) {
    let granted=0,ticket
    while((ticket=ledger.reserve(kind))) granted+=ticket.amount
    assert.equal(granted,ORDINARY_LIMITS[kind] ?? DAILY_LIMITS[kind])
    while((ticket=ledger.reserve(kind,true))) granted+=ticket.amount
    assert.equal(granted,DAILY_LIMITS[kind])
    ledger=new BudgetLedger(storage,()=>now)
    assert.equal(ledger.reserve(kind),null)
  }
  now+=86400000; assert.ok(ledger.reserve('sql'))
  // Sparse traffic also has a bounded conservative compute-awake allowance.
  for(let i=0;i<200;i++) {now+=7*60000;ledger.reserve('sql')}
  assert.ok(value.awake<=SQL_AWAKE_MS)
  assert.ok(ledger.claimSchema('test-version'))
  assert.equal(ledger.claimSchema('test-version'),false)
  now+=86400000
  ledger=new BudgetLedger(storage,()=>now)
  assert.ok(ledger.claimSchema('test-version'),'schema claims must reset even before the first allocation of a new UTC day')
})
test('SQL/KV guard fails closed when the shared coordinator denies admission', async () => {
  const h=new Harness();h.denyBudget=true
  const r=await h.run(async()=>{
    try {await h.load('lib/db/index.ts').db.execute(require('drizzle-orm').sql`select 1`)} catch(e){return e}
  })
  assert.equal(r.cost.sql,0)
  assert.match((r.value.cause ?? r.value).message,/budget unavailable/)
  assert.equal(r.cost.connections,0,'denial must precede the database handshake')
  const status=await h.route('/api/status')
  assert.equal(status.cost.sql,0);assert.equal(status.cost.reads,0)
})

test('credential leases never fall back to snapshots during a database outage', async () => {
  const h = new Harness(); await snapshots(h); h.failDb = true
  for (const route of ['/api/accounts', '/api/sources']) {
    await assert.rejects(h.route(route, 'GET', { auth: KEY, headers: { 'x-pool-client': 'v2' } }), /Failed query/)
  }
  const status = await h.route('/api/status')
  assert.equal(status.value.status, 200); assert.equal(status.cost.sql, 0)
  const discovery = await h.route('/api/discovery/tidal', 'GET', { auth: KEY })
  assert.equal(discovery.value.status, 200); assert.equal(discovery.cost.sql, 0)
})

test('a failed snapshot publication retains the last good durable copy', async () => {
  const h = new Harness(); await snapshots(h, { stale: true })
  const original = new Map(h.kv)
  h.failDb = true
  await h.run(async () => {
    await h.load('lib/edge-snapshot.ts').writeInstanceSnapshot()
    await h.load('lib/status-snapshot.ts').writeStatusSnapshot()
    await h.load('lib/discovery-key-snapshot.ts').writeDiscoveryKeySnapshot()
  })
  for (const [key, value] of original) assert.equal(h.kv.get(key), value)
})

test('cron authorization and batch clamps bound health and each sync entry point', async () => {
  await seed({ accounts: 0, instances: 1, stale: true })
  const h = new Harness({ check: true })
  for (const route of ['/api/cron/health', '/api/cron/monochrome', '/api/cron/purge-dead']) {
    const r = await h.route(route)
    assert.equal(r.value.status, 401); assert.equal(r.cost.sql + r.cost.reads + r.cost.fetch, 0)
  }
  const health = await h.route('/api/cron/health', 'GET', { auth: 'fixture-cron' })
  assert.equal(health.value.status, 200); assert.equal(health.cost.sql, 13)
  assert.equal(health.cost.writes, 3, 'finishing sweep publishes three snapshots once')
  h.fetch = async () => Response.json({ api: Array.from({ length: 30 }, (_, n) => `https://fixture-${n}.invalid`) })
  for (const feed of ['monochrome', 'spotiflac-tidal', 'spotiflac-qobuz']) {
    const r = await h.route('/api/cron/monochrome', 'GET', { auth: 'fixture-cron', query: `?feed=${feed}&limit=999999` })
    assert.equal(r.value.status, 200)
    const body = await r.value.json()
    assert.ok(body.checked <= 10); assert.ok(r.cost.sql <= 11); assert.equal(r.cost.writes, 0)
    assert.ok(r.cost.fetch <= 40)
  }
  const publish = await h.route('/api/cron/monochrome', 'GET', { auth: 'fixture-cron', query: '?publish=1' })
  assert.equal(publish.cost.sql, 1); assert.equal(publish.cost.writes, 1)
})

test('purge retains recent recovery evidence, expires ephemeral rows, and restarts removal grace on restore', async () => {
  await seed({ accounts: 1, instances: 1 })
  const p = new Pool({ connectionString: localDatabase() })
  try {
    await p.query("UPDATE account_entries SET status='dead', created_at=now()-interval '10 days' WHERE id IN (10,12)")
    await p.query("UPDATE account_entries SET expires_at=now()-interval '8 days', created_at=now()-interval '10 days' WHERE id=16")
    await p.query("INSERT INTO health_log(entry_id,ok,premium,checked_at) VALUES(10,true,true,now()), (12,true,true,now()-interval '40 days')")
    await p.query("INSERT INTO health_log(entry_id,ok,premium,checked_at,detail) VALUES(12,true,true,now(),'app report: not_premium')")
    await p.query("INSERT INTO audit_log(action,created_at) VALUES('fixture',now()-interval '100 days'), ('recent',now())")
    await p.query("INSERT INTO api_key_leases(key_id,entry_id,service,leased_at) VALUES(1,10,'tidal',now()-interval '4 days'), (1,12,'qobuz',now())")
    await p.query("INSERT INTO rate_limit_buckets VALUES('old',now()-interval '2 days',1), ('recent',now(),1)")
    await p.query("UPDATE api_key_requests SET created_at=now()-interval '100 days' WHERE id=1")
    await p.query("UPDATE github_claims SET created_at=now()-interval '100 days'")
    await p.query("UPDATE account_entries SET removed=true,removed_at=now()-interval '40 days' WHERE id=14")
    const h = new Harness()
    const restored = await h.route('/api/admin/remove', 'POST', { auth: 'fixture-admin', body: { id: 14, action: 'restore' } })
    assert.equal(restored.value.status, 200)
    await h.route('/api/admin/remove', 'POST', { auth: 'fixture-admin', body: { id: 14, action: 'remove' } })
    const purge = await h.route('/api/cron/purge-dead', 'GET', { auth: 'fixture-cron' })
    assert.equal(purge.value.status, 200); assert.ok(purge.cost.sql <= 16)
    const rows = (await p.query('SELECT id,removed FROM account_entries ORDER BY id')).rows
    assert.equal(rows.find(r => r.id === 10).removed, false, 'recent success protects a flapping account')
    assert.equal(rows.find(r => r.id === 12).removed, true, 'report markers cannot manufacture recovery evidence')
    assert.equal(rows.find(r => r.id === 16).removed, true, 'expired entries are eventually removed')
    assert.ok(rows.some(r => r.id === 14), 'restored then newly removed row gets a new grace period')
    for (const [table, predicate] of [
      ['health_log', "checked_at < now()-interval '30 days'"], ['audit_log', "created_at < now()-interval '90 days'"],
      ['api_key_leases', "leased_at < now()-interval '72 hours'"], ['rate_limit_buckets', "bucket='old'"],
      ['api_key_requests', 'id=1'], ['github_claims', 'id=1'],
    ]) assert.equal((await p.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${predicate}`)).rows[0].n, 0, table)
    const repeat = await h.route('/api/cron/purge-dead', 'GET', { auth: 'fixture-cron' })
    assert.equal((await repeat.value.json()).removed, 0); assert.equal(repeat.cost.sql, 13)
  } finally { await p.end() }
})

test('oversized upstream bodies are canceled and cannot persist a false verdict', async () => {
  await seed({ accounts: 0, instances: 1, stale: true })
  const h = new Harness()
  let canceled = false
  h.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(300 * 1024)) },
    cancel() { canceled = true },
  }))
  const r = await h.route('/api/cron/health', 'GET', { auth: 'fixture-cron', query: '?batch=8' })
  const body = await r.value.json()
  assert.equal(body.checked, 0); assert.equal(body.budgetExhausted, true)
  assert.equal(body.done, false); assert.equal(r.cost.sql, 1)
  assert.equal(canceled, true)
})

test('KV schema-marker outages cannot trigger SQL migrations', async () => {
  const h = new Harness(); h.failKv = true
  const r = await h.run(async () => {
    try { await h.load('lib/db/ensure.ts').ensureSchema() } catch (error) { return error }
  })
  assert.match(r.value.message,/KV quota fixture/)
  assert.equal(r.cost.sql,0); assert.equal(r.cost.connections,0)
})

test('retention caps health and audit row counts as well as their ages', async () => {
  await seed({ accounts:0,instances:0 })
  const p = new Pool({ connectionString:localDatabase() })
  try {
    await p.query('INSERT INTO health_log(entry_id,ok,premium) SELECT 1,true,true FROM generate_series(1,200001)')
    await p.query("INSERT INTO audit_log(action) SELECT 'fixture' FROM generate_series(1,50001)")
    const h = new Harness()
    const r = await h.run(()=>h.load('lib/retention.ts').purgeRetainedData())
    assert.equal(r.cost.sql,10)
    assert.equal((await p.query('SELECT count(*)::int AS n FROM health_log')).rows[0].n,200000)
    assert.equal((await p.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n,50000)
  } finally { await p.end() }
})
