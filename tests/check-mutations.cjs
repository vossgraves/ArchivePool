// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const cases = [
  ['at-rest migration', 'lib/health-sweep.ts', source => source
    .replace('  if (!hasPlaintextSecret(entry.payload)) return\n', '')
    .replace('and(eq(table.id, entry.id), sql`${table.payload} = ${JSON.stringify(entry.payload)}::jsonb`)', 'eq(table.id, entry.id)')],
  ['at-rest migration', 'lib/health-sweep.ts', source => source
    .replace('and(eq(table.id, entry.id), sql`${table.payload} = ${JSON.stringify(entry.payload)}::jsonb`)', 'eq(table.id, entry.id)')],
  ['Tidal session rejection', 'lib/health.ts', () => execFileSync('git', ['show', '3f7fa8b^:lib/health.ts'], { cwd: root, encoding: 'utf8' })],
  ['renewed Tidal lease', 'lib/queries.ts', source => source.replace('r.payload = encryptAtRest(fresh)', 'r.payload = encryptAtRest({ ...plain, token: fresh.token })'), 'tests/limits.test.cjs'],
  ['renewed Tidal lease', 'lib/queries.ts', source => source.replace('row.payload = encryptAtRest(fresh)', 'row.payload = encryptAtRest({ ...decryptAtRest(row.payload), token: fresh.token })'), 'tests/limits.test.cjs'],
  ['Tidal premium evidence', 'lib/health.ts', source => source.replace(
    /export function tidalSubscriptionIsPremium\(body: string\): boolean \{[\s\S]*?\n\}/,
    'export function tidalSubscriptionIsPremium(body: string): boolean { return /hi_res|hires|lossless|premium|hifi/.test(body.toLowerCase()) }')],
]
for (const [name, relative, mutate, testFile = 'tests/health-regressions.test.cjs'] of cases) {
  const file = path.join(root, relative)
  const source = fs.readFileSync(file, 'utf8')
  try {
    const old = mutate(source)
    if (old === source) throw new Error(`Mutation did not change ${relative}`)
    fs.writeFileSync(file, old)
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${name}`, testFile], { cwd: root, encoding: 'utf8' })
    if (result.status === 0 || !result.stdout.includes('AssertionError')) throw new Error(`Old behavior did not fail an assertion:\n${result.stdout}\n${result.stderr}`)
    process.stdout.write(`Confirmed assertion failure with old behavior: ${name}\n`)
  } finally { fs.writeFileSync(file, source) }
}
