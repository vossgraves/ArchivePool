// SPDX-License-Identifier: GPL-3.0-or-later
const assert = require('node:assert/strict')
const { test, after } = require('node:test')
const { PgDialect } = require('drizzle-orm/pg-core')
const { getTableName } = require('drizzle-orm')
const { Harness, close } = require('./harness.cjs')
const { jwt } = require('./fixtures.cjs')
after(close)

function mockDatabase(read, write = () => {}) {
  const updates = []
  function builder(operation, table, fields) {
    let values, where
    const b = {
      from(t) { table = t; return b },
      set(v) { values = v; return b },
      values(v) { values = v; return b },
      where(v) { where = v; return b },
      limit() { return b },
      returning() { return b },
      async execute() {
        if (operation === 'select') return read(getTableName(table), fields, where)
        const update = { table: getTableName(table), values, where }
        if (operation === 'update') updates.push(update)
        return write(operation, update) ?? [{ consecutiveFailures: 0, disabled: false }]
      },
      then(resolve, reject) { return b.execute().then(resolve, reject) },
      catch(reject) { return b.execute().catch(reject) },
    }
    return b
  }
  const db = {
    updates,
    select: fields => builder('select', undefined, fields),
    update: table => builder('update', table),
    insert: table => builder('insert', table),
    transaction: callback => callback(db),
  }
  return db
}

test('at-rest migration skips encrypted rows, compares plaintext snapshots, and verdicts never rewrite payload', async () => {
  let row
  const db = mockDatabase(table => table === 'account_entries' ? [row] : [])
  const h = new Harness({ workers: false, mocks: {
    '@/lib/db': { db }, '@/lib/db/ensure': { ensureSchema: async () => {} },
    '@/lib/health': { runCheck: async () => ({ ok: true, premium: true, status: 'alive', latencyMs: 1, detail: 'fixture' }) },
  }, expose: { 'lib/health-sweep.ts': ['migrateAtRest'] } })
  const crypto = h.load('lib/crypto.ts')
  const sweep = h.load('lib/health-sweep.ts')
  const plaintext = { token: jwt(), refreshToken: 'R1' }
  const encrypted = crypto.encryptAtRest(plaintext)
  row = { id: 1, service: 'tidal', kind: 'account', payload: encrypted, fingerprint: 'fixture', status: 'alive', premium: true,
    removed: false, disabled: false, consecutiveFailures: 0, lastCheckedAt: new Date(0), createdAt: new Date(0) }
  await h.run(() => sweep.__test.migrateAtRest(row))
  assert.equal(db.updates.length, 0, 'encrypted credentials must not be rewritten')
  await h.run(() => sweep.__test.migrateAtRest({ ...row, payload: plaintext }))
  assert.equal(db.updates.length, 1)
  const query = new PgDialect().sqlToQuery(db.updates[0].where)
  assert.match(query.sql, /"payload"\s*=\s*\$\d+::jsonb/)
  assert.ok(query.params.includes(JSON.stringify(plaintext)), 'CAS must compare the original plaintext snapshot')
  assert.notEqual(db.updates[0].values.payload.token, plaintext.token)
  db.updates.length = 0
  await h.run(() => sweep.runHealthSweep())
  await h.run(() => sweep.checkEntryById(1))
  assert.equal(db.updates.length, 2)
  for (const update of db.updates) assert.ok(!Object.hasOwn(update.values, 'payload'), 'verdict updates must leave rotated credentials intact')
})

test('Tidal session rejection spends R1 then the live R2 exactly once and yields a dead verdict', async () => {
  let payload = { token: jwt(true), refreshToken: 'R1' }
  let crypto
  const db = mockDatabase(table => table === 'pool_state' ? [] : [{ payload: crypto.encryptAtRest(payload), refreshInFlightUntil: null, refreshCooldownUntil: null, refreshBackoffMs: null }],
    (_operation, update) => {
      if (update.values?.payload) payload = crypto.decryptAtRest(update.values.payload)
      if (update.values?.refreshInFlightUntil) return [{ claim: update.values.refreshInFlightUntil, payload: crypto.encryptAtRest(payload) }]
      return []
    })
  const h = new Harness({ workers: false, mocks: { '@/lib/db': { db } } })
  crypto = h.load('lib/crypto.ts')
  const health = h.load('lib/health.ts')
  const spent = []
  const used = new Set()
  h.fetch = async (url, init) => {
    if (url.endsWith('/sessions')) return new Response('{}', { status: 401 })
    assert.ok(url.endsWith('/oauth2/token'), 'only fixture token/session requests are expected')
    const refresh = new URLSearchParams(init.body).get('refresh_token')
    spent.push(refresh)
    if (used.has(refresh)) return new Response('{"error":"invalid_grant"}', { status: 400 })
    assert.equal(refresh, `R${used.size + 1}`)
    used.add(refresh)
    return Response.json({ access_token: jwt(), refresh_token: `R${used.size + 1}` })
  }
  const result = await h.run(() => health.runCheck('tidal', 'account', { ...payload }, 'fixture'))
  assert.deepEqual(spent, ['R1', 'R2'])
  assert.equal(result.value.status, 'dead')
  assert.equal(result.value.skipped, false)
  assert.equal(payload.refreshToken, 'R3')
})

