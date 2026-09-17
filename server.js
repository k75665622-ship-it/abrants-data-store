require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const { initDb } = require('./services/orderStore');

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
app.use('/api', apiRoutes);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Abrants Data Store running on http://localhost:${PORT}`);
      if (process.env.DATAHUSTLE_MOCK_MODE === 'true') {
        console.log('DataHustle is in MOCK MODE - no real provider wallet purchase will be made.');
      }
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  });
