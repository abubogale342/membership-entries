'use strict';
const { pool } = require('../db/pool');
const { tier, periodFor } = require('./tiers');

/**
 * Credit entries once, for a given (member, period, reason, source event).
 *
 * ON CONFLICT DO NOTHING is the whole mechanism. The alternative most
 * codebases reach for is "check whether we already credited, then insert",
 * and that has a race in it: two workers handling the same redelivered
 * webhook both read "not yet credited" before either writes, and the member
 * ends up with double entries in a draw that has money attached to it.
 *
 * Returns the ledger row when this call was the one that credited, and null
 * when the credit already existed. The caller can tell the difference, which
 * matters for deciding whether to send a confirmation email.
 */
async function creditOnce({ memberId, period, entries, reason, sourceEvent }, client = pool) {
  const { rows } = await client.query(
    `insert into entry_ledger (member_id, period, entries, reason, source_event)
     values ($1, $2, $3, $4, $5)
     on conflict on constraint entry_ledger_idempotent do nothing
     returning id, member_id, period, entries, reason, source_event, created_at`,
    [memberId, period, entries, reason, sourceEvent]
  );
  return rows[0] || null;
}

/**
 * Apply everything a successful subscription payment earns.
 *
 * Each component is credited under its own reason, so the ledger explains
 * itself: 50 for the tier, 50 again for the VIP multiplier, 100 as an annual
 * bonus. A single combined number would be faster to write and impossible to
 * audit.
 */
async function creditForPayment({ member, sourceEvent, at = new Date() }, client = pool) {
  const t = tier(member.tier);
  const period = periodFor(at);
  const multiplier = Number(process.env.VIP_MULTIPLIER || 2);
  const vipUntil = process.env.VIP_EARLY_BIRD_UNTIL
    ? new Date(process.env.VIP_EARLY_BIRD_UNTIL)
    : null;

  const credited = [];

  const base = await creditOnce({
    memberId: member.id, period, entries: t.entriesPerCycle,
    reason: 'subscription_payment', sourceEvent,
  }, client);
  if (base) credited.push(base);

  // The multiplier applies only inside the promotional window, and only to
  // members whose VIP status was already decided and recorded.
  const inWindow = vipUntil ? at <= vipUntil : false;
  if (member.vip_early_bird && inWindow) {
    const bonus = await creditOnce({
      memberId: member.id, period,
      entries: t.entriesPerCycle * (multiplier - 1),
      reason: 'vip_multiplier', sourceEvent,
    }, client);
    if (bonus) credited.push(bonus);
  }

  return { period, credited, alreadyCredited: credited.length === 0 };
}

/** Credited once when an annual member enrols, never on renewal payments. */
async function creditAnnualBonus({ member, sourceEvent, at = new Date() }, client = pool) {
  const t = tier(member.tier);
  if (t.cadence !== 'annual' || t.annualBonus <= 0) return null;
  return creditOnce({
    memberId: member.id, period: periodFor(at),
    entries: t.annualBonus, reason: 'annual_bonus', sourceEvent,
  }, client);
}

async function ledgerFor(memberId) {
  const { rows } = await pool.query(
    `select period, entries, reason, source_event, created_at
       from entry_ledger where member_id = $1
      order by created_at asc, id asc`,
    [memberId]
  );
  const total = rows.reduce((n, r) => n + r.entries, 0);
  return { rows, total };
}

module.exports = { creditOnce, creditForPayment, creditAnnualBonus, ledgerFor };
