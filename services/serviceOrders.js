/*
 * Result checkers (WAEC, BECE, ...) and AFA registration, sold through FastDealsGH API v2.
 *
 * Flow: checkout saves a 'pending' row (AFA details must wait somewhere until the payment lands)
 * -> Paystack confirms -> 'paid' -> sent to FastDealsGH with our reference as the Idempotency-Key.
 *   checker: 'completed' with PINs straight away
 *   AFA:     'submitted' -> 'approved' (AFA ID) or 'rejected' (checked about once an hour)
 * Unknown outcome (timeout) stays 'paid' and is retried with the same key, which can never charge twice.
 * A definite "no" (out of stock, invalid details) is refunded to the customer automatically.
 * Ghana Card number and date of birth are wiped once FastDealsGH has finished with them.
 */
const crypto = require('crypto');
const { pool, getSettings, normalizePhone, PHONE_RE } = require('./orderStore');
const fd = require('./fdv2');
const { verifyTransaction, refundTransaction } = require('./paystack');
const { addAlert } = require('./fulfillment');
const { round2 } = require('./fees');
const work = require('./workHints');

const STATUSES = ['pending', 'paid', 'sending', 'completed', 'submitted', 'approved', 'rejected', 'review', 'refunding', 'refunded', 'failed'];
const RETRYABLE = new Set(['network', 'request_in_progress', 'rate_limited', 'maintenance', 'bad_response']);
const MAX_ATTEMPTS = 12;

const REGIONS = ['Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra', 'North East', 'Northern',
  'Oti', 'Savannah', 'Upper East', 'Upper West', 'Volta', 'Western', 'Western North'];

async function initServiceDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_orders (
      reference TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('checker','afa')),
      item_code TEXT NOT NULL,
      item_name TEXT NOT NULL,
      checker_type_id INTEGER,
      quantity INTEGER NOT NULL DEFAULT 1,
      price_ghs NUMERIC(10,2) NOT NULL,
      customer_fee_ghs NUMERIC(10,2) NOT NULL DEFAULT 0,
      cost_ghs NUMERIC(10,2),
      payment_fee_ghs NUMERIC(10,2),
      amount_paid_ghs NUMERIC(10,2),
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      customer_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_reference TEXT,
      pins JSONB,
      result_url TEXT,
      afa JSONB,
      afa_id TEXT,
      note TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      refund_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS service_orders_status_idx ON service_orders (status, updated_at);
  `);
  await tidyRemovedBills();
}

// Bill payments (ECG, water and TV through Techlink) were sold here for a few days in October 2026, then removed.
// This clears up after them when the server starts: an unfinished bill order is parked as "stuck" for a person to
// check in Techlink and refund, and the columns and settings bills added are dropped once no bill order is left.
// A database that never had bills (or is already tidy) is not changed.
async function tidyRemovedBills() {
  const had = await pool.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'service_orders' AND column_name = 'provider'`);
  if (!had.rows.length) return;
  const forgot = await pool.query(`UPDATE store_settings SET value = value - 'bills' WHERE key = 'store' AND value ? 'bills'`);
  if (forgot.rowCount) await getSettings({ fresh: true }); // drop them from the copy kept in memory too
  const open = await pool.query(`UPDATE service_orders SET status = 'review', updated_at = NOW(),
      note = 'Bill payment (no longer sold): check Techlink, refund if it was not paid'
    WHERE kind NOT IN ('checker','afa') AND status IN ('paid','sending','submitted') RETURNING reference`);
  if (open.rowCount) {
    await addAlert('danger', `${open.rowCount} bill payment order(s) were unfinished when bills were removed. They are under Stuck in Checkers & AFA: refund any that Techlink did not pay.`).catch(() => {});
  }
  const left = await pool.query(`SELECT 1 FROM service_orders WHERE kind NOT IN ('checker','afa') LIMIT 1`);
  if (left.rows.length) return; // keep their meter / account details while bill orders remain
  await pool.query(`
    ALTER TABLE service_orders DROP COLUMN IF EXISTS account, DROP COLUMN IF EXISTS account_name,
      DROP COLUMN IF EXISTS provider, DROP COLUMN IF EXISTS details, DROP CONSTRAINT IF EXISTS service_orders_kind_check;
    ALTER TABLE service_orders ADD CONSTRAINT service_orders_kind_check CHECK (kind IN ('checker','afa'));
  `);
}

