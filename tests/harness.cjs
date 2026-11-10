// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const vm = require('node:vm')
const ts = require('typescript')
const { AsyncLocalStorage } = require('node:async_hooks')
const { execFileSync } = require('node:child_process')
const pg = require('pg')
const root = path.resolve(__dirname, '..')
const sqlScope = new AsyncLocalStorage()
const resourceScope = globalThis[Symbol.for('archivepool.resourceBudget')] ??= new AsyncLocalStorage()
const requestScope = new AsyncLocalStorage()
const databases = new Set()
const compileCache = new Map()
const realFetch = globalThis.fetch
// No test may send HTTP to a streaming provider or a community host.
globalThis.fetch = async (...args) => {
  const state = requestScope.getStore()
  if (!state) throw new Error('Unexpected outbound HTTP outside a fixture request')
  state.cost.fetch++
  return state.h.fetch(...args)
}
function localDatabase() {
  const value = process.env.TEST_DATABASE_URL
  if (!value) throw new Error('TEST_DATABASE_URL must name the throwaway local Postgres')
  const u = new URL(value)
  if (u.hostname !== '127.0.0.1' || u.search || !u.port || u.port === '5432') throw new Error('Only a loopback database on a non-default port is allowed')
  return value
}
class CountingPool extends pg.Pool {
  constructor(options) {
    super({ ...options, connectionString: localDatabase() })
    databases.add(this)
    this.on('connect', (client) => {
      const connectionState = sqlScope.getStore()
      if (connectionState) {
        connectionState.cost.connections++
        client.connection.stream.on('data', chunk => { connectionState.cost.dbBytes += chunk.length })
      }
      const query = client.query.bind(client)
      client.query = (...args) => {
        const state = sqlScope.getStore()
        if (state) {
          const text = typeof args[0] === 'string' ? args[0] : args[0].text
          state.sql.push(text)
          state.cost.sql++
          if (state.h.failDb) return Promise.reject(new Error('Hyperdrive quota fixture'))
          const started = process.cpuUsage()
          const result = query(...args)
          state.driverCpuUs += process.cpuUsage(started).user
          return result
        }
        return query(...args)
      }
    })
  }
}
class Harness {
  constructor({ baseline = false, check = false, workers = true, mocks = {}, expose = {} } = {}) {
    this.mocks = mocks
    this.expose = expose
    this.baseline = baseline
    this.check = check
    this.workers = workers
    this.modules = new Map()
    this.kv = new Map()
    this.edge = new Map()
    this.cookie = undefined
    this.failDb = false
    this.fetch = async (url) => { throw new Error(`Missing fetch fixture: ${url}`) }
    this.kv.set('schema:applied', baseline ? '2026-11-06.1' : '2026-11-10.2')
    this.namespace = { idFromName: () => 'global', get: () => ({ open: async () => { requestScope.getStore().cost.rpc++; return ({
      reserve: async (kind) => this.denyBudget ? null : ({ amount: kind === 'sql' ? 8 : kind === 'reads' ? 2 : 1, day: Math.floor(Date.now()/86400000), expiresAt: Date.now() + 20000 }),
      claimSchema: async () => true,
      databaseUnavailable: async () => this.outage === true,
      reportDatabaseUnavailable: async () => { this.outage = true },
    }) } }) }
  }
  load(file) {
    file = path.resolve(root, file)
    if (!path.extname(file)) file += fs.existsSync(file + '.ts') ? '.ts' : fs.existsSync(file + '.tsx') ? '.tsx' : '/index.ts'
    if (this.modules.has(file)) return this.modules.get(file).exports
    const m = { exports: {} }
    this.modules.set(file, m)
    let source
    if (this.baseline) {
      try { source = execFileSync('git', ['show', `529addd:${path.relative(root,file)}`], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }) }
      catch { source = fs.readFileSync(file, 'utf8') }
    } else source = fs.readFileSync(file, 'utf8')
    const cacheKey = file + source
    let output = compileCache.get(cacheKey)
    if (!output) {
      output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
      compileCache.set(cacheKey, output)
    }
    if (this.expose[path.relative(root, file)]) output += `\nexports.__test = { ${this.expose[path.relative(root, file)].join(', ')} };`
    const requireFrom = Module.createRequire(file)
    const h = this
    function localRequire(name) {
      if (Object.hasOwn(h.mocks, name)) return h.mocks[name]
      if (name === 'server-only') return {}
      if (name === 'pg') return { ...pg, Pool: CountingPool }
      if (name === 'next/headers') return {
        cookies: async () => ({ get: () => h.cookie ? { value: h.cookie } : undefined, set: () => {} }),
        headers: async () => requestScope.getStore()?.headers ?? new Headers(),
      }
      if (name === 'next/cache') return { revalidatePath: () => {} }
      if (name.startsWith('@/components/')) return new Proxy({}, { get: () => () => null })
      if (name === '@opennextjs/cloudflare') return { getCloudflareContext: () => {
        if (!h.workers) throw new Error('not Workers')
        const state = requestScope.getStore()
        return { env: {
          HYPERDRIVE: { connectionString: localDatabase() },
          POOL_SNAPSHOTS: {
            get: async (key) => { state.cost.reads++; if (h.failKv) throw new Error('KV quota fixture'); return h.kv.get(key) ?? null },
            put: async (key, value) => { state.cost.writes++; h.kv.set(key, value) },
          },
        }, ctx: state?.ctx }
      } }
      if (name === '@/lib/health' && h.check) return {
        runCheck: async () => {
          h.load('lib/cf-env.ts').chargeFetch()
          const state = requestScope.getStore(); state.cost.fetch++
          return { ok: true, premium: true, status: 'alive', latencyMs: 1, detail: 'fixture' }
        },
        ensureFreshTidalCredential: async (payload) => payload,
        ensureFreshTidalToken: async (payload) => payload.token,
        isTidalAccessExpired: () => false,
        isTidalRefreshToken: () => false,
      }
      if (name.startsWith('@/')) return h.load(name.slice(2))
      if (name.startsWith('.')) return h.load(path.resolve(path.dirname(file), name))
      return requireFrom(name)
    }
    vm.runInThisContext(Module.wrap(output), { filename: file })(m.exports, localRequire, m, file, path.dirname(file))
    return m.exports
  }
  async run(callback, { headers = {} } = {}) {
  const state = { h: this, headers: new Headers(headers), cost: { sql: 0, reads: 0, writes: 0, matches: 0, puts: 0, fetch: 0, connections: 0, dbBytes: 0, rpc: 0 }, sql: [], driverCpuUs: 0, background: [], ctx: {} }
    state.ctx.waitUntil = (work) => state.background.push(work)
    globalThis.caches = { default: {
      match: async (req) => { state.cost.matches++; const body = this.edge.get(req.url); return body ? new Response(body) : undefined },
      put: async (req, res) => { state.cost.puts++; this.edge.set(req.url, await res.text()) },
    } }
    // Baseline ensureSchema uses this global cache; a harness represents a new isolate.
    delete globalThis.__poolSchemaEnsured
    delete globalThis.__dbBundle
    delete globalThis.__poolRateBuckets
    const start = process.cpuUsage()
    const wall = performance.now()
    const value = await requestScope.run(state, () => sqlScope.run(state, () => resourceScope.run(this.workers ? { namespace: this.namespace, lease: null, tickets: {} } : undefined, callback)))
    await Promise.allSettled(state.background)
    state.cpuMs = (process.cpuUsage(start).user + process.cpuUsage(start).system) / 1000
    state.wallMs = performance.now() - wall
    state.value = value
    return state
  }
  async route(route, method = 'GET', { body, auth, query = '', params = {}, headers = {} } = {}) {
    const { NextRequest } = require('next/server')
    const file = route.startsWith('app/') ? route : `app${route}/route.ts`
    const handler = this.load(file)[method]
    const h = { 'cf-connecting-ip': '192.0.2.1', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers }
    return this.run(() => handler(new NextRequest(`https://archivepool.test${route}${query}`, {
      method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), { params: Promise.resolve(params) }), { headers: h })
  }
}
async function close() {
  await Promise.all([...databases].map((pool) => pool.end()))
  globalThis.fetch = realFetch
}
module.exports = { Harness, close, localDatabase, root }
