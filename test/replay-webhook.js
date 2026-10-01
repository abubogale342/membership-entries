'use strict';
/**
 * The proof.
 *
 * Authorize.Net retries any delivery it does not get a 2xx for, and a timeout
 * on our side produces a redelivery of an event we already handled. On a
 * platform where entries decide who wins a holiday, a double credit is not a
 * cosmetic bug.
 *
 * This fires the same signed notification eight times at once and asserts the
 * ledger gained exactly one row. Run it before and after removing the unique
 * constraint from entry_ledger to see the difference the database makes.
 */
require('dotenv').config();
const crypto = require('crypto');
const { pool } = require('../src/db/pool');
const { buildApp } = require('../src/app');

const CONCURRENCY = 8;

function sign(raw) {
  return crypto.createHmac('sha512', Buffer.from(process.env.ANET_SIGNATURE_KEY, 'hex'))
    .update(raw).digest('hex');
}

async function main() {
  if (!process.env.ANET_SIGNATURE_KEY) {
    console.error('ANET_SIGNATURE_KEY must be set (any hex string works for this test).');
    process.exit(1);
  }

  // A member on a tier that earns 50 entries per cycle.
  const email = `replay-${Date.now()}@example.test`;
  const subscriptionId = `sub_${Date.now()}`;
  const { rows } = await pool.query(
    `insert into members (email, tier, anet_subscription_id, billing_status)
     values ($1,'ambassador_monthly',$2,'pending') returning *`,
    [email, subscriptionId]
  );
  const member = rows[0];

  const notificationId = `evt_${Date.now()}`;
  const body = JSON.stringify({
    notificationId,
    eventType: 'net.authorize.payment.authcapture.created',
    payload: { id: subscriptionId },
  });
  const signature = sign(Buffer.from(body));

  const server = buildApp().listen(0);
  const port = server.address().port;

  const send = () => fetch(`http://127.0.0.1:${port}/webhooks/authnet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ANET-Signature': `sha512=${signature}` },
    body,
  }).then(r => r.json());

  // All eight in flight together, which is the case a sequential loop misses.
  const results = await Promise.all(Array.from({ length: CONCURRENCY }, send));
  server.close();

  const accepted = results.filter(r => r.ok && !r.duplicate).length;
  const duplicates = results.filter(r => r.duplicate).length;

  const { rows: ledger } = await pool.query(
    `select reason, entries from entry_ledger where member_id = $1 order by id`,
    [member.id]
  );
  const total = ledger.reduce((n, r) => n + r.entries, 0);

  console.log(`\n  deliveries sent        ${CONCURRENCY}`);
  console.log(`  processed as new       ${accepted}`);
  console.log(`  rejected as duplicate  ${duplicates}`);
  console.log(`  ledger rows created    ${ledger.length}`);
  console.log(`  entries credited       ${total}\n`);

  const pass = ledger.length === 1 && total === 50 && accepted === 1;
  if (!pass) {
    console.error(`FAIL  expected 1 ledger row worth 50 entries from 1 accepted delivery`);
    await pool.end();
    process.exit(1);
  }
  console.log('PASS  eight concurrent deliveries, one credit\n');

  await pool.query(`delete from entry_ledger where member_id = $1`, [member.id]);
  await pool.query(`delete from webhook_events where event_id = $1`, [notificationId]);
  await pool.query(`delete from members where id = $1`, [member.id]);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
