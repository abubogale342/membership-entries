'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const { createMemberRoutes } = require('./routes/members');
const { createWebhookRoutes } = require('./routes/webhooks');
const { createExportRoutes } = require('./routes/export');

function buildApp() {
  const app = express();

  // The webhook route needs the raw body for signature verification, so it is
  // mounted before the JSON parser rather than after it.
  app.use('/webhooks', createWebhookRoutes());

  app.use(express.json());
  app.use('/members', createMemberRoutes());
  app.use('/export', createExportRoutes());
  app.use(express.static(path.join(__dirname, '..', 'web')));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3100;
  buildApp().listen(port, () => {
    console.log(`listening on http://localhost:${port}`);

    // The subscription worker runs in this process by default so a demo needs
    // one terminal rather than two. In a real deployment it belongs in its own
    // process — it is long-running and retrying, and you want to scale and
    // restart it independently of the API. WORKER=off to separate them.
    if (process.env.WORKER !== 'off') {
      require('./worker').loop();
    }
  });
}

module.exports = { buildApp };
