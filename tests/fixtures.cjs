// SPDX-License-Identifier: GPL-3.0-or-later
const { Pool } = require('pg')
const { Harness, localDatabase } = require('./harness.cjs')
process.env.POOL_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64')
process.env.POOL_CLIENT_KEY = Buffer.alloc(32, 2).toString('base64')
process.env.SESSION_SECRET = 'local-signed-session-fixture'
process.env.READ_KEYS_ENFORCED = 'true'
process.env.ADMIN_TOKEN = 'fixture-admin'
process.env.CRON_SECRET = 'fixture-cron'
process.env.GITHUB_CLIENT_ID = 'fixture-id'
process.env.GITHUB_CLIENT_SECRET = 'fixture-secret'
const KEY = 'atp_' + 'a'.repeat(48)
const jwt = (expired = false) => `header.${Buffer.from(JSON.stringify({exp: Math.floor(Date.now()/1000) + (expired ? -3600 : 3600)})).toString('base64url')}.sig`
async function seed({ tidalExpired = false, accounts = 3, instances = 10, stale = false } = {}) {
  const p = new Pool({ connectionString: localDatabase() })
  const h = new Harness()
  const { encryptAtRest } = h.load('lib/crypto.ts')
  const { hashKey } = h.load('lib/api-keys.ts')
  await p.query('TRUNCATE users, account_entries, instance_entries, api_keys, api_key_leases, api_key_requests, github_claims, audit_log, health_log, rate_limit_buckets, pool_state RESTART IDENTITY CASCADE')
  await p.query("INSERT INTO users(id,username,password_hash,github_id,github_login,role) VALUES (1,'fixture','github',123,'fixture','admin'), (2,'legacy','old',null,'','user')")
  await p.query("INSERT INTO api_keys(id,name,key_hash,prefix,user_id) VALUES(1,'app',$1,'atp_aaaaaa',1)", [hashKey(KEY)])
  let id = 10
  for (const service of ['tidal','qobuz','deezer','apple-music','amazon-music']) {
    for (let n = 0; n < accounts; n++) {
      const payload = encryptAtRest(service === 'tidal' ? {token: jwt(tidalExpired), refreshToken: 'spent-refresh', countryCode: 'US'} : service === 'qobuz' ? {token: 'fixture-token', appId: 'fixture-app', appSecret: 'fixture-secret', password: 'private'} : service === 'deezer' ? {arl: 'a'.repeat(192)} : service === 'apple-music' ? {token: '0.fixture'} : {session: 'fixture-session-123456',premium: true})
      await p.query("INSERT INTO account_entries(id,service,label,payload,fingerprint,status,premium,last_checked_at,contributor) VALUES($1,$2,$2,$3,$4,'alive',true,$5,'fixture')", [id++, service, payload, `${service}-${n}`, new Date(Date.now() - (stale ? 86400000 : 1000))])
    }
    if (service !== 'apple-music') for (let n = 0; n < instances; n++) {
      await p.query("INSERT INTO instance_entries(id,service,label,payload,fingerprint,status,premium,last_checked_at) VALUES($1,$2,$2,$3,$4,'alive',true,$5)", [id++,service,{baseUrl:`https://fixture-${service}-${n}.invalid`},`instance-${service}-${n}`,new Date(Date.now() - (stale ? 86400000 : 1000))])
    }
  }
  await p.query("SELECT setval('source_entry_id_seq', $1, false)",[id+100])
  await p.query("SELECT setval('users_id_seq', 100, false)")
  await p.query("SELECT setval('api_keys_id_seq', 100, false)")
  await p.end()
}
async function snapshots(h, { stale = false } = {}) {
  const savedAt = Date.now() - (stale ? 3 * 86400000 : 1000)
  const data = Object.fromEntries(['tidal','qobuz','deezer','apple-music','amazon-music'].map(s => [s,{streaming:[`https://fixture-${s}.invalid`],api:[`https://fixture-${s}.invalid`]}]))
  h.kv.set('pool/instances.json', JSON.stringify({ savedAt, data }))
  h.kv.set('pool/status.json', JSON.stringify({ savedAt, categories: [], history: {days:14,overall:[],categories:[]} }))
  h.kv.set('pool/discovery-keys.json', JSON.stringify({ savedAt, keys: { [h.load('lib/api-keys.ts').hashKey(KEY)]: {id:1,scope:null} } }))
}
module.exports = { seed, snapshots, KEY, jwt }
