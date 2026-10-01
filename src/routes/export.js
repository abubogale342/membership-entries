'use strict';
const express = require('express');
const { pool } = require('../db/pool');

/**
 * Quarterly export for the independent sweepstakes administrator.
 *
 * Two columns beyond the entry count matter more than they look: the ledger
 * row count and the generated timestamp. If the administrator ever queries a
 * number, the export has to be reproducible and traceable back to the rows
 * that produced it.
 */
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createExportRoutes() {
  const router = express.Router();

  router.get('/quarterly', async (req, res, next) => {
    const period = req.query.period;
    if (!/^\d{4}-Q[1-4]$/.test(period || '')) {
      return res.status(400).json({ error: 'period must look like 2027-Q2' });
    }
    try {
      const { rows } = await pool.query(
        `select m.email, m.tier, m.billing_status,
                sum(l.entries)::int as entries,
                count(l.id)::int    as ledger_rows
           from entry_ledger l join members m on m.id = l.member_id
          where l.period = $1
          group by m.email, m.tier, m.billing_status
          order by m.email asc`,
        [period]
      );

      const generatedAt = new Date().toISOString();
      const header = ['email', 'tier', 'billing_status', 'entries', 'ledger_rows', 'period', 'generated_at'];
      const body = rows.map(r => [
        r.email, r.tier, r.billing_status, r.entries, r.ledger_rows, period, generatedAt
      ].map(csvEscape).join(','));

      res.type('text/csv')
         .set('Content-Disposition', `attachment; filename="entries-${period}.csv"`)
         .send([header.join(','), ...body].join('\n') + '\n');
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createExportRoutes };
