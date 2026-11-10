// SPDX-License-Identifier: GPL-3.0-or-later
const { Pool } = require('pg')
const { Harness, localDatabase } = require('./harness.cjs')
const { seed, snapshots, KEY, jwt } = require('./fixtures.cjs')

async function sql(query) {
  const p = new Pool({ connectionString: localDatabase() })
  try { await p.query(query) } finally { await p.end() }
}
function upstreamFixture(url, init) {
  if (url.includes('instances.json')) return Response.json({ api: Array.from({ length: 12 }, (_, n) => `https://fixture-${n}.invalid`) })
  if (url.includes('device_authorization')) return Response.json({ deviceCode: 'fixture-device', userCode: 'fixture-code', verificationUri: 'https://fixture.invalid', expiresIn: 600, interval: 5 })
  if (url.includes('oauth2/token')) return Response.json({ access_token: jwt(), refresh_token: 'R2', user: { countryCode: 'US', userId: 1 } })
  if (url.includes('github.com/login/oauth/access_token')) return Response.json({ access_token: 'fixture' })
  if (url.includes('api.github.com/user')) return Response.json({ id: 123, login: 'fixture' })
  if (url.includes('/user/login')) return Response.json({ user_auth_token: 'fixture', user: { id: 1, login: 'fixture' } })
  if (url.includes('bundle.js')) return new Response('app_secret:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
  if (url.endsWith('.com/') || url.endsWith('/login')) return new Response('<script src="/bundle.js"></script>')
  if (url.includes('/sessions')) return Response.json({ userId: 1, countryCode: 'US' })
  if (url.includes('/subscription')) return Response.json({ premiumAccess: true })
  if (url.includes('/getFileUrl')) return Response.json({ url: 'fixture', format_id: 27 })
  throw new Error(`Unexpected fixture URL: ${url}`)
}
const cases = []
function route(route, method, variants = [{ label: '', options: {} }], config = {}) {
  for (const variant of variants) cases.push({ name: `${method} ${route}${variant.label ? ' — ' + variant.label : ''}`, route, method,
    options: variant.options, ...config, ...variant.config })
}
const keyed = { auth: KEY, headers: { 'x-pool-client': 'v2' } }
const admin = { auth: 'fixture-admin' }
const cron = { auth: 'fixture-cron' }
for (const path of ['/api/accounts', '/api/sources']) route(path, 'GET', [
  { label: 'new lease', options: keyed },
  { label: 'repeat lease', options: keyed, config: { warm: true } },
  { label: 'six expired Tidal candidates', options: keyed, config: { seed: { accounts: 6, tidalExpired: true }, check: false } },
  { label: 'missing key', options: {} },
  { label: 'unknown key', options: { ...keyed, auth: 'atp_' + 'c'.repeat(48) } },
])
for (const path of ['/api/discovery/tidal', '/api/discovery/qobuz', '/api/instances/[service]']) route(path, 'GET', [
  { label: 'cold colo', options: { auth: KEY, params: { service: 'tidal' } } },
  { label: 'warm colo', options: { auth: KEY, params: { service: 'tidal' } }, config: { warm: true } },
  { label: 'unknown key', options: { auth: 'atp_' + 'c'.repeat(48), params: { service: 'tidal' } } },
])
route('/api/status', 'GET', [ { label: 'cold colo', options: {} }, { label: 'warm colo', options: {}, config: { warm: true } } ])
route('/api/report', 'POST', [
  { label: 'fresh account with replacement', options: { ...keyed, body: { id: 10, report: 'dead' } }, config: { leased: true, seed: { accounts: 6 } } },
  { label: 'fresh not_premium ignored', options: { ...keyed, body: { id: 10, report: 'not_premium' } } },
  { label: 'stale instance verification', options: { ...keyed, body: { id: 13, report: 'dead' } }, config: { seed: { stale: true } } },
  { label: 'unknown entry', options: { ...keyed, body: { id: 9999, report: 'dead' } } },
])
route('/api/cron/health', 'GET', [
  { label: 'eight checks', options: { ...cron, query: '?batch=8' }, config: { seed: { accounts: 0, instances: 25, stale: true } } },
  { label: 'finishing four checks', options: { ...cron, query: '?batch=8' }, config: { seed: { accounts: 0, instances: 1, stale: true } } },
  { label: 'no batch parameter', options: cron, config: { seed: { accounts: 0, instances: 25, stale: true } } },
])
route('/api/cron/monochrome', 'GET', [
  ...['monochrome','spotiflac-tidal','spotiflac-qobuz'].map(feed => ({ label: feed, options: { ...cron, query: `?feed=${feed}&limit=8` } })),
  { label: 'publish', options: { ...cron, query: '?publish=1' } },
  { label: 'no feed parameter', options: cron },
])
route('/api/cron/purge-dead', 'GET', [
  { label: 'no removals', options: cron },
  { label: 'removals and publication', options: cron, config: { prepare: () => sql("UPDATE account_entries SET status='dead',created_at=now()-interval '10 days'; UPDATE instance_entries SET status='dead',created_at=now()-interval '10 days'") } },
])
for (const path of ['/api/admin/audit','/api/admin/claims','/api/admin/keys','/api/admin/remove','/api/admin/requests','/api/admin/users']) route(path,'GET',[{options:admin}])
route('/api/admin/check-entry','POST',[{options:{...admin,body:{id:10}}}])
route('/api/admin/force-check','POST',[{options:admin}])
route('/api/admin/keys','POST',[{options:{...admin,body:{name:'fixture-new'}}}])
route('/api/admin/keys','PATCH',[{options:{...admin,body:{id:1,revoked:true}}}])
route('/api/admin/keys/custom','POST',[{options:{...admin,body:{name:'fixture-new',value:'atp_'+ 'd'.repeat(48)}}}])
route('/api/admin/keys/[id]','DELETE',[{options:{...admin,params:{id:'1'}}}])
route('/api/admin/remove','POST',[{options:{...admin,body:{id:10}}}])
route('/api/admin/purge-dead','POST',[{options:admin,config:{prepare:()=>sql("UPDATE account_entries SET status='dead'; UPDATE instance_entries SET status='dead'")}}])
route('/api/admin/purge-entry','POST',[{options:{...admin,body:{id:10}},config:{prepare:()=>sql('UPDATE account_entries SET removed=true WHERE id=10')}}])
route('/api/admin/requests/[id]','POST', ['approve','reject'].map(action=>({label:action,options:{...admin,params:{id:'1'},body:{action,note:'fixture rejection'}}})))
route('/api/admin/claims/[id]','POST', ['approve','reject'].map(action=>({label:action,options:{...admin,params:{id:'1'},body:{action,note:'fixture rejection'}}})))
route('/api/admin/users','PATCH',[{options:{...admin,body:{userId:2,role:'admin'}}}])
route('/api/auth/claim-legacy','POST', [
  {label:'pending review',options:{body:{username:'legacy'}},config:{session:true}},
  {label:'proof transfer',options:{body:{username:'legacy',apiKey:'atp_'+'b'.repeat(48)}},config:{session:true}},
])
route('/api/auth/github/start','GET')
route('/api/auth/github/callback','GET',[{label:'existing user',options:{query:'?code=fixture&state='},config:{oauth:true}},{label:'new user',options:{query:'?code=fixture&state='},config:{oauth:true,prepare:()=>sql('UPDATE users SET github_id=null WHERE id=1')}}])
route('/api/auth/login','POST')
route('/api/auth/signup','POST')
route('/api/auth/logout','POST')
route('/api/auth/me','GET',[{label:'anonymous',options:{}},{label:'signed in',options:{},config:{session:true}}])
route('/api/keys','GET',[{options:{},config:{session:true}}])
route('/api/keys','POST',[{options:{headers:{'user-agent':'fixture'},body:{subject:'fixture request',reason:'fixture request reason'}},config:{session:true}}])
route('/api/keys/[id]','DELETE',[{options:{params:{id:'1'}},config:{session:true}}])
route('/api/requests/[id]/claim','POST',[{options:{params:{id:'2'}},config:{session:true}}])
route('/api/tidal/device/start','POST')
route('/api/tidal/device/poll','POST',[{options:{body:{deviceCode:'fixture'}}}])
route('/api/qobuz/login','POST',[{options:{body:{username:'fixture',password:'fixture'}}}])
cases.push({ name: 'submit action — attributed instance', action: true, session: true })
for (const page of ['/', '/docs','/login','/signup','/admin','/submit','/dashboard']) cases.push({ name:`page ${page}`, page, session:page==='/submit'||page==='/dashboard' })

async function runCase(spec, { baseline = false } = {}) {
  await seed(spec.seed)
  await spec.prepare?.()
  const h = new Harness({ baseline, check: spec.check !== false })
  h.fetch = upstreamFixture
  await snapshots(h)
  if (spec.session) h.cookie = h.load('lib/sessions.ts').createSessionToken(1).value
  if (spec.leased) await h.route('/api/accounts','GET',keyed)
  let options = structuredClone(spec.options ?? {})
  if (spec.oauth) {
    const issued = await h.run(() => h.load('lib/github-auth.ts').issueOauthCookie())
    options.query += issued.value.state
    options.headers = { cookie: `atp_gh_oauth=${issued.value.cookieValue}` }
  }
  let call
  if (spec.action) {
    const action = h.load('app/actions/submit.ts').submitSource
    const form = new FormData()
    for (const [key,value] of Object.entries({ service:'tidal',kind:'api',baseUrl:'https://new-fixture.invalid',credit:'on' })) form.set(key,value)
    call = () => h.run(() => action({ok:false,message:''},form))
  } else if (spec.page) {
    const file = spec.page==='/' ? 'app/page.tsx' : `app${spec.page}/page.tsx`
    const page = h.load(file).default
    call = () => h.run(page)
  } else call = () => h.route(spec.route,spec.method,options)
  if (spec.warm) await call()
  return call()
}
module.exports = { cases, runCase, upstreamFixture, sql }
