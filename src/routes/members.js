'use strict';
const express = require('express');
const { pool } = require('../db/pool');
const { tier, TIERS } = require('../lib/tiers');
const { createCustomerProfile } = require('../lib/authnet');
const { enqueue } = require('../lib/jobs');
const { creditAnnualBonus, ledgerFor } = require('../lib/entries');

function createMemberRoutes() {
  const router = express.Router();

  router.get('/tiers', (_req, res) => res.json(TIERS));

  /**
   * Enrol a member: tokenise the card with CIM, start an ARB subscription,
   * record the member, decide VIP status once, and credit any annual bonus.
   */
  router.post('/', async (req, res, next) => {
    const { email, tier: tierCode, card, billTo, preLaunchList } = req.body || {};
    if (!email || !tierCode || !card) {
      return res.status(400).json({ error: 'email, tier and card are required' });
    }
    // Rejected here rather than six retries later: ARB will not accept a
    // payment profile without a billing name, even though CIM creates one.
    if (!billTo || !billTo.firstName || !billTo.lastName) {
      return res.status(400).json({
        error: 'billTo.firstName and billTo.lastName are required',
        why: 'Authorize.Net ARB rejects a subscription whose payment profile has no bill-to name',
      });
    }

    let t;
    try { t = tier(tierCode); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const client = await pool.connect();
    try {
      // The gateway calls happen before the transaction opens. Holding a
      // Postgres transaction open across a network call to a third party is
      // how connection pools get exhausted during an outage.
      const profile = await createCustomerProfile({ email, card, billTo });
      // The subscription is NOT started here. Authorize.Net's CIM profile is
      // not yet visible to ARB at this point and the call returns E00040. It
      // is queued instead and retried by the worker.

      // VIP qualification is decided once, here, and recorded with the list
      // version that produced it.
      const listVersion = (preLaunchList && preLaunchList.version) || 'none';
      const emails = (preLaunchList && preLaunchList.emails) || [];
      const matched = emails.map(e => String(e).toLowerCase()).includes(email.toLowerCase());

      await client.query('begin');

      const { rows } = await client.query(
        `insert into members (email, tier, vip_early_bird,
            anet_customer_profile_id, anet_payment_profile_id, anet_subscription_id,
            billing_status)
         values ($1,$2,$3,$4,$5,null,'pending')
         returning *`,
        [email, tierCode, matched,
         profile.customerProfileId, profile.paymentProfileId]
      );
      const member = rows[0];

      await client.query(
        `insert into vip_decisions (member_id, matched, list_version)
         values ($1,$2,$3) on conflict (member_id) do nothing`,
        [member.id, matched, listVersion]
      );

      // Enrolment is its own source event, so the bonus cannot be credited
      // again by any later replay.
      const bonus = await creditAnnualBonus(
        { member, sourceEvent: `enrolment:${member.id}` }, client
      );

      await enqueue(member.id, client);

      await client.query('commit');
      // 202, not 201: the member exists and their card is tokenised, but the
      // subscription is still pending. Saying 201 here would be a lie the
      // confirmation page would then have to tell the customer.
      res.status(202).json({
        member: { id: member.id, email: member.email, tier: member.tier,
                  vipEarlyBird: member.vip_early_bird,
                  subscriptionStatus: 'pending' },
        annualBonusCredited: bonus ? bonus.entries : 0,
      });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      if (err.anetCode) return res.status(402).json({ error: err.message, gateway: err.anetCode });
      next(err);
    } finally {
      client.release();
    }
  });

  /** A member's entry total and the rows that explain it. */
  router.get('/:id/entries', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`select * from members where id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'not found' });
      const ledger = await ledgerFor(req.params.id);
      res.json({
        member: { id: rows[0].id, email: rows[0].email, tier: rows[0].tier,
                  billingStatus: rows[0].billing_status, vipEarlyBird: rows[0].vip_early_bird },
        total: ledger.total,
        ledger: ledger.rows,
      });
    } catch (err) { next(err); }
  });

  router.get('/', async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        `select m.id, m.email, m.tier, m.billing_status, m.vip_early_bird,
                coalesce(sum(l.entries), 0)::int as entries
           from members m left join entry_ledger l on l.member_id = m.id
          group by m.id order by m.created_at desc`);
      res.json(rows);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createMemberRoutes };
