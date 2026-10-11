/*
 * Customer accounts, special offers (prices / percent off / free bundles) and notices.
 *
 * Design rules:
 *  - Prices are ALWAYS decided on the server from the database. The browser never sends a price.
 *  - Offers belong to a customer account (customer_id), so only that customer can use them.
 *  - Passwords are hashed with scrypt (Node built-in) and never stored or logged in plain text.
 *  - Sessions are signed, HttpOnly cookies tied to the password hash, so a password reset
 *    or a disabled account logs the customer out everywhere.
 */
const crypto = require('crypto');
const { pool, normalizePhone, PHONE_RE, createGiftOrder } = require('./orderStore');

const COOKIE_NAME = 'abrants_customer';
const SESSION_DAYS = 30;
const MIN_PRICE = 0.5;
const COUNTED_STATUSES = ['paid', 'processing', 'fulfilled', 'delivery_review'];

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

async function initCustomerDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at DESC);

    CREATE TABLE IF NOT EXISTS customer_offers (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      plan_id TEXT,
      value NUMERIC(12,2),
      max_uses INTEGER,
      title TEXT NOT NULL,
      message TEXT,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_offers_customer ON customer_offers(customer_id, active);

    CREATE TABLE IF NOT EXISTS customer_notices (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notices_customer ON customer_notices(customer_id, created_at DESC);
  `);
}

/* ------------------------------------------------------------------ */
/* Passwords and sessions                                              */
/* ------------------------------------------------------------------ */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, keyHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, 'hex');
    const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

function passwordProblem(password) {
  const p = String(password == null ? '' : password);
  if (p.length < 8) return 'Your password must be at least 8 characters.';
  if (p.length > 100) return 'Your password is too long (maximum 100 characters).';
  if (/^(.)\1+$/.test(p)) return 'Please choose a stronger password.';
  return null;
}

function sessionKey() {
  const secret = process.env.CUSTOMER_SECRET || process.env.ADMIN_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('abrants-customer-session-v1').digest();
}

function fingerprint(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 16);
}

function signSession(customer) {
  const key = sessionKey();
  if (!key) throw new Error('Customer sessions are not configured.');
  const payload = `${customer.id}.${Date.now()}.${fingerprint(customer.passwordHash)}`;
  const sig = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function parseSession(token) {
  const key = sessionKey();
  if (!key || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
  let payload;
  try { payload = Buffer.from(parts[0], 'base64url').toString('utf8'); } catch { return null; }
  const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  const [id, issued, fp] = payload.split('.');
  const age = Date.now() - Number(issued);
  if (!/^\d+$/.test(id) || !(age >= 0 && age < SESSION_DAYS * 86400 * 1000)) return null;
  return { id, fp };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  return out;
}

function cookieFlags() {
  return `HttpOnly; Path=/; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function setSessionCookie(res, customer) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(signSession(customer))}; ${cookieFlags()}; Max-Age=${SESSION_DAYS * 86400}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieFlags()}; Max-Age=0`);
}

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

function mapCustomer(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    phone: row.phone,
    name: row.name,
    email: row.email || '',
    status: row.status,
    adminNote: row.admin_note || '',
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function publicCustomer(c) {
  return { id: c.id, name: c.name, phone: c.phone, email: c.email, createdAt: c.createdAt };
}

async function getCustomer(id) {
  if (!/^\d+$/.test(String(id))) return null;
  const r = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  return mapCustomer(r.rows[0]);
}

async function findCustomerByPhone(phone) {
  const r = await pool.query('SELECT * FROM customers WHERE phone = $1', [normalizePhone(phone)]);
  return mapCustomer(r.rows[0]);
}

async function createCustomer({ name, phone, email, password }) {
  const hash = await hashPassword(password);
  try {
    const r = await pool.query(
      'INSERT INTO customers (phone, name, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING *',
      [phone, name, email || null, hash]
    );
    return mapCustomer(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return null; // phone already registered
    throw err;
  }
}

async function setPassword(id, password) {
  const hash = await hashPassword(password);
  const r = await pool.query('UPDATE customers SET password_hash = $2 WHERE id = $1 RETURNING *', [id, hash]);
  return mapCustomer(r.rows[0]);
}

async function touchLogin(id) {
  await pool.query('UPDATE customers SET last_login_at = NOW() WHERE id = $1', [id]);
}

async function setCustomerStatus(id, status) {
  const r = await pool.query('UPDATE customers SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
  return mapCustomer(r.rows[0]);
}

async function setCustomerNote(id, note) {
  const r = await pool.query('UPDATE customers SET admin_note = $2 WHERE id = $1 RETURNING *', [id, note || null]);
  return mapCustomer(r.rows[0]);
}

/** Reads the signed cookie and returns the logged-in, active customer (or null). */
async function customerFromRequest(req) {
  const session = parseSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  if (!session) return null;
  const customer = await getCustomer(session.id);
  if (!customer || customer.status !== 'active') return null;
  if (fingerprint(customer.passwordHash) !== session.fp) return null;
  return customer;
}

function optionalCustomer() {
  return async (req, res, next) => {
    try { req.customer = await customerFromRequest(req); } catch { req.customer = null; }
    next();
  };
}

function requireCustomer() {
  return async (req, res, next) => {
    try { req.customer = await customerFromRequest(req); } catch { req.customer = null; }
    if (!req.customer) return res.status(401).json({ error: 'Please log in to continue.' });
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Offers                                                              */
/* ------------------------------------------------------------------ */

const OFFER_KINDS = ['fixed_price', 'percent_off', 'free_bundle'];

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function mapOffer(row, used = 0) {
  const expired = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false;
  const maxUses = row.max_uses == null ? null : Number(row.max_uses);
  const remaining = maxUses == null ? null : Math.max(maxUses - Number(used || 0), 0);
  return {
    id: Number(row.id),
    customerId: Number(row.customer_id),
    kind: row.kind,
    planId: row.plan_id || null,
    value: row.value == null ? null : Number(row.value),
    maxUses,
    used: Number(used || 0),
    remaining,
    title: row.title,
    message: row.message || '',
    expiresAt: row.expires_at,
    active: row.active,
    expired,
    usable: row.active && !expired && (remaining == null || remaining > 0),
    createdAt: row.created_at,
  };
}

// Counts how many times an offer has been used. Failed or refunded orders do not count, and
// unpaid checkouts only hold a use for 30 minutes.
const USAGE_SQL = `
  SELECT offer_id, COUNT(*)::int AS n FROM orders
  WHERE offer_id = ANY($1::bigint[])
    AND (status = ANY($2::text[]) OR (status = 'pending' AND created_at > NOW() - INTERVAL '30 minutes'))
  GROUP BY offer_id`;

async function offerUsage(ids) {
  if (!ids.length) return new Map();
  const r = await pool.query(USAGE_SQL, [ids, COUNTED_STATUSES]);
  return new Map(r.rows.map((x) => [Number(x.offer_id), x.n]));
}

async function listOffers(customerId, { onlyUsable = false } = {}) {
  const r = await pool.query('SELECT * FROM customer_offers WHERE customer_id = $1 ORDER BY created_at DESC', [customerId]);
  const usage = await offerUsage(r.rows.map((x) => Number(x.id)));
  const offers = r.rows.map((x) => mapOffer(x, usage.get(Number(x.id)) || 0));
  return onlyUsable ? offers.filter((o) => o.usable) : offers;
}

/**
 * Validates and creates one offer per customer id. Returns { offers } or { error }.
 */
async function createOffers(customerIds, input, plansById) {
  const kind = String(input.kind || '');
  if (!OFFER_KINDS.includes(kind)) return { error: 'Choose what kind of offer this is.' };

  const planId = input.planId ? String(input.planId) : null;
  if (planId && !plansById.has(planId)) return { error: 'That bundle does not exist.' };
  if (kind !== 'percent_off' && !planId) return { error: 'Choose which bundle this offer is for.' };

  let value = null;
  let maxUses = null;
  if (kind === 'fixed_price') {
    value = round2(input.value);
    if (!Number.isFinite(value) || value < MIN_PRICE || value > 10000) return { error: `Enter a special price between GH₵${MIN_PRICE.toFixed(2)} and GH₵10,000.` };
  } else if (kind === 'percent_off') {
    value = Number(input.value);
    if (!Number.isFinite(value) || value < 1 || value > 90) return { error: 'Enter a discount between 1% and 90%.' };
    value = round2(value);
  } else {
    maxUses = Math.trunc(Number(input.quantity));
    if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 20) return { error: 'A free bundle offer can cover 1 to 20 bundles.' };
  }
  if (kind !== 'free_bundle' && input.maxUses != null && input.maxUses !== '') {
    maxUses = Math.trunc(Number(input.maxUses));
    if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 1000) return { error: 'Number of uses must be between 1 and 1000.' };
  }

  let expiresAt = null;
  if (input.expiresAt) {
    const d = new Date(`${String(input.expiresAt).slice(0, 10)}T23:59:59Z`);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return { error: 'The end date must be in the future.' };
    if (d.getTime() > Date.now() + 366 * 86400 * 1000) return { error: 'The end date cannot be more than a year away.' };
    expiresAt = d.toISOString();
  }

  const plan = planId ? plansById.get(planId) : null;
  const defaultTitle = kind === 'fixed_price'
    ? `Special price: ${plan.network} ${plan.label} for GH₵${value.toFixed(2)}`
    : kind === 'percent_off'
      ? `${value}% off${plan ? ` ${plan.network} ${plan.label}` : ' all bundles'}`
      : `${maxUses} free ${plan.network} ${plan.label} bundle${maxUses > 1 ? 's' : ''}`;
  const title = String(input.title || '').trim().slice(0, 80) || defaultTitle;
  const message = String(input.message || '').trim().slice(0, 300);

  const offers = [];
  for (const id of customerIds) {
    const r = await pool.query(`
      INSERT INTO customer_offers (customer_id, kind, plan_id, value, max_uses, title, message, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, kind, planId, value, maxUses, title, message || null, expiresAt]);
    offers.push(mapOffer(r.rows[0], 0));
    if (input.notify !== false) {
      await createNotice(id, '🎁 You have a new offer', `${title}.${message ? ` ${message}` : ''} Open your account to use it.`);
    }
  }
  return { offers };
}

