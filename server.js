require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const accountRoutes = require('./routes/account');
const { initDb } = require('./services/orderStore');
const { initCustomerDb } = require('./services/customers');
const { pollFastdealsOrders, autoRecoveryTick, addAlert, pauseForStock } = require('./services/fulfillment');
const { stockWatchTick } = require('./services/stockWatch');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

// Same-origin is the default. Only enable cross-origin requests when explicitly configured.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
}

// Small, dependency-free security headers. This is not a replacement for a full WAF,
// but it prevents common browser-side surprises in a simple single-origin deployment.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Both payment/provider webhooks must be verified against the exact raw bytes sent.
app.use('/api/webhook/paystack', express.raw({ type: 'application/json', limit: '256kb' }));
app.use('/api/webhook/datahustle', express.raw({ type: 'application/json', limit: '256kb' }));

// Everything else can be parsed as normal JSON with a deliberately small body limit.
app.use((req, res, next) => {
  if (req.path === '/api/webhook/paystack' || req.path === '/api/webhook/datahustle') return next();
  express.json({ limit: '32kb' })(req, res, next);
});

app.use('/api/admin', adminRoutes);
app.use('/api/services', require('./routes/services').pub);
app.use('/api/account', accountRoutes);
app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => initCustomerDb())
  .then(() => require('./services/serviceOrders').initServiceDb())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Abrants Data Store running on http://localhost:${PORT}`);
      // Tidy up unpaid checkouts: a couple of minutes after start, then every hour.
      const sweep = () => apiRoutes.sweepPendingOrders().catch((e) => console.warn('Pending sweep failed:', e.message));
      setTimeout(sweep, 2 * 60 * 1000).unref();
      setInterval(sweep, 60 * 60 * 1000).unref();
      // FastDealsGH has no webhook: re-check its unconfirmed orders every 2 minutes.
      const poll = () => pollFastdealsOrders().catch((e) => console.warn('FastDeals poll failed:', e.message));
      setInterval(poll, 2 * 60 * 1000).unref();
      // Out of stock handling: try the first provider again / reopen paused networks after an hour.
      const recover = () => autoRecoveryTick().catch((e) => console.warn('Auto recovery failed:', e.message));
      setInterval(recover, 5 * 60 * 1000).unref();
      // Early warning: look for a provider showing a network as out of stock (every 10 minutes).
      const watch = () => stockWatchTick(addAlert, pauseForStock).catch((e) => console.warn('Stock watch failed:', e.message));
      setTimeout(watch, 3 * 60 * 1000).unref();
      setInterval(watch, 10 * 60 * 1000).unref();
      // Result checkers and AFA: resend unanswered orders, follow AFA reviews, drop unpaid checkouts.
      const services = require('./services/serviceOrders');
      setInterval(() => services.tick().catch((e) => console.warn('Services tick failed:', e.message)), 2 * 60 * 1000).unref();
      setInterval(() => services.sweep().catch((e) => console.warn('Services sweep failed:', e.message)), 30 * 60 * 1000).unref();
      // Keep DataHustle's delivery updates switched on (it turns them off by itself after failures).
      const { webhookWatchTick } = require('./services/webhookWatch');
      const hook = () => webhookWatchTick(addAlert).catch((e) => console.warn('Webhook watch failed:', e.message));
      setTimeout(hook, 60 * 1000).unref();
      setInterval(hook, 10 * 60 * 1000).unref();
      if (process.env.DATAHUSTLE_MOCK_MODE === 'true') {
        console.log('DataHustle is in MOCK MODE - no real provider wallet purchase will be made.');
      }
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  });
