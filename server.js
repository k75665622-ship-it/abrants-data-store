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
  // Content Security Policy. Our pages load only our own scripts and talk only to our own API,
  // so if a bug ever let someone slip in a <script>, the browser would refuse to run it or let it
  // send data anywhere. Google Fonts is allowed because the pages load fonts from there; inline
  // style="" attributes are allowed because a few pages use them (styles can't steal data the way
  // scripts can). Payment is a normal redirect to Paystack, which a page navigation is free to do.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "script-src 'self'",
    "connect-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
  ].join('; '));
  // Keep this page in its own browsing context, so another site that opens it cannot poke at it.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // In production (served over HTTPS on Render), tell browsers to only ever use HTTPS for this site.
  // Never sent in local development, which runs over plain http.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Visitors on the Render address go to the real domain (only if SITE_URL is set; see README 23).
app.use(require('./services/siteUrl').redirectToSite());

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
// Pages that are gone: bill payments (removed) and the get-started page (now part of the home page).
// Old links open the store; the browser keeps a #section, so /welcome.html#afa lands on the AFA section.
app.get(['/bills.html', '/welcome.html'], (req, res) => res.redirect(302, '/'));
app.use(express.static(path.join(__dirname, 'public')));

// Tracking links: abrantsdata.com/k7m2x. A saved code leaves a short-lived note (cookie) for track.js and the
// visitor lands on the clean home page, so the address bar shows nothing special. The codes are held in memory, so
// opening a link never reads the database (README 22). Anything else falls through to "not found".
const campaigns = require('./services/campaigns');
app.get('/:code', async (req, res, next) => {
  const code = campaigns.cleanCode(req.params.code);
  if (!code) return next();
  if (!campaigns.knownReady()) await campaigns.loadKnown().catch(() => {});
  if (!campaigns.isKnown(code)) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.cookie('abrants_from', code, {
    maxAge: 10 * 60 * 1000, sameSite: 'lax', httpOnly: false, path: '/', secure: process.env.NODE_ENV === 'production',
  });
  res.redirect(302, '/');
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => initCustomerDb())
  .then(() => require('./services/serviceOrders').initServiceDb())
  .then(() => campaigns.loadKnown().catch((e) => console.warn('Could not load tracking links yet:', e.message)))
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Abrants Data Store running on http://localhost:${PORT}`);
      // The background checks below only touch the database when there is work waiting, so the
      // database can sleep while the store is quiet (see services/workHints.js).
      // Tidy up unpaid checkouts: a couple of minutes after start, then once a day.
      const sweep = () => apiRoutes.sweepPendingOrders().catch((e) => console.warn('Pending sweep failed:', e.message));
      setTimeout(sweep, 2 * 60 * 1000).unref();
      setInterval(sweep, 24 * 60 * 60 * 1000).unref();
      // FastDealsGH has no webhook: re-check its unconfirmed orders every 2 minutes (only while there are some).
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
