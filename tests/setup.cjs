// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('node:fs')
const { Pool } = require('pg')
const { Harness, localDatabase, root } = require('./harness.cjs')
async function setup() {
  const pool = new Pool({connectionString:localDatabase()})
  await pool.query(fs.readFileSync(`${root}/scripts/schema.sql`,'utf8'))
  await pool.end()
  const h = new Harness({workers:false})
  await h.run(()=>h.load('lib/db/ensure.ts').ensureSchema())
}
module.exports = {setup}
