'use strict';
const express = require('express');
const { pool } = require('../db/pool');
const { creditForPayment } = require('../lib/entries');
const { verifySignature } = require('../lib/signature');

const PAYMENT_EVENTS = new Set([
  'net.authorize.customer.subscription.created',
  'net.authorize.payment.authcapture.created',
]);

function createWebhookRoutes() {
  const router = express.Router();

  router.post('/authnet',
    express.raw({ type: '*/*' }),
    async (req, res, next) => {
      const raw = req.body; // Buffer

      if (!verifySignature(raw, req.get('X-ANET-Signature'))) {
        // 401, not 400: a bad signature is an authentication failure, and
        // Authorize.Net should not retry it.
        return res.status(401).json({ error: 'invalid signature' });
      }

      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'malformed json' });
      }

      const eventId = event.notificationId;
      const eventType = event.eventType;
      if (!eventId || !eventType) {
        return res.status(400).json({ error: 'missing notificationId or eventType' });
      }

      const client = await pool.connect();
      try {
        await client.query('begin');

        // Record the delivery. A redelivery conflicts here and returns no row,
        // which is how we know not to act on it a second time.
        const ins = await client.query(
          `insert into webhook_events (event_id, event_type, payload)
           values ($1, $2, $3)
           on conflict (event_id) do nothing
           returning event_id`,
          [eventId, eventType, event]
        );

        if (ins.rowCount === 0) {
          await client.query('commit');
          // 200, deliberately. This delivery was handled; telling the gateway
          // anything else invites it to keep retrying an event we already have.
          return res.json({ ok: true, duplicate: true, eventId });
        }

        let result = { credited: [] };

        if (PAYMENT_EVENTS.has(eventType)) {
          const subId = event.payload && (event.payload.id || event.payload.subscriptionId);
          const { rows } = await client.query(
            `select * from members where anet_subscription_id = $1 for update`,
            [String(subId)]
          );
          const member = rows[0];

          if (member) {
            await client.query(
              `update members set billing_status = 'active' where id = $1`,
              [member.id]
            );
            result = await creditForPayment({ member, sourceEvent: eventId }, client);
          }
        }

        if (eventType === 'net.authorize.customer.subscription.cancelled') {
          await client.query(
            `update members set billing_status = 'cancelled' where anet_subscription_id = $1`,
            [String(event.payload && event.payload.id)]
          );
        }

        if (eventType === 'net.authorize.payment.refund.created' ||
            eventType === 'net.authorize.payment.void.created') {
          await client.query(
            `update members set billing_status = 'past_due' where anet_subscription_id = $1`,
            [String(event.payload && event.payload.id)]
          );
        }

        await client.query(
          `update webhook_events set processed_at = now() where event_id = $1`,
          [eventId]
        );
        await client.query('commit');

        res.json({ ok: true, eventId, eventType, credited: result.credited || [] });
      } catch (err) {
        await client.query('rollback').catch(() => {});
        next(err);
      } finally {
        client.release();
      }
    });

  return router;
}

module.exports = { createWebhookRoutes };
