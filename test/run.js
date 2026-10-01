'use strict';
/** Unit checks that need no database and no gateway. */
const assert = require('assert');
const { tier, periodFor, TIERS } = require('../src/lib/tiers');
const { verifySignature } = require('../src/lib/signature');
const crypto = require('crypto');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('\ntiers');
check('every tier code maps to a rule', () => {
  for (const code of Object.keys(TIERS)) assert.ok(tier(code).entriesPerCycle > 0);
});
check('an unknown tier throws rather than crediting zero', () => {
  assert.throws(() => tier('platinum_monthly'), /Unknown tier/);
});
check('monthly entry rates match the published table', () => {
  assert.strictEqual(tier('explorer_monthly').entriesPerCycle, 10);
  assert.strictEqual(tier('patron_monthly').entriesPerCycle, 25);
  assert.strictEqual(tier('ambassador_monthly').entriesPerCycle, 50);
});
check('only annual tiers carry a bonus', () => {
  for (const [code, t] of Object.entries(TIERS)) {
    if (t.cadence === 'monthly') assert.strictEqual(t.annualBonus, 0, code);
    else assert.ok(t.annualBonus > 0, code);
  }
});

console.log('\nperiods');
check('quarter boundaries', () => {
  assert.strictEqual(periodFor(new Date('2027-01-01T00:00:00Z')), '2027-Q1');
  assert.strictEqual(periodFor(new Date('2027-03-31T23:59:59Z')), '2027-Q1');
  assert.strictEqual(periodFor(new Date('2027-04-01T00:00:00Z')), '2027-Q2');
  assert.strictEqual(periodFor(new Date('2027-12-31T23:59:59Z')), '2027-Q4');
});

console.log('\nwebhook signature');
const KEY = '00112233445566778899aabbccddeeff';
process.env.ANET_SIGNATURE_KEY = KEY;
const raw = Buffer.from(JSON.stringify({ notificationId: 'evt_1' }));
const good = crypto.createHmac('sha512', Buffer.from(KEY, 'hex')).update(raw).digest('hex');
check('a correct signature verifies', () => {
  assert.strictEqual(verifySignature(raw, `sha512=${good}`), true);
});
check('a tampered body fails', () => {
  assert.strictEqual(verifySignature(Buffer.from('{"notificationId":"evt_2"}'), `sha512=${good}`), false);
});
check('a missing header fails rather than throwing', () => {
  assert.strictEqual(verifySignature(raw, undefined), false);
});
check('a short signature fails without throwing', () => {
  assert.strictEqual(verifySignature(raw, 'sha512=abcd'), false);
});

console.log('\ngateway id validation');
const { numericId } = require('../src/lib/authnet');
check('a bare id passes through', () => {
  assert.strictEqual(numericId('937280618', 'id'), '937280618');
});
check('quotes the SDK wraps around an id are stripped', () => {
  // This is the bug that produced:
  //   The value '"937280618"' is invalid ... numericString ... Pattern constraint failed
  assert.strictEqual(numericId('"937280618"', 'id'), '937280618');
});
check('surrounding whitespace is stripped', () => {
  assert.strictEqual(numericId('  937280618  ', 'id'), '937280618');
});
check('a number is coerced', () => {
  assert.strictEqual(numericId(937280618, 'id'), '937280618');
});
check('a non-numeric id throws here rather than as a schema error later', () => {
  assert.throws(() => numericId('abc', 'customerProfileId'), /not numeric/);
});
check('null throws', () => {
  assert.throws(() => numericId(null, 'customerProfileId'), /not numeric/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
