const express = require('express');
const {
  requireCustomer, optionalCustomer, publicCustomer, findCustomerByPhone, createCustomer,
  verifyPassword, hashPassword, passwordProblem, setPassword, setSessionCookie, clearSessionCookie, touchLogin,
  listOffers, redeemFreeBundle, listNotices, markNoticesRead, listCustomerOrders,
} = require('../services/customers');
const { getPlans, getPlan, getSettings, normalizePhone, PHONE_RE } = require('../services/orderStore');
const { deliverOrder } = require('../services/fulfillment');

const router = express.Router();

/* Simple in-memory limiter: fine for a single server instance. */
const buckets = new Map();
function limiter({ key, windowMs, max }) {
  return (req, res, next) => {
    const id = `${key}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || now >= b.resetAt) b = { count: 0, resetAt: now + windowMs };
    b.count += 1;
    buckets.set(id, b);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    if (b.count > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    next();
  };
}

// Failed logins are also counted per phone number, so one number cannot be guessed at from many places.
const failures = new Map();
const LOCK_AFTER = 6;
const LOCK_MS = 15 * 60 * 1000;
function lockedFor(phone) {
  const f = failures.get(phone);
  return f && f.count >= LOCK_AFTER && Date.now() < f.resetAt ? Math.ceil((f.resetAt - Date.now()) / 60000) : 0;
}
function noteFailure(phone) {
  const now = Date.now();
  let f = failures.get(phone);
  if (!f || now >= f.resetAt) f = { count: 0, resetAt: now + LOCK_MS };
  f.count += 1;
  failures.set(phone, f);
  if (failures.size > 5000) for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
}

const registerLimit = limiter({ key: 'register', windowMs: 60 * 60 * 1000, max: 10 });
const loginLimit = limiter({ key: 'login', windowMs: 15 * 60 * 1000, max: 30 });
const redeemLimit = limiter({ key: 'redeem', windowMs: 60 * 1000, max: 8 });
const passwordLimit = limiter({ key: 'password', windowMs: 15 * 60 * 1000, max: 10 });

// Used to spend the same time on unknown numbers as on real ones.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);

function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

router.post('/register', registerLimit, async (req, res) => {
  try {
    const name = cleanName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);
    const email = String(req.body?.email || '').trim().slice(0, 254);
    const password = req.body?.password;

    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit Ghana phone number, e.g. 0551234567.' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email address does not look right.' });
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    const customer = await createCustomer({ name, phone, email, password });
    if (!customer) {
      return res.status(409).json({ error: 'An account with this phone number already exists. Please log in, or contact support if you forgot your password.' });
    }
    setSessionCookie(res, customer);
    res.status(201).json({ customer: publicCustomer(customer) });
  } catch (err) { console.error('Register error:', err.message); res.status(500).json({ error: 'Could not create your account. Please try again.' }); }
});

router.post('/login', loginLimit, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password == null ? '' : req.body.password).slice(0, 200);
    if (!PHONE_RE.test(phone) || !password) return res.status(400).json({ error: 'Enter your phone number and password.' });

    const wait = lockedFor(phone);
    if (wait) return res.status(429).json({ error: `Too many wrong passwords. Please try again in about ${wait} minute${wait > 1 ? 's' : ''}.` });

    const customer = await findCustomerByPhone(phone);
    const ok = await verifyPassword(password, customer ? customer.passwordHash : DUMMY_HASH);
    if (!customer || !ok) {
      noteFailure(phone);
      return res.status(401).json({ error: 'Wrong phone number or password.' });
    }
    if (customer.status !== 'active') return res.status(403).json({ error: 'This account is not active. Please contact support.' });

    failures.delete(phone);
    await touchLogin(customer.id);
    setSessionCookie(res, customer);
    res.json({ customer: publicCustomer(customer) });
  } catch (err) { console.error('Login error:', err.message); res.status(500).json({ error: 'Could not log you in. Please try again.' }); }
});

router.post('/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

// Never errors for guests: the storefront uses this to decide whether to show "Log in" or "My account".
router.get('/me', optionalCustomer(), async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!req.customer) return res.json({ customer: null });
  try {
    const [offers, notices] = await Promise.all([listOffers(req.customer.id, { onlyUsable: true }), listNotices(req.customer.id, 30)]);
    res.json({ customer: publicCustomer(req.customer), offers: offers.length, unread: notices.filter((n) => !n.read).length });
  } catch { res.json({ customer: publicCustomer(req.customer), offers: 0, unread: 0 }); }
});

router.get('/overview', requireCustomer(), async (req, res) => {
  try {
    const [offers, notices, orders, plans] = await Promise.all([
      listOffers(req.customer.id),
      listNotices(req.customer.id, 20),
      listCustomerOrders(req.customer.id, 25),
      getPlans({ includeInactive: true }),
    ]);
    const byId = new Map(plans.map((p) => [p.id, p]));
    const shownOffers = offers
      .filter((o) => o.active && !o.expired && (o.remaining == null || o.remaining > 0))
      .map((o) => {
        const plan = o.planId ? byId.get(o.planId) : null;
        return { ...o, planLabel: plan ? `${plan.network} ${plan.label}` : null, network: plan ? plan.network : null };
      });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ customer: publicCustomer(req.customer), offers: shownOffers, notices, orders, unread: notices.filter((n) => !n.read).length });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load your account.' }); }
});

router.post('/notices/read', requireCustomer(), async (req, res) => {
  try { await markNoticesRead(req.customer.id); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not update notices.' }); }
});

router.post('/password', passwordLimit, requireCustomer(), async (req, res) => {
  try {
    const current = String(req.body?.current || '');
    const next = req.body?.next;
    if (!(await verifyPassword(current, req.customer.passwordHash))) return res.status(400).json({ error: 'Your current password is not correct.' });
    const problem = passwordProblem(next);
    if (problem) return res.status(400).json({ error: problem });
    const updated = await setPassword(req.customer.id, next);
    setSessionCookie(res, updated); // old sessions on other devices stop working
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not change your password.' }); }
});

// Spend a free bundle the store owner gave this customer.
router.post('/redeem/:offerId', redeemLimit, requireCustomer(), async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.maintenanceMode) return res.status(503).json({ error: settings.maintenanceMessage || 'The store is temporarily closed. Please try again shortly.' });

    const result = await redeemFreeBundle(req.customer, req.params.offerId, req.body?.phone, getPlan);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    // The order is saved first; delivery then runs through the normal provider path.
    await deliverOrder(result.order);
    res.json({ ok: true, reference: result.order.reference });
  } catch (err) { console.error('Redeem error:', err.message); res.status(500).json({ error: 'Could not send your free bundle. Please try again or contact support.' }); }
});

module.exports = router;
