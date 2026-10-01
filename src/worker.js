'use strict';
require('dotenv').config();
const { pool } = require('./db/pool');
const { claimNext, complete, fail } = require('./lib/jobs');
const { createSubscription } = require('./lib/authnet');
const { tier } = require('./lib/tiers');

/**
 * Starts the subscriptions that enrolment could not start synchronously.
 *
 * Safe to run more than one of these. The claim uses FOR UPDATE SKIP LOCKED,
 * so two workers never take the same job.
 */
async function tick() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claimed = await claimNext(client);
    if (!claimed) { await client.query('commit'); return false; }

    const { job, member } = claimed;
    // The gateway call happens after the claim is committed, so a slow or
    // hanging request does not hold a row lock open.
    await client.query('commit');

    const t = tier(member.tier);
    try {
      const sub = await createSubscription({
        name: `${t.label} ${t.cadence}`,
        amountCents: t.priceCents,
        cadence: t.cadence,
        customerProfileId: member.anet_customer_profile_id,
        paymentProfileId: member.anet_payment_profile_id,
      });
      await pool.query(
        `update members set anet_subscription_id = $2 where id = $1`,
        [member.id, sub.subscriptionId]
      );
      await complete(job.id);
      console.log(`  subscribed  ${member.email}  ${sub.subscriptionId}  (attempt ${job.attempts})`);
    } catch (err) {
      const msg = err.message || String(err);
      const r = await fail(job.id, job.attempts, msg);
      const why = err.anetCode === 'E00040'
        ? 'profile not visible to ARB yet'
        : msg;
      console.log(r.retrying
        ? `  retry in ${r.delaySeconds}s  ${member.email}  (attempt ${job.attempts}: ${why})`
        : `  GAVE UP    ${member.email}  after ${job.attempts} attempts: ${why}`);
    }
    return true;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function loop() {
  console.log('subscription worker running. ctrl-c to stop.\n');
  for (;;) {
    let worked = false;
    try { worked = await tick(); }
    catch (err) { console.error('  worker error:', err.message); }
    await new Promise(r => setTimeout(r, worked ? 250 : 3000));
  }
}

if (require.main === module) loop();
module.exports = { tick, loop };