const num = (v) => (v == null ? null : Number(v));
function mapRow(r) {
  if (!r) return null;
  return {
    reference: r.reference, kind: r.kind, code: r.item_code, name: r.item_name, checkerTypeId: r.checker_type_id,
    quantity: r.quantity, priceGHS: num(r.price_ghs), customerFeeGHS: num(r.customer_fee_ghs), costGHS: num(r.cost_ghs),
    paymentFeeGHS: num(r.payment_fee_ghs), amountPaidGHS: num(r.amount_paid_ghs), phone: r.phone, email: r.email,
    customerId: r.customer_id, status: r.status, providerReference: r.provider_reference, pins: r.pins || [],
    resultUrl: r.result_url, afa: r.afa || null, afaId: r.afa_id, note: r.note, attempts: r.attempts, refundId: r.refund_id,
    createdAt: r.created_at, updatedAt: r.updated_at, paidAt: r.paid_at,
    profitGHS: r.cost_ghs == null ? null : round2(Number(r.price_ghs) - Number(r.cost_ghs) - Number(r.payment_fee_ghs || 0)),
  };
}

async function getServiceOrder(reference) {
  const r = await pool.query('SELECT * FROM service_orders WHERE reference = $1', [String(reference || '')]);
  return mapRow(r.rows[0]);
}

// Moves an order from one status to another only if it is still in the expected status.
async function move(reference, from, changes = {}) {
  const cols = { status: 'status', providerReference: 'provider_reference', pins: 'pins', resultUrl: 'result_url', afa: 'afa',
    afaId: 'afa_id', note: 'note', costGHS: 'cost_ghs', paymentFeeGHS: 'payment_fee_ghs', amountPaidGHS: 'amount_paid_ghs',
    refundId: 'refund_id', attempts: 'attempts', paidAt: 'paid_at' };
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(changes)) {
    if (!cols[k]) continue;
    vals.push(k === 'pins' || k === 'afa' ? (v == null ? null : JSON.stringify(v)) : v);
    sets.push(`${cols[k]} = $${vals.length}`);
  }
  sets.push('updated_at = NOW()');
  vals.push(reference);
  const froms = Array.isArray(from) ? from : [from];
  vals.push(froms);
  const r = await pool.query(`UPDATE service_orders SET ${sets.join(', ')} WHERE reference = $${vals.length - 1} AND status = ANY($${vals.length}) RETURNING *`, vals);
  if (r.rows[0]) {
    // Tell the background job there is something to follow up (see services/workHints.js).
    if (changes.status === 'paid' || changes.status === 'sending') work.mark('svc-send');
    if (changes.status === 'submitted') work.mark('svc-afa');
  }
  return mapRow(r.rows[0]);
}

/* ------------------------------------------------------------ catalog */

// What can be sold right now: FastDealsGH products joined with the admin's prices and switches.
// A product is only sold when it has a price, is switched on, is in stock and costs us less than we charge.
async function catalog({ fresh = false } = {}) {
  const settings = await getSettings();
  const conf = settings.services || {};
  let p = null, error = null;
  if (fd.available()) { try { p = await fd.products({ fresh }); } catch (e) { error = e.code || e.message; } }
  else error = 'not_configured';
  const checkers = (p ? p.checkers : []).map((c) => {
    const mine = (conf.checkers || {})[c.code] || {};
    const price = mine.price == null || mine.price === '' ? null : Number(mine.price);
    const inStock = c.stock == null || c.stock > 0;
    return { ...c, price, enabled: Boolean(mine.enabled), inStock,
      available: Boolean(mine.enabled) && price > 0 && inStock && !(c.cost > price) };
  });
  const afaConf = conf.afa || {};
  const afaPrice = afaConf.price == null || afaConf.price === '' ? null : Number(afaConf.price);
  const afaCost = p ? p.afaFee : null;
  const afa = { cost: afaCost, price: afaPrice, enabled: Boolean(afaConf.enabled),
    available: Boolean(p) && Boolean(afaConf.enabled) && afaPrice > 0 && afaCost != null && !(afaCost > afaPrice) };
  return { connected: Boolean(p), error, checkers, afa, regions: REGIONS };
}

