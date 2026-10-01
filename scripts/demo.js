'use strict';
/**
 * Enrol a few members so the audit view has something to show.
 *
 * Uses Authorize.Net's sandbox test card. Nothing here is real, and the card
 * number is the one their own testing guide publishes.
 */
require('dotenv').config();

const BASE = `http://localhost:${process.env.PORT || 3100}`;

// Authorize.Net sandbox test card. Any future expiry is accepted.
const CARD = { number: '4111111111111111', expiry: '2030-12', cvv: '123' };

const PRE_LAUNCH = {
  version: 'prelaunch-2026-09',
  emails: ['amelia.vip@example.test'],
};

// ARB requires a bill-to name on the payment profile, so enrolment collects one.
const PEOPLE = [
  { email: 'amelia.vip@example.test',   tier: 'ambassador_monthly',
    billTo: { firstName: 'Amelia', lastName: 'Rhodes' } },   // matches the VIP list
  { email: 'ben.patron@example.test',   tier: 'patron_monthly',
    billTo: { firstName: 'Ben',    lastName: 'Okafor' } },
  { email: 'chidi.annual@example.test', tier: 'explorer_annual',
    billTo: { firstName: 'Chidi',  lastName: 'Eze' } },      // gets the annual bonus
];

(async () => {
  // A raw ECONNREFUSED stack tells you nothing useful. Say what to do.
  try {
    await fetch(`${BASE}/health`);
  } catch {
    console.error(`\n  Nothing is listening on ${BASE}.`);
    console.error(`  Start the server first, in another terminal:\n`);
    console.error(`      npm start\n`);
    process.exit(1);
  }

  for (const p of PEOPLE) {
    const res = await fetch(`${BASE}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...p, card: CARD, preLaunchList: PRE_LAUNCH }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error(`  FAIL  ${p.email}  ${body.error || res.status}`);
      continue;
    }
    const vip = body.member.vipEarlyBird ? ' [VIP]' : '';
    const bonus = body.annualBonusCredited ? `  +${body.annualBonusCredited} annual bonus` : '';
    console.log(`  enrolled  ${p.email}  ${p.tier}${vip}${bonus}`);
  }
  console.log(`
  Cards are tokenised and members exist. Their subscriptions are queued:
  Authorize.Net's CIM profile is not visible to ARB for another 15-60 seconds.

  Watch the terminal running npm start: the worker will fail once with
  E00040, back off, and subscribe them on a later attempt.

  Then open ${BASE} to see the ledger.
`);
})().catch(e => { console.error(e); process.exit(1); });
