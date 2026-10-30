/*
 * Result checkers, AFA registration and bills (ECG, Ghana Water, DStv / GOtv / StarTimes):
 * storefront API (/api/services) and admin API (/api/admin/services).
 */
const express = require('express');
const svc = require('../services/serviceOrders');
const fd = require('../services/fdv2');
const tl = require('../services/techlink');
const { initializeTransaction, verifyTransaction } = require('../services/paystack');
const { optionalCustomer } = require('../services/customers');
const { getSettings, saveSettings, isNumberBlocked, normalizePhone, PHONE_RE } = require('../services/orderStore');
const { feeRate, chargeFor, round2 } = require('../services/fees');

const hits = new Map();
function limit(max) {
  return (req, res, next) => {
    const key = `${max}:${req.ip}`; const now = Date.now();
    let h = hits.get(key);
    if (!h || now > h.reset) h = { n: 0, reset: now + 60_000 };
    h.n += 1; hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    if (h.n > max) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    next();
  };
}

// Meter / account numbers: letters and digits only (spaces and dashes typed by customers are dropped).
function cleanAccount(v) {
  const a = String(v == null ? '' : v).replace(/[\s-]/g, '').toUpperCase();
  return /^[0-9A-Z]{5,20}$/.test(a) ? a : null;
}
const notFound = (kind) => ({
  ecg: "We couldn't find this meter number. Check it and try again.",
  water: "We couldn't find this account number. Check it and try again.",
  tv: "We couldn't find this smartcard number. Check it and try again.",
}[kind]);
const tvService = (v) => (tl.TV_SERVICES.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : null);

/* ================================================================ storefront */
const pub = express.Router();

