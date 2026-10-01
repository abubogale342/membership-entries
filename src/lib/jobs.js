'use strict';
const { pool } = require('../db/pool');

/**
 * A small durable queue, in Postgres, because the thing it exists to survive
 * is a delay on someone else's servers.
 *
 * The claim is the interesting part:
 *
 *   for update skip locked
 *
 * Two workers running the same query at the same instant do not both get the
 * same row — the second skips it rather than blocking on it. Without SKIP
 * LOCKED the second worker waits for the first to commit and then processes
 * the same job again. Without FOR UPDATE at all, both read it as pending and
 * both start a subscription, and the member is billed twice.
 */
async function enqueue(memberId, client = pool) {
  await client.query(
    `insert into subscription_jobs (member_id, next_attempt_at)
     values ($1, now() + interval '20 seconds')
     on conflict (member_id) do nothing`,
    [memberId]
  );
}

/** Claim one due job. Returns the job with its member, or null. */
async function claimNext(client) {
  const { rows } = await client.query(
    `update subscription_jobs j
        set status = 'running', attempts = attempts + 1, updated_at = now()
      where j.id = (
        select id from subscription_jobs
         where status = 'pending' and next_attempt_at <= now()
         order by next_attempt_at asc
         for update skip locked
         limit 1
      )
      returning j.*`
  );
  if (!rows[0]) return null;
  const job = rows[0];
  const { rows: m } = await client.query(`select * from members where id = $1`, [job.member_id]);
  return { job, member: m[0] };
}

async function complete(jobId, client = pool) {
  await client.query(
    `update subscription_jobs set status = 'done', last_error = null, updated_at = now()
      where id = $1`, [jobId]);
}

/**
 * Back off and try again, up to a point.
 *
 * E00040 during the propagation window is expected, not exceptional, so the
 * first few attempts are spaced seconds apart. After ten attempts — roughly
 * nine minutes — something other than propagation is wrong and a human should
 * look at it, so the job stops rather than retrying forever against a card
 * that may be declining.
 */
const MAX_ATTEMPTS = 10;

async function fail(jobId, attempts, message, client = pool) {
  if (attempts >= MAX_ATTEMPTS) {
    await client.query(
      `update subscription_jobs set status = 'failed', last_error = $2, updated_at = now()
        where id = $1`, [jobId, message]);
    return { retrying: false };
  }
  const delaySeconds = Math.min(15 * Math.pow(2, attempts - 1), 300);
  await client.query(
    `update subscription_jobs
        set status = 'pending', last_error = $2,
            next_attempt_at = now() + ($3 || ' seconds')::interval,
            updated_at = now()
      where id = $1`,
    [jobId, message, String(delaySeconds)]
  );
  return { retrying: true, delaySeconds };
}

module.exports = { enqueue, claimNext, complete, fail, MAX_ATTEMPTS };
