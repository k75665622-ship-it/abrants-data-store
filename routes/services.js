/*
 * Result checkers and AFA registration: storefront API (/api/services) and admin API (/api/admin/services).
 */
const express = require('express');
const svc = require('../services/serviceOrders');
const fd = require('../services/fdv2');
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

/* ================================================================ storefront */
const pub = express.Router();

pub.get('/', async (req, res) => {
  try {
    const [c, s] = await Promise.all([svc.catalog(), getSettings()]);
    const customerPays = s.customerPaysFee !== false;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      checkers: c.checkers.filter((x) => x.available).map((x) => ({ code: x.code, name: x.name, price: x.price, charge: chargeFor(x.price, customerPays), stock: x.stock })),
      afa: c.afa.available ? { price: c.afa.price, charge: chargeFor(c.afa.price, customerPays) } : null,
      regions: c.regions, customerPaysFee: customerPays, feeRate: feeRate(),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load.' }); }
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
      callbackUrl: `${req.protocol}://${req.get('host')}/services.html`,
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
    if (o.status === 'submitted') o = await svc.refreshAfa(o);
    res.setHeader('Cache-Control', 'no-store');
    res.json(svc.publicView(o));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load the order.' }); }
});

/* ================================================================ admin */
function admin(audit) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try {
      const [c, list] = await Promise.all([svc.catalog({ fresh: true }), svc.listServiceOrders({ status: req.query.status, search: req.query.search })]);
      let wallet = null;
      if (c.connected) { try { wallet = Number((await fd.wallet()).wallet_balance); } catch { wallet = null; } }
      res.json({ ...c, wallet, ...list });
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