test('Tidal premium evidence handles wrong types, boolean priority, and unreadable bodies', () => {
  const h = new Harness({ workers: false, mocks: { '@/lib/db': { db: {} } } })
  const { tidalSubscriptionIsPremium: premium } = h.load('lib/health.ts')
  for (const body of [
    { premiumAccess: 'yes', subscription: { type: 'FREE' } },
    { premiumAccess: false, highestSoundQuality: 123 },
    { subscription: { type: 7 }, highestSoundQuality: 'HIGH' },
    { premiumAccess: false, highestSoundQuality: 'LOSSLESS' },
    { subscription: { type: 'FREE' }, highestSoundQuality: 'LOSSLESS' },
  ]) assert.equal(premium(JSON.stringify(body)), false, JSON.stringify(body))
  for (const body of [
    { premiumAccess: 'x', highestSoundQuality: 'LOSSLESS' },
    { premiumAccess: true, subscription: { type: 'FREE' }, highestSoundQuality: 'HIGH' },
    { highestSoundQuality: 'HI_RES_LOSSLESS' },
  ]) assert.equal(premium(JSON.stringify(body)), true, JSON.stringify(body))
  for (const body of ['not json', 'null', '42', '{}']) assert.equal(premium(body), true)
})

test('Qobuz repair follows the renewed fingerprint and updates only that credential', async () => {
  const {createHash}=require('node:crypto')
  const dialect=new PgDialect()
  let crypto, row
  const db=mockDatabase((table,_fields,where)=> table==='account_entries' && dialect.sqlToQuery(where).params.includes(row.fingerprint) ? [row] : [],
    (_operation, update)=>{
      if (update.table!=='account_entries' || !dialect.sqlToQuery(update.where).params.includes(row.fingerprint)) return []
      if (update.values.payload?.queryChunks) {
        row.payload.appSecret=JSON.parse(dialect.sqlToQuery(update.values.payload).params[0])
      } else if (update.values.payload) row.payload=update.values.payload
      if (update.values.fingerprint) row.fingerprint=update.values.fingerprint
      return update.values.refreshInFlightUntil ? [{claim:update.values.refreshInFlightUntil,payload:row.payload}] : []
    })
  const h=new Harness({workers:false,mocks:{'@/lib/db':{db},'./qobuz-oauth':{
    QOBUZ_LOGIN_APP_ID:'fixture-app',qobuzLogin:async()=>({userAuthToken:'fresh-token'}),scrapeQobuzAppSecret:async()=> 'new-secret',
  }}})
  crypto=h.load('lib/crypto.ts')
  const plain={token:'old-token',appId:'fixture-app',appSecret:'old-secret',username:'fixture',password:'fixture'}
  row={fingerprint:'old-fingerprint',payload:crypto.encryptAtRest(plain),refreshCooldownUntil:null,refreshInFlightUntil:null,refreshBackoffMs:null}
  h.fetch=async url=>{
    const u=new URL(url)
    if(u.pathname.endsWith('/user/get')) return u.searchParams.get('user_auth_token')==='old-token'
      ? new Response('{}',{status:401}) : Response.json({id:1,quality:'lossless'})
    assert.ok(u.pathname.endsWith('/track/getFileUrl'))
    const expected=createHash('md5').update(`trackgetFileUrlformat_id5intentstreamtrack_id5966783${u.searchParams.get('request_ts')}new-secret`).digest('hex')
    return u.searchParams.get('request_sig')===expected ? Response.json({url:'fixture'}) : new Response('InvalidRequestSignature',{status:400})
  }
  const result=await h.run(()=>h.load('lib/health.ts').runCheck('qobuz','account',{...plain},'old-fingerprint'))
  assert.equal(result.value.ok,true)
  assert.equal(crypto.decryptAtRest(row.payload).appSecret,'new-secret')
  assert.equal(crypto.decryptAtRest(row.payload).token,'fresh-token')
})