pub.get('/', async (req, res) => {
  try {
    const [c, s, bo] = await Promise.all([svc.catalog(), getSettings(), svc.billOptions()]);
    const customerPays = s.customerPaysFee !== false;
    const bill = (k) => (bo[k].available ? { name: bo[k].name, min: bo[k].min, max: bo[k].max, fee: bo[k].fee, feePercent: bo[k].feePercent } : null);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      checkers: c.checkers.filter((x) => x.available).map((x) => ({ code: x.code, name: x.name, price: x.price, charge: chargeFor(x.price, customerPays), stock: x.stock })),
      afa: c.afa.available ? { price: c.afa.price, charge: chargeFor(c.afa.price, customerPays) } : null,
      bills: { ecg: bill('ecg'), water: bill('water'), tv: bill('tv') },
      regions: c.regions, customerPaysFee: customerPays, feeRate: feeRate(),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load.' }); }
});

// Shows whose meter / account it is (and the amount owed, for water) before the customer pays.
pub.post('/bills/lookup', limit(10), async (req, res) => {
  try {
    const kind = String(req.body?.kind || '');
    if (!svc.isBill(kind)) return res.status(400).json({ error: 'Choose a bill.' });
    const opts = await svc.billOptions();
    if (!opts[kind].available) return res.status(409).json({ error: 'This bill payment is not available right now.' });
    const account = cleanAccount(req.body?.account);
    if (!account) return res.status(400).json({ error: notFound(kind), field: 'account' });
    const service = kind === 'tv' ? tvService(req.body?.service) : null;
    if (kind === 'tv' && !service) return res.status(400).json({ error: 'Choose DStv, GOtv or StarTimes.', field: 'service' });
    let who;
    try { who = await tl.lookup(kind, account, service); } catch (e) {
      if (e.kind === 'rejected' && e.status !== 401 && e.status !== 403) return res.status(404).json({ error: notFound(kind), field: 'account' });
      console.warn('Bill lookup failed:', e.kind, e.message);
      return res.status(502).json({ error: 'We could not check this right now. Please try again in a moment.' });
    }
    if (!who.name) return res.status(404).json({ error: notFound(kind), field: 'account' });
    res.json({ account, name: who.name, area: who.area || null, amountDue: who.amountDue, packageName: who.packageName || null, dueDate: who.dueDate || null });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not check. Please try again.' }); }
});

pub.post('/checkout', limit(15), optionalCustomer(), async (req, res) => {
  try {
    const s = await getSettings();
    if (s.maintenanceMode) return res.status(503).json({ error: s.maintenanceMessage || 'The store is temporarily closed.' });
    const b = req.body || {};
    const email = String(b.email || req.customer?.email || '').trim().slice(0, 254);
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.', field: 'email' });
    const c = await svc.catalog();
    const reference = svc.newReference(b.kind);
    let order;

    if (b.kind === 'checker') {
      const item = c.checkers.find((x) => x.code === String(b.code || '').toUpperCase());
      if (!item || !item.available) return res.status(409).json({ error: 'This checker is not available right now.' });
      const quantity = Math.floor(Number(b.quantity || 1));
      if (!(quantity >= 1 && quantity <= 5)) return res.status(400).json({ error: 'Choose 1 to 5 checkers.', field: 'quantity' });
      if (item.stock != null && item.stock < quantity) return res.status(409).json({ error: `Only ${item.stock} left.`, field: 'quantity' });
      const phone = normalizePhone(b.phone);
      if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.', field: 'phone' });
      order = { kind: 'checker', code: item.code, name: item.name, checkerTypeId: item.id, quantity, phone,
        priceGHS: round2(item.price * quantity), costGHS: item.cost == null ? null : round2(item.cost * quantity) };
    } else if (b.kind === 'afa') {
      if (!c.afa.available) return res.status(409).json({ error: 'AFA registration is not available right now.' });
      const v = svc.cleanAfa(b);
      if (v.error) return res.status(400).json({ error: v.error, field: v.field });
      order = { kind: 'afa', code: 'AFA', name: 'AFA registration', quantity: 1, phone: v.phone, afa: v.afa,
        priceGHS: round2(c.afa.price), costGHS: c.afa.cost };
    } else if (svc.isBill(b.kind)) {
      const opts = await svc.billOptions();
      const conf = opts[b.kind];
      if (!conf.available) return res.status(409).json({ error: 'This bill payment is not available right now.' });
      const account = cleanAccount(b.account);
      if (!account) return res.status(400).json({ error: notFound(b.kind), field: 'account' });
      const amount = round2(Number(b.amount));
      if (!(amount >= conf.min && amount <= conf.max)) return res.status(400).json({ error: `Enter an amount from GH₵${conf.min.toFixed(2)} to GH₵${conf.max.toFixed(2)}.`, field: 'amount' });
      const phone = normalizePhone(b.phone);
      if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.', field: 'phone' });
      const service = b.kind === 'tv' ? tvService(b.service) : null;
      if (b.kind === 'tv' && !service) return res.status(400).json({ error: 'Choose DStv, GOtv or StarTimes.', field: 'service' });
      // Check the name again on the server, so the order records whose bill was really paid.
      let who;
      try { who = await tl.lookup(b.kind, account, service); } catch (e) {
        if (e.kind === 'rejected' && e.status !== 401 && e.status !== 403) return res.status(404).json({ error: notFound(b.kind), field: 'account' });
        return res.status(502).json({ error: 'We could not check this right now. Please try again in a moment.' });
      }
      if (!who.name) return res.status(404).json({ error: notFound(b.kind), field: 'account' });
      const q = svc.quoteBill(b.kind, amount, opts);
      order = { kind: b.kind, code: service || b.kind.toUpperCase(), name: service ? `${svc.TV_NAMES[service]} subscription` : svc.BILL_NAMES[b.kind],
        quantity: 1, phone, account, accountName: who.name, priceGHS: q.priceGHS, costGHS: q.costGHS,
        details: { billAmount: amount, serviceFeeGHS: q.serviceFeeGHS, area: who.area || null, amountDue: who.amountDue,
          ...(service ? { service, packageName: who.packageName || null, dueDate: who.dueDate || null } : {}) } };
    } else {
      return res.status(400).json({ error: 'Choose what to buy.' });
    }

    if (await isNumberBlocked(order.phone)) return res.status(403).json({ error: 'This phone number is blocked from making purchases. Please contact support.' });
    const customerPays = s.customerPaysFee !== false;
    const charge = chargeFor(order.priceGHS, customerPays);
    const customerFeeGHS = round2(charge - order.priceGHS);
    await svc.createPending({ ...order, reference, email, customerFeeGHS,
      paymentFeeGHS: round2(charge * feeRate() - customerFeeGHS), customerId: req.customer ? req.customer.id : null });

    const tx = await initializeTransaction({
      email, amountGHS: charge, reference,
      // Personal details stay in our database; Paystack only sees what was bought.
      metadata: { service: order.kind, item: order.name, quantity: order.quantity },
      callbackUrl: `${req.protocol}://${req.get('host')}/${svc.isBill(order.kind) ? 'bills' : 'services'}.html`,
    });
    res.json({ authorizationUrl: tx.authorization_url, reference });
  } catch (err) {
    console.error('Service checkout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

pub.get('/order/:reference', limit(60), async (req, res) => {
  try {
    const ref = String(req.params.reference || '');
    if (!/^SV-[A-Z0-9-]{10,60}$/.test(ref)) return res.status(404).json({ error: 'Order not found.' });
    let o = await svc.getServiceOrder(ref);
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    if (o.status === 'pending') {
      try { o = (await svc.confirmPayment(ref, await verifyTransaction(ref))) || o; } catch { /* not paid yet */ }
    }
    if (o.status === 'submitted') o = svc.isBill(o.kind) ? await svc.refreshBill(o) : await svc.refreshAfa(o);
    res.setHeader('Cache-Control', 'no-store');
    res.json(svc.publicView(o));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load the order.' }); }
});

/* ================================================================ admin */
function admin(audit) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const [c, list, bills] = await Promise.all([svc.catalog({ fresh: true }), svc.listServiceOrders({ status: req.query.status, search: req.query.search }), svc.billOptions()]);
      let wallet = null, techlinkWallet = null;
      if (c.connected) { try { wallet = Number((await fd.wallet()).wallet_balance); } catch { wallet = null; } }
      if (bills.connected) { try { techlinkWallet = await tl.balance(); } catch { techlinkWallet = null; } }
      res.json({ ...c, wallet, ...list, bills, techlinkWallet });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load checkers and AFA.' }); }
  });

  r.put('/prices', async (req, res) => {
    try {
      const b = req.body || {};
      const price = (v) => (v === '' || v == null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 10000 ? round2(v) : NaN));
      const checkers = {};
      for (const [code, v] of Object.entries(b.checkers || {})) {
        if (!/^[A-Z0-9_ -]{1,30}$/i.test(code)) continue;
        const p = price(v && v.price);
        if (Number.isNaN(p)) return res.status(400).json({ error: `Check the price for ${code}.` });
        checkers[code.toUpperCase()] = { price: p, enabled: Boolean(v && v.enabled) };
      }
      const afaPrice = price(b.afa && b.afa.price);
      if (Number.isNaN(afaPrice)) return res.status(400).json({ error: 'Check the AFA price.' });
      const s = await getSettings();
      const next = { checkers: { ...((s.services || {}).checkers || {}), ...checkers }, afa: { price: afaPrice, enabled: Boolean(b.afa && b.afa.enabled) } };
      await saveSettings({ services: next });
      await audit(req, 'services.prices', next);
      res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save prices.' }); }
  });

  r.put('/bills', async (req, res) => {
    try {
      const b = req.body || {};
      const num = (v, lo, hi, what) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error(`Check the ${what}.`), { user: true });
        return round2(n);
      };
      const one = (k, label) => {
        const c = b[k] || {};
        const min = num(c.min, 1, 10000, `${label} smallest amount`), max = num(c.max, 1, 10000, `${label} largest amount`);
        if (min > max) throw Object.assign(new Error(`${label}: the smallest amount must be below the largest.`), { user: true });
        return { enabled: Boolean(c.enabled), fee: num(c.fee ?? 0, 0, 1000, `${label} service fee`), feePercent: num(c.feePercent ?? 0, 0, 50, `${label} service fee %`), min, max };
      };
      const current = svc.billSettings(await getSettings());
      // A bill left out of the request keeps its current settings.
      const keep = (k, label) => (b[k] ? one(k, label) : current[k]);
      const next = { ecg: keep('ecg', 'Electricity'), water: keep('water', 'Water'), tv: keep('tv', 'TV'), techlinkFeePercent: num(b.techlinkFeePercent ?? current.techlinkFeePercent ?? 0, 0, 50, 'Techlink fee %') };
      await saveSettings({ bills: next });
      await audit(req, 'services.bills', next);
      res.json({ ok: true });
    } catch (err) {
      if (err.user) return res.status(400).json({ error: err.message });
      console.error(err); res.status(500).json({ error: 'Could not save bill settings.' });
    }
  });

  // Recent Techlink orders, to check a bill payment that got no answer before retrying it.
  r.get('/techlink/orders', async (req, res) => {
    try {
      const rows = await tl.recentOrders(25);
      res.json(rows.map((o) => ({
        orderId: o.orderId || o.id, product: o.productName || o.productType || '', phone: o.phoneNumber || o.phone || '',
        account: o.meter || o.account || o.meterNumber || o.accountNumber || '', amount: o.amount, status: o.status || '', date: o.createdAt || o.created_at || null,
      })));
    } catch (err) { res.status(502).json({ error: 'Could not reach Techlink: ' + (err.message || 'error') }); }
  });

  r.get('/orders/:reference', async (req, res) => {
    const o = await svc.getServiceOrder(req.params.reference);
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    res.json(o);
  });

  r.post('/orders/:reference/retry', async (req, res) => {
    try {
      const o = await svc.retry(req.params.reference);
      await audit(req, 'services.retry', { reference: req.params.reference, status: o && o.status });
      res.json(o);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Could not retry.' }); }
  });

  r.post('/orders/:reference/refund', async (req, res) => {
    try {
      const before = await svc.getServiceOrder(req.params.reference);
      if (!before || !['failed', 'review', 'rejected'].includes(before.status)) return res.status(409).json({ error: 'Only failed, stuck or rejected orders can be refunded here.' });
      const o = await svc.refund(req.params.reference);
      await audit(req, 'services.refund', { reference: req.params.reference, status: o && o.status });
      res.json(o);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Could not refund.' }); }
  });

  return r;
}

module.exports = { pub, admin };
