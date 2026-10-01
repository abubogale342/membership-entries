'use strict';
/** Where every member and every queued subscription currently stands. */
require('dotenv').config();
const { pool } = require('../src/db/pool');

(async () => {
  const { rows } = await pool.query(`
    select m.email, m.tier, m.billing_status,
           m.anet_payment_profile_id as pay_id,
           m.anet_subscription_id    as sub_id,
           j.status, j.attempts, j.last_error,
           greatest(0, round(extract(epoch from (j.next_attempt_at - now()))))::int as due_in
      from members m
      left join subscription_jobs j on j.member_id = m.id
     order by m.created_at asc`);

  if (!rows.length) { console.log('\n  no members yet — run npm run demo\n'); await pool.end(); return; }

  console.log('');
  for (const r of rows) {
    const state = r.sub_id
      ? `subscribed ${r.sub_id}`
      : r.status === 'failed'
        ? 'GAVE UP'
        : `${r.status || 'no job'}, attempt ${r.attempts || 0}, due in ${r.due_in ?? '?'}s`;
    console.log(`  ${r.email}`);
    console.log(`    tier ${r.tier}   billing ${r.billing_status}`);
    console.log(`    payment profile id  ${JSON.stringify(r.pay_id)}`);
    console.log(`    subscription        ${state}`);
    if (!r.sub_id && r.last_error) {
      console.log(`    last error          ${r.last_error.slice(0, 120)}`);
    }
    console.log('');
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
