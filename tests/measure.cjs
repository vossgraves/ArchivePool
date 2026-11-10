// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs')
const { close } = require('./harness.cjs')
const { cases, runCase } = require('./route-cases.cjs')
async function main() {
  await require('./setup.cjs').setup()
  const results = []
  for (const baseline of [true, false]) {
    for (const spec of cases) {
      const result = await runCase(spec, { baseline })
      const row = { name: spec.name, baseline, ...result.cost, cpuMs: Math.round(result.cpuMs*100)/100,
        status: result.value instanceof Response ? result.value.status : 'data' }
      results.push(row)
      process.stdout.write(JSON.stringify(row)+'\n')
    }
  }
  fs.writeFileSync('docs/route-costs.json', JSON.stringify({ measuredAt: new Date().toISOString().slice(0,10), environment: 'Node local Postgres 16 fixtures; CPU excludes Next rendering and is not Workers CPU', results }, null, 2)+'\n')
}
main().catch(err => { console.error(err); process.exitCode=1 }).finally(close)
