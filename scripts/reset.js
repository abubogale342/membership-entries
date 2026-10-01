'use strict';
/** Clear demo data. Only touches rows whose email ends in .test */
require('dotenv').config();
const { pool } = require('../src/db/pool');

(async () => {
  const { rows } = await pool.query(`select id, email from members where email like '%.test'`);
  if (!rows.length) { console.log('\n  nothing to clear\n'); await pool.end(); return; }
  const ids = rows.map(r => r.id);
  await pool.query(`delete from subscription_jobs where member_id = any($1)`, [ids]);
  await pool.query(`delete from entry_ledger     where member_id = any($1)`, [ids]);
  await pool.query(`delete from vip_decisions    where member_id = any($1)`, [ids]);
  await pool.query(`delete from members          where id = any($1)`, [ids]);
  console.log(`\n  cleared ${rows.length} demo members\n`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