/* ------------------------------------------------------------ validation */

function cleanAfa(body) {
  const b = body || {};
  const name = String(b.fullName || '').replace(/\s+/g, ' ').trim();
  let card = String(b.ghanaCard || '').toUpperCase().replace(/[\s-]/g, '');
  if (/^\d{10}$/.test(card)) card = 'GHA' + card;
  const dob = String(b.dob || '').trim();
  const region = REGIONS.find((r) => r.toLowerCase() === String(b.region || '').trim().toLowerCase());
  const location = String(b.location || '').replace(/\s+/g, ' ').trim();
  const occupation = String(b.occupation || '').replace(/\s+/g, ' ').trim();
  const phone = normalizePhone(b.phone);

  if (!/^[A-Za-z][A-Za-z .'-]{2,79}$/.test(name) || !name.includes(' ')) return { error: 'Enter the full name exactly as on the Ghana Card.', field: 'fullName' };
  if (!/^GHA\d{10}$/.test(card)) return { error: 'Enter a valid Ghana Card number, e.g. GHA-123456789-0.', field: 'ghanaCard' };
  const d = new Date(dob + 'T00:00:00Z');
  const age = (Date.now() - d.getTime()) / (365.25 * 864e5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(d.getTime()) || age < 15 || age > 110) return { error: 'Enter a valid date of birth.', field: 'dob' };
  if (!PHONE_RE.test(phone)) return { error: 'Enter a valid 10-digit phone number.', field: 'phone' };
  if (!region) return { error: 'Choose a region.', field: 'region' };
  if (location.length < 2 || location.length > 60) return { error: 'Enter your town.', field: 'location' };
  if (occupation.length > 60) return { error: 'Occupation is too long.', field: 'occupation' };
  return {
    phone,
    afa: {
      full_name: name, ghana_card_number: `GHA-${card.slice(3, 12)}-${card.slice(12)}`, phone,
      date_of_birth: dob, region, location, ...(occupation ? { occupation } : {}),
    },
  };
}

/* ------------------------------------------------------------ checkout */

function newReference(kind) {
  return `SV-${kind === 'afa' ? 'AFA' : 'CHK'}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

async function createPending(o) {
  work.mark('svc-sweep');
  await pool.query(
    `INSERT INTO service_orders (reference, kind, item_code, item_name, checker_type_id, quantity, price_ghs, customer_fee_ghs,
       cost_ghs, payment_fee_ghs, phone, email, customer_id, afa)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [o.reference, o.kind, o.code, o.name, o.checkerTypeId || null, o.quantity || 1, o.priceGHS, o.customerFeeGHS || 0,
      o.costGHS ?? null, o.paymentFeeGHS ?? null, o.phone, o.email, o.customerId || null, o.afa ? JSON.stringify(o.afa) : null]
  );
  return getServiceOrder(o.reference);
}

/* ------------------------------------------------------------ payment + delivery */

const chargeOf = (o) => Math.round((Number(o.priceGHS) + Number(o.customerFeeGHS || 0)) * 100);

// Called by the Paystack webhook, the result page and the sweep. Safe to call many times.
async function confirmPayment(reference, tx) {
  let order = await getServiceOrder(reference);
  if (!order) return null;
  if (order.status !== 'pending') return order;
  if (!tx || tx.status !== 'success' || Math.round(Number(tx.amount)) !== chargeOf(order)) tx = await verifyTransaction(reference);
  const ok = tx && tx.status === 'success' && String(tx.reference) === reference
    && String(tx.currency || '').toUpperCase() === 'GHS' && Math.round(Number(tx.amount)) === chargeOf(order);
  if (!ok) return order;
  const fee = Number.isFinite(Number(tx.fees)) ? round2(Number(tx.fees) / 100 - Number(order.customerFeeGHS || 0)) : order.paymentFeeGHS;
  order = await move(reference, 'pending', { status: 'paid', amountPaidGHS: Number(tx.amount) / 100, paymentFeeGHS: fee, paidAt: new Date() });
  if (!order) return getServiceOrder(reference); // someone else confirmed it at the same moment
  return deliver(order);
}

function scrubAfa(afa) {
  if (!afa) return afa;
  const card = String(afa.ghana_card_number || '');
  return { full_name: afa.full_name, region: afa.region, location: afa.location, ghana_card_number: card ? `GHA-•••••${card.slice(-6)}` : '' };
}

async function deliver(order) {
  const ref = order.reference;
  // Only checkers and AFA are sold. Anything else (a bill paid for just as bills were removed) must never reach
  // FastDealsGH: it waits as "stuck" for a refund.
  if (order.kind !== 'checker' && order.kind !== 'afa') {
    const parked = await move(ref, 'paid', { status: 'review', note: 'No longer sold: refund the customer' });
    if (parked) await addAlert('danger', `${order.name} order ${ref} is for something we no longer sell. Refund it in Checkers & AFA.`).catch(() => {});
    return parked || getServiceOrder(ref);
  }
  const claimed = await move(ref, 'paid', { status: 'sending', attempts: (order.attempts || 0) + 1 });
  if (!claimed) return getServiceOrder(ref);
  try {
    if (claimed.kind === 'checker') {
      const d = await fd.buyChecker(ref, claimed.checkerTypeId, claimed.quantity, claimed.phone);
      const pins = (Array.isArray(d.pins) ? d.pins : []).map((p) => ({ serial: String(p.serial || ''), pin: String(p.pin || '') }));
      if (!pins.length) throw new fd.FdError('bad_response', 'No PINs in the answer');
      return await move(ref, 'sending', { status: 'completed', providerReference: d.reference || null, pins,
        resultUrl: d.result_check_url || null, costGHS: d.amount != null ? Number(d.amount) : claimed.costGHS, note: null });
    }
    const d = await fd.registerAfa(ref, claimed.afa);
    return await move(ref, 'sending', { status: 'submitted', providerReference: d.reference || null,
      costGHS: d.fee != null ? Number(d.fee) : claimed.costGHS, note: null });
  } catch (err) {
    const code = err.code || 'network';
    console.warn('Service order', ref, 'FastDealsGH:', code, String(err.message || '').slice(0, 120));
    if (RETRYABLE.has(code)) {
      if (claimed.attempts >= MAX_ATTEMPTS) {
        await addAlert('danger', `${claimed.name} order ${ref} could not reach FastDealsGH after several tries. Open Checkers & AFA and press Retry.`).catch(() => {});
        return move(ref, 'sending', { status: 'review', note: 'FastDealsGH did not answer' });
      }
      return move(ref, 'sending', { status: 'paid', note: 'Waiting to retry' });
    }
    if (code === 'insufficient_balance' || code === 'not_configured') {
      await addAlert('danger', `FastDealsGH wallet is too low for ${claimed.name} order ${ref}. Top up FastDealsGH, then press Retry in Checkers & AFA.`).catch(() => {});
      return move(ref, 'sending', { status: 'review', note: code === 'insufficient_balance' ? 'FastDealsGH wallet too low' : 'FastDealsGH not connected' });
    }
    // A definite no: nothing was charged by FastDealsGH. Give the customer their money back.
    const reason = code === 'out_of_stock' ? 'Sold out' : code === 'invalid_field' ? `Invalid ${err.field || 'details'}: ${err.message || ''}`.trim() : (err.message || code);
    await move(ref, 'sending', { status: 'failed', note: reason.slice(0, 200), afa: scrubAfa(claimed.afa) });
    return refund(ref);
  }
}

async function refund(reference) {
  const o = await getServiceOrder(reference);
  if (!o || !['failed', 'review', 'rejected'].includes(o.status)) return o;
  const started = await move(reference, o.status, { status: 'refunding' });
  if (!started) return getServiceOrder(reference);
  try {
    const r = await refundTransaction(reference, o.amountPaidGHS ?? undefined);
    return move(reference, 'refunding', { refundId: r && (r.id || r.refund_reference) ? String(r.id || r.refund_reference) : null });
  } catch (err) {
    console.error('Service refund failed:', reference, err.response?.data || err.message);
    await addAlert('danger', `Refund for ${o.name} order ${reference} (${o.phone}) did not go through. Refund it in Paystack.`).catch(() => {});
    return move(reference, 'refunding', { status: 'failed', note: 'Refund failed: refund in Paystack' });
  }
}

async function refundEvent(reference, eventName) {
  if (eventName === 'refund.processed') return move(reference, 'refunding', { status: 'refunded' });
  if (eventName === 'refund.failed' || eventName === 'refund.needs-attention') return move(reference, 'refunding', { status: 'failed', note: 'Refund failed: refund in Paystack' });
  return null;
}

async function retry(reference) {
  const o = await getServiceOrder(reference);
  if (!o || !['review', 'paid'].includes(o.status)) return o;
  const back = await move(reference, o.status, { status: 'paid', attempts: 0 });
  return back ? deliver(back) : getServiceOrder(reference);
}

/* ------------------------------------------------------------ background */

// Asks FastDealsGH whether an AFA registration was approved. Returns the updated order, or null if unchanged.
async function checkAfaOrder(o) {
  try {
    const d = await fd.getAfa(o.providerReference);
    const st = String(d.status || '').toLowerCase();
    if (st === 'approved') return await move(o.reference, 'submitted', { status: 'approved', afaId: d.afa_id || null, afa: scrubAfa(o.afa) });
    if (st === 'rejected') return await move(o.reference, 'submitted', { status: 'rejected', note: d.rejection_reason || 'Rejected', afa: scrubAfa(o.afa) });
    await pool.query('UPDATE service_orders SET updated_at = NOW() WHERE reference = $1', [o.reference]);
  } catch (e) { console.warn('AFA status check failed:', o.reference, e.code || e.message); }
  return null;
}

// A customer looking at their AFA order gets a fresh answer (at most every 2 minutes per order).
async function refreshAfa(o) {
  if (!o || o.status !== 'submitted' || !o.providerReference || !fd.available()) return o;
  if (Date.now() - new Date(o.updatedAt).getTime() < 2 * 60 * 1000) return o;
  return (await checkAfaOrder(o)) || (await getServiceOrder(o.reference)) || o;
}

const afaEveryMs = () => Number(process.env.AFA_CHECK_MINUTES ?? 60) * 60 * 1000;
let lastAfaCheck = 0;

// Runs every 2 minutes, but only touches the database while there is something to follow up.
async function tick() {
  if (!fd.available()) return;
  // 1. Paid but not yet sent (or the last try got no answer): send again with the same key.
  if (work.pending('svc-send')) {
    // A send that crashed half-way (server restart) is put back in the queue.
    await pool.query(`UPDATE service_orders SET status = 'paid', updated_at = NOW() WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '10 minutes'`);
    const open = await pool.query(`SELECT * FROM service_orders WHERE status IN ('paid','sending') ORDER BY created_at LIMIT 20`);
    if (!open.rows.length) work.done('svc-send');
    for (const r of open.rows) {
      if (r.status !== 'paid' || Date.now() - new Date(r.updated_at).getTime() < 60 * 1000) continue;
      await deliver(mapRow(r)).catch((e) => console.warn('Service retry failed:', e.message));
    }
  }
  // 2. AFA registrations under review: ask FastDealsGH about once an hour. Approval takes a while, and a
  //    customer who opens their order page gets a fresh answer straight away (refreshAfa).
  if (work.pending('svc-afa') && Date.now() - lastAfaCheck >= afaEveryMs()) {
    lastAfaCheck = Date.now();
    const afa = await pool.query(`SELECT * FROM service_orders WHERE status = 'submitted' AND provider_reference IS NOT NULL ORDER BY updated_at LIMIT 20`);
    if (!afa.rows.length) work.done('svc-afa');
    for (const r of afa.rows) await checkAfaOrder(mapRow(r));
  }
}

// Checkouts that were never paid are removed after 2 hours (this also deletes any AFA details).
async function sweep() {
  if (!work.pending('svc-sweep')) return;
  const r = await pool.query(`SELECT reference FROM service_orders WHERE status = 'pending' AND created_at < NOW() - INTERVAL '2 hours' ORDER BY created_at LIMIT 50`);
  for (const { reference } of r.rows) {
    try {
      const tx = await verifyTransaction(reference);
      if (tx && tx.status === 'success') { await confirmPayment(reference, tx); continue; }
      await pool.query(`DELETE FROM service_orders WHERE reference = $1 AND status = 'pending'`, [reference]);
    } catch (err) {
      if (err.response?.status === 404 || err.response?.status === 400) await pool.query(`DELETE FROM service_orders WHERE reference = $1 AND status = 'pending'`, [reference]);
    }
  }
  // Never keep personal details of an unpaid checkout for more than 2 days, even if Paystack cannot be reached.
  await pool.query(`DELETE FROM service_orders WHERE status = 'pending' AND created_at < NOW() - INTERVAL '48 hours'`);
  const left = await pool.query(`SELECT 1 FROM service_orders WHERE status = 'pending' LIMIT 1`);
  if (!left.rowCount) work.done('svc-sweep');
}

/* ------------------------------------------------------------ views */

// What the customer sees on the result page.
function publicView(o) {
  if (!o) return null;
  return {
    reference: o.reference, kind: o.kind, name: o.name, quantity: o.quantity, status: o.status,
    totalGHS: round2(Number(o.priceGHS) + Number(o.customerFeeGHS || 0)), phone: o.phone,
    pins: o.status === 'completed' ? o.pins : [], resultUrl: o.status === 'completed' ? o.resultUrl : null,
    afaName: o.afa ? o.afa.full_name : null, afaId: o.afaId || null,
    reason: ['rejected', 'failed', 'refunding', 'refunded'].includes(o.status) ? (o.note || null) : null,
    createdAt: o.createdAt,
  };
}

async function listServiceOrders({ status, search, limit = 50 } = {}) {
  const where = ["status <> 'pending'"]; const vals = [];
  if (status && STATUSES.includes(status)) { vals.push(status); where.push(`status = $${vals.length}`); }
  if (search) { vals.push('%' + String(search).trim() + '%'); where.push(`(reference ILIKE $${vals.length} OR phone ILIKE $${vals.length} OR email ILIKE $${vals.length})`); }
  vals.push(Math.min(Number(limit) || 50, 200));
  const r = await pool.query(`SELECT * FROM service_orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
  const s = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE status IN ('completed','submitted','approved'))::int AS sold,
      COALESCE(SUM(price_ghs) FILTER (WHERE status IN ('completed','submitted','approved','rejected')),0)::numeric AS revenue,
      COALESCE(SUM(price_ghs - COALESCE(cost_ghs,0) - COALESCE(payment_fee_ghs,0)) FILTER (WHERE status IN ('completed','submitted','approved','rejected')),0)::numeric AS profit,
      COUNT(*) FILTER (WHERE status IN ('review','failed','paid','sending'))::int AS attention
    FROM service_orders`);
  const t = s.rows[0];
  return { rows: r.rows.map(mapRow), summary: { sold: t.sold, revenue: Number(t.revenue), profit: round2(t.profit), attention: t.attention } };
}

module.exports = {
  initServiceDb, catalog, cleanAfa, newReference, createPending, confirmPayment, deliver, refund, refundEvent, retry,
  tick, sweep, refreshAfa, getServiceOrder, publicView, listServiceOrders, REGIONS, STATUSES,
};