async function deactivateOffer(customerId, offerId) {
  const r = await pool.query(
    'UPDATE customer_offers SET active = FALSE WHERE id = $1 AND customer_id = $2 RETURNING *',
    [offerId, customerId]
  );
  return r.rows[0] ? mapOffer(r.rows[0], 0) : null;
}

/**
 * Works out the price this customer pays for a plan. Pure function: no I/O.
 * `offers` must already be filtered to usable ones.
 */
function resolvePrice(plan, offers = []) {
  const list = Number(plan.priceGHS);
  let best = { priceGHS: list, listPriceGHS: list, offerId: null, offerTitle: null };
  for (const o of offers) {
    if (!o.usable) continue;
    let candidate = null;
    if (o.kind === 'fixed_price' && o.planId === plan.id) candidate = Number(o.value);
    else if (o.kind === 'percent_off' && (!o.planId || o.planId === plan.id)) candidate = round2(list * (1 - Number(o.value) / 100));
    if (candidate == null || !Number.isFinite(candidate)) continue;
    candidate = Math.max(round2(candidate), MIN_PRICE);
    if (candidate < best.priceGHS) best = { priceGHS: candidate, listPriceGHS: list, offerId: o.id, offerTitle: o.title };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Free bundle redemption                                              */
/* ------------------------------------------------------------------ */

const PREFIXES = {
  MTN: ['024', '054', '055', '059', '025', '053'],
  Telecel: ['020', '050'],
  AirtelTigo: ['026', '056', '027', '057'],
};

function networkFromPhone(phone) {
  const prefix = String(phone).slice(0, 3);
  for (const [network, list] of Object.entries(PREFIXES)) if (list.includes(prefix)) return network;
  return null;
}

/**
 * Reserves one use of a free-bundle offer and creates the (unpaid, 'gift') order, all in one
 * database transaction so two taps can never spend the same bundle twice.
 * Returns { order } or { error, status }.
 */
async function redeemFreeBundle(customer, offerId, rawPhone, planLookup) {
  const phone = normalizePhone(rawPhone || customer.phone);
  if (!PHONE_RE.test(phone)) return { error: 'Enter a valid 10-digit Ghana phone number.', status: 400 };
  if (!/^\d+$/.test(String(offerId))) return { error: 'Offer not found.', status: 404 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query(
      "SELECT * FROM customer_offers WHERE id = $1 AND customer_id = $2 AND kind = 'free_bundle' FOR UPDATE",
      [offerId, customer.id]
    );
    const row = o.rows[0];
    if (!row) { await client.query('ROLLBACK'); return { error: 'Offer not found.', status: 404 }; }
    const used = await client.query(USAGE_SQL, [[Number(row.id)], COUNTED_STATUSES]);
    const offer = mapOffer(row, used.rows[0]?.n || 0);
    if (!offer.active || offer.expired) { await client.query('ROLLBACK'); return { error: 'This offer is no longer available.', status: 410 }; }
    if (offer.remaining != null && offer.remaining <= 0) { await client.query('ROLLBACK'); return { error: 'You have already used this free bundle.', status: 409 }; }

    const plan = await planLookup(offer.planId);
    if (!plan || !plan.active) { await client.query('ROLLBACK'); return { error: 'That bundle is not available right now. Please contact support.', status: 409 }; }

    const detected = networkFromPhone(phone);
    if (detected && detected !== plan.network) {
      await client.query('ROLLBACK');
      return { error: `This free bundle is for ${plan.network}, but that looks like a ${detected} number.`, status: 400 };
    }
    const blocked = await client.query('SELECT 1 FROM blocked_numbers WHERE phone = $1', [phone]);
    if (blocked.rowCount > 0) { await client.query('ROLLBACK'); return { error: 'This phone number is blocked. Please contact support.', status: 403 }; }

    const reference = `DB-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const order = await createGiftOrder({
      reference, planId: plan.id, network: plan.network, networkCode: plan.networkCode,
      capacityGB: plan.capacityGB, label: plan.label, providerCostGHS: plan.providerCostGHS,
      phone, email: customer.email, customerId: customer.id, offerId: offer.id, listPriceGHS: plan.priceGHS,
    }, client);
    await client.query('COMMIT');
    return { order };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Notices                                                             */
/* ------------------------------------------------------------------ */

async function createNotice(customerId, title, body) {
  await pool.query(
    'INSERT INTO customer_notices (customer_id, title, body) VALUES ($1,$2,$3)',
    [customerId, String(title).slice(0, 100), String(body).slice(0, 600)]
  );
}

async function createNoticeForMany(customerIds, title, body) {
  for (const id of customerIds) await createNotice(id, title, body);
  return customerIds.length;
}

async function listNotices(customerId, limit = 30) {
  const r = await pool.query(
    'SELECT id, title, body, read_at, created_at FROM customer_notices WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2',
    [customerId, limit]
  );
  return r.rows.map((x) => ({ id: Number(x.id), title: x.title, body: x.body, read: Boolean(x.read_at), createdAt: x.created_at }));
}

async function markNoticesRead(customerId) {
  await pool.query('UPDATE customer_notices SET read_at = NOW() WHERE customer_id = $1 AND read_at IS NULL', [customerId]);
}

/* ------------------------------------------------------------------ */
/* Customer orders and admin views                                     */
/* ------------------------------------------------------------------ */

async function listCustomerOrders(customerId, limit = 30) {
  const r = await pool.query(`
    SELECT reference, network, label, price_ghs, list_price_ghs, status, source, phone, created_at
    FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2`, [customerId, limit]);
  return r.rows.map((x) => ({
    reference: x.reference, network: x.network, label: x.label, priceGHS: Number(x.price_ghs),
    listPriceGHS: x.list_price_ghs == null ? null : Number(x.list_price_ghs),
    status: x.status, source: x.source, phone: x.phone, createdAt: x.created_at,
  }));
}

const SORTS = {
  recent: 'c.created_at DESC',
  week: 'orders_7d DESC, spent_7d DESC, c.created_at DESC',
  spent: 'spent_total DESC, c.created_at DESC',
  orders: 'orders_total DESC, c.created_at DESC',
};

async function listCustomersAdmin({ search = '', sort = 'recent', minWeekOrders = 0, page = 1, pageSize = 25 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 25, 5), 100);
  const current = Math.max(Number(page) || 1, 1);
  const where = [];
  const values = [];
  if (search) {
    values.push(`%${String(search).trim().slice(0, 60)}%`);
    where.push(`(c.name ILIKE $${values.length} OR c.phone ILIKE $${values.length} OR COALESCE(c.email,'') ILIKE $${values.length})`);
  }
  const minWeek = Math.max(Math.trunc(Number(minWeekOrders) || 0), 0);
  if (minWeek > 0) { values.push(minWeek); where.push(`COALESCE(w.orders_7d,0) >= $${values.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const base = `
    FROM customers c
    LEFT JOIN (
      SELECT customer_id, COUNT(*) AS orders_7d, SUM(price_ghs) AS spent_7d FROM orders
      WHERE customer_id IS NOT NULL AND source = 'store' AND status IN ('paid','processing','fulfilled')
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY customer_id) w ON w.customer_id = c.id
    LEFT JOIN (
      SELECT customer_id, COUNT(*) AS orders_total, SUM(price_ghs) AS spent_total, MAX(created_at) AS last_order_at FROM orders
      WHERE customer_id IS NOT NULL AND source = 'store' AND status IN ('paid','processing','fulfilled')
      GROUP BY customer_id) t ON t.customer_id = c.id
    ${whereSql}`;

  const count = await pool.query(`SELECT COUNT(*)::int AS n ${base}`, values);
  const total = count.rows[0]?.n || 0;
  const orderBy = SORTS[sort] || SORTS.recent;
  const rows = await pool.query(`
    SELECT c.id, c.phone, c.name, c.email, c.status, c.created_at, c.last_login_at,
      COALESCE(w.orders_7d,0)::int AS orders_7d, COALESCE(w.spent_7d,0)::numeric AS spent_7d,
      COALESCE(t.orders_total,0)::int AS orders_total, COALESCE(t.spent_total,0)::numeric AS spent_total, t.last_order_at,
      (SELECT COUNT(*)::int FROM customer_offers o WHERE o.customer_id = c.id AND o.active AND (o.expires_at IS NULL OR o.expires_at > NOW())) AS active_offers
    ${base}
    ORDER BY ${orderBy}
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, size, (current - 1) * size]);

  return {
    rows: rows.rows.map((x) => ({
      id: Number(x.id), phone: x.phone, name: x.name, email: x.email || '', status: x.status,
      createdAt: x.created_at, lastLoginAt: x.last_login_at, lastOrderAt: x.last_order_at,
      orders7d: x.orders_7d, spent7d: Number(x.spent_7d), ordersTotal: x.orders_total, spentTotal: Number(x.spent_total),
      activeOffers: x.active_offers,
    })),
    total, page: current, pageSize: size, pages: Math.max(Math.ceil(total / size), 1),
  };
}

async function customerSummary() {
  const r = await pool.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_7d,
      COUNT(*) FILTER (WHERE status <> 'active')::int AS disabled
    FROM customers`);
  const buyers = await pool.query(`
    SELECT COUNT(DISTINCT customer_id)::int AS n FROM orders
    WHERE customer_id IS NOT NULL AND source = 'store' AND status IN ('paid','processing','fulfilled')
      AND created_at >= NOW() - INTERVAL '7 days'`);
  const x = r.rows[0];
  return { total: x.total, new7d: x.new_7d, disabled: x.disabled, buyers7d: buyers.rows[0]?.n || 0 };
}

async function customerIdsWhere(ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)).filter((x) => /^\d{1,12}$/.test(x)))].slice(0, 200);
  if (!clean.length) return [];
  const r = await pool.query("SELECT id FROM customers WHERE id = ANY($1::bigint[]) AND status = 'active'", [clean]);
  return r.rows.map((x) => Number(x.id));
}

module.exports = {
  COOKIE_NAME, MIN_PRICE, COUNTED_STATUSES, OFFER_KINDS,
  initCustomerDb,
  hashPassword, verifyPassword, passwordProblem,
  setSessionCookie, clearSessionCookie, customerFromRequest, optionalCustomer, requireCustomer,
  publicCustomer, getCustomer, findCustomerByPhone, createCustomer, setPassword, touchLogin,
  setCustomerStatus, setCustomerNote,
  listOffers, createOffers, deactivateOffer, resolvePrice, redeemFreeBundle, networkFromPhone,
  createNotice, createNoticeForMany, listNotices, markNoticesRead,
  listCustomerOrders, listCustomersAdmin, customerSummary, customerIdsWhere,
};
