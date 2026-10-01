'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');

(async () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    process.stdout.write(`applying ${f} ... `);
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log('ok');
  }
  await pool.end();
})().catch(err => { console.error(err.message); process.exit(1); });
