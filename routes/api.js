const express = require('express');
const crypto = require('crypto');
const { initializeTransaction, verifyTransaction } = require('../services/paystack');
const { deliverOrder, attemptCustomerRefund } = require('../services/fulfillment');
const { optionalCustomer, listOffers, resolvePrice } = require('../services/customers');
const {
  createOrder, updateOrder, transitionOrder, claimOrderForFulfillment,
  getOrder, findByProviderReference, getPlans, isNumberBlocked,
  getOrderHistoryByPhone, getRecentOrdersByPhone, getStalePendingOrders, deleteUnpaidOrder, getSettings, normalizePhone, PHONE_RE,
} = require('../services/orderStore');

const router = express.Router();
const attempts = new Map();

function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    let item = attempts.get(key);
    if (!item || now >= item.resetAt) item = { count: 0, resetAt: now + windowMs };
    item.count += 1;
    attempts.set(key, item);
    if (attempts.size > 5000) {
      for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
    }
    if (item.count > max) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    next();
  };
}

const checkoutLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'checkout' });
const historyLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'history' });
const orderLimit = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'order' });

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); } catch { return false; }
}

function rawJson(req) {
  try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '')); }
  catch { return null; }
}

/*
 * Orders are only saved AFTER Paystack confirms the payment. At checkout, the order details are
 * attached to the Paystack transaction as signed metadata. Once the payment succeeds, the order
 * is rebuilt from that metadata. The signature means nobody can invent or change an order by
 * making their own Paystack payment.
 */
const SIGN_FIELDS = ['planId', 'network', 'networkCode', 'capacityGB', 'label', 'priceGHS', 'providerCostGHS',
  'paymentFeeGHS', 'phone', 'email', 'customerId', 'offerId', 'listPriceGHS'];

function signOrderFields(reference, o) {
  const text = ['abrants-order-v1', reference, ...SIGN_FIELDS.map((k) => (o[k] == null ? '' : String(o[k])))].join('|');
  return crypto.createHmac('sha256', process.env.PAYSTACK_SECRET_KEY || '').update(text).digest('hex');
}

// v2: the order is carried as one JSON text and signed exactly as written, so it cannot be
// changed by the way Paystack stores or returns numbers.
function signOrderText(reference, text) {
  return crypto.createHmac('sha256', process.env.PAYSTACK_SECRET_KEY || '').update(`abrants-order-v2|${reference}|${text}`).digest('hex');
}

function orderFromMetadata(reference, tx) {
  let meta = tx && tx.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  const pack = meta && meta.abrants;
  if (!pack || typeof pack.sig !== 'string') { console.warn('Order details missing from Paystack metadata:', reference, meta ? Object.keys(meta).join(',') : 'no metadata'); return null; }
  let o = null;
  if (typeof pack.d === 'string') {
    if (!safeEqualHex(signOrderText(reference, pack.d), pack.sig)) { console.warn('Order signature (v2) did not match:', reference); return null; }
    try { o = JSON.parse(pack.d); } catch { return null; }
  } else if (pack.o) {
    // Older format used during the first deploy.
    if (!safeEqualHex(signOrderFields(reference, pack.o), pack.sig)) { console.warn('Order signature (v1) did not match:', reference); return null; }
    o = pack.o;
  } else { return null; }
  const price = Number(o.priceGHS);
  if (!o.planId || !o.network || !o.networkCode || !Number.isFinite(price) || price <= 0 || !PHONE_RE.test(String(o.phone || ''))) return null;
  // Paystack turns empty values (null) into "" - turn them back so the database accepts them.
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    reference, ...o,
    capacityGB: Number(o.capacityGB), priceGHS: price,
    providerCostGHS: num(o.providerCostGHS), paymentFeeGHS: num(o.paymentFeeGHS),
    customerId: num(o.customerId), offerId: num(o.offerId), listPriceGHS: num(o.listPriceGHS),
    email: o.email || '',
  };
}

function paymentMatchesOrder(tx, order) {
  const amountGHS = Number(tx.amount) / 100;
  return tx.status === 'success'
    && String(tx.reference) === String(order.reference)
    && String(tx.currency || '').toUpperCase() === 'GHS'
    && Math.round(amountGHS * 100) === Math.round(Number(order.priceGHS) * 100);
}

// Only bundles that are switched on in the admin dashboard are shown to customers.
// A logged-in customer also sees their own special prices (decided here, on the server).
router.get('/plans', optionalCustomer(), async (req, res) => {
  try {
    const plans = await getPlans();
    const offers = req.customer ? await listOffers(req.customer.id, { onlyUsable: true }) : [];
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(plans.map((p) => {
      const quote = resolvePrice(p, offers);
      const special = quote.offerId != null;
      return {
        id: p.id, network: p.network, networkCode: p.networkCode, capacityGB: p.capacityGB,
        label: p.label, validity: p.validity, priceGHS: quote.priceGHS,
        pricePerGB: p.capacityGB > 0 ? quote.priceGHS / p.capacityGB : quote.priceGHS,
        special, listPriceGHS: special ? quote.listPriceGHS : undefined, offerTitle: special ? quote.offerTitle : undefined,
      };
    }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load bundles.' }); }
});

// Public storefront settings: announcement banner, support contacts, maintenance notice.
router.get('/settings', async (req, res) => {
  try {
    const s = await getSettings();
    res.json({
      storeName: s.storeName,
      announcement: s.announcement,
      announcementEnabled: Boolean(s.announcementEnabled && s.announcement),
      supportWhatsapp: s.supportWhatsapp || '',
      supportPhone: s.supportPhone || '',
      channelLink: s.channelLink || '',
      maintenanceMode: Boolean(s.maintenanceMode),
      maintenanceMessage: s.maintenanceMessage,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load store settings.' }); }
});

router.post('/checkout', checkoutLimit, optionalCustomer(), async (req, res) => {
  try {
    const { planId } = req.body || {};
    const phone = normalizePhone(req.body?.phone);
    const email = String(req.body?.email || req.customer?.email || '').trim().slice(0, 254);
    const settings = await getSettings();

    if (settings.maintenanceMode) {
      return res.status(503).json({ error: settings.maintenanceMessage || 'The store is temporarily closed. Please try again shortly.' });
    }

    const plans = await getPlans();
    const plan = plans.find((p) => p.id === planId);

    if (!plan) return res.status(400).json({ error: 'That bundle is no longer available. Please pick another one.' });
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number, e.g. 0551234567.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (await isNumberBlocked(phone)) return res.status(403).json({ error: 'This phone number is currently blocked from making purchases. Please contact support.' });

    // The price is always worked out here from the database, never taken from the browser.
    const offers = req.customer ? await listOffers(req.customer.id, { onlyUsable: true }) : [];
    const quote = resolvePrice(plan, offers);
    const priceGHS = quote.priceGHS;

    const reference = `DB-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const estimatedPaymentFeeGHS = Math.round(priceGHS * Number(process.env.PAYSTACK_FEE_RATE || 0.0195) * 100) / 100;

    // Nothing is saved yet: the order is created only when Paystack confirms the payment.
    const orderFields = {
      planId: plan.id, network: plan.network, networkCode: plan.networkCode,
      capacityGB: plan.capacityGB, label: plan.label, priceGHS,
      providerCostGHS: plan.providerCostGHS ?? null, paymentFeeGHS: estimatedPaymentFeeGHS,
      phone, email,
      customerId: req.customer ? req.customer.id : null, offerId: quote.offerId ?? null, listPriceGHS: plan.priceGHS,
    };

    const origin = `${req.protocol}://${req.get('host')}`;
    const tx = await initializeTransaction({
      email, amountGHS: priceGHS, reference,
      metadata: { phone, network: plan.network, label: plan.label, planId: plan.id, abrants: (() => { const d = JSON.stringify(orderFields); return { d, sig: signOrderText(reference, d) }; })() },
      callbackUrl: `${origin}/order-status.html`,
    });
    res.json({ authorizationUrl: tx.authorization_url, reference });
  } catch (err) {
    console.error('Checkout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

// Requires both phone and order reference. This prevents anyone who merely knows a
// phone number from enumerating that customer's purchase history.
// Customer order history.
// Phone number alone shows recent orders.
// If an order reference is provided, only that order is returned.
router.get('/history', historyLimit, async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  const reference = String(req.query.reference || '').trim();

  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({
      error: 'Enter a valid 10-digit Ghana phone number.'
    });
  }

  if (reference && (!/^DB-[A-Za-z0-9-]+$/i.test(reference) || reference.length > 120)) {
    return res.status(400).json({
      error: 'Enter a valid order reference, e.g. DB-1234567890-ab12cd.'
    });
  }

  try {
    let rows = reference
      ? await getOrderHistoryByPhone(phone, reference)
      : await getRecentOrdersByPhone(phone, 20);

    // A paid order may not be saved yet (it is created when Paystack confirms the payment).
    if (reference && !rows.length && /^DB-[A-Za-z0-9-]+$/.test(reference)) {
      try {
        const tx = await verifyTransaction(reference);
        const f = tx && tx.status === 'success' ? orderFromMetadata(reference, tx) : null;
        if (f && f.phone === phone) {
          await confirmAndFulfill(reference, tx);
          rows = await getOrderHistoryByPhone(phone, reference);
        }
      } catch (e) { /* not paid or not known to Paystack: fall through to "not found" */ }
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load order history.'
    });
  }
});

router.post('/webhook/paystack', async (req, res) => {
  const signature = String(req.headers['x-paystack-signature'] || '');
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '').update(req.body).digest('hex');
  if (!safeEqualHex(hash, signature)) return res.sendStatus(401);

  const event = rawJson(req);
  if (!event) return res.status(400).json({ error: 'Invalid JSON.' });

  try {
    if (event.event === 'charge.success' && event.data?.reference) {
      await confirmAndFulfill(event.data.reference, event.data);
    } else if (event.event?.startsWith('refund.') && event.data?.transaction_reference) {
      await handlePaystackRefundEvent(event.event, event.data.transaction_reference, event.data);
    }
  } catch (err) {
    console.error('Paystack webhook processing error:', err.response?.data || err.message);
    // Return 200 only after the signature was valid. Paystack may retry failed webhooks;
    // our DB transitions are idempotent, so retries are safe.
    return res.sendStatus(500);
  }
  res.sendStatus(200);
});

router.post('/webhook/datahustle', async (req, res) => {
  const signature = String(req.headers['x-datahustle-signature'] || '');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  const expected = crypto.createHmac('sha256', process.env.DATAHUSTLE_WEBHOOK_SECRET || '').update(raw).digest('hex');
  if (!safeEqualHex(expected, signature)) return res.status(401).json({ error: 'Invalid signature' });

  const body = rawJson(req);
  if (!body?.event || !body?.data?.transactionId) return res.status(400).json({ error: 'Invalid webhook payload.' });

  try {
    const order = await findByProviderReference(body.data.transactionId);
    if (!order) {
      console.warn('DataHustle webhook for unknown order:', body.data.transactionId);
      return res.json({ status: 'ignored' });
    }

    // The provider's webhook can land before our own DB write that moves the order to
    // 'processing'. Accept the event from either 'processing' or 'paid' so a fast
    // webhook is never silently dropped.
    const advance = async (changes, eventType) => {
      const fromProcessing = await transitionOrder(order.reference, 'processing', changes, eventType);
      if (fromProcessing) return fromProcessing;
      return transitionOrder(order.reference, 'paid', changes, eventType);
    };

    if (body.event === 'order.completed') {
      await advance({ status: 'fulfilled', trackingId: body.data.trackingId || null }, 'delivery.completed');
    } else if (body.event === 'order.failed') {
      const failed = await advance({ status: 'delivery_failed' }, 'delivery.failed');
      if (failed) await attemptCustomerRefund(failed.reference);
    } else if (body.event === 'order.refunded') {
      // This is a provider-wallet refund event. It is NOT proof that the customer was
      // refunded by Paystack, so do not label the customer order as "refunded" here.
      await updateOrder(order.reference, { refundStatus: order.refundStatus || 'provider_refunded' }, 'provider.refunded');
    }
  } catch (err) {
    console.error('DataHustle webhook processing error:', err.response?.data || err.message);
    return res.sendStatus(500);
  }
  res.json({ status: 'success' });
});

router.get('/order/:reference', orderLimit, async (req, res) => {
  let order = await getOrder(req.params.reference);
  if (!order) {
    // No order yet: it only exists once Paystack confirms the payment. Ask Paystack now.
    let tx;
    try { tx = await verifyTransaction(req.params.reference); } catch (e) { return res.status(404).json({ error: 'Order not found.' }); }
    if (tx && tx.status === 'success') {
      try { await confirmAndFulfill(req.params.reference, tx); } catch (e) { console.error('Order confirm error:', e.response?.data || e.message); }
      order = await getOrder(req.params.reference);
    } else {
      const f = orderFromMetadata(req.params.reference, tx);
      if (!f) return res.status(404).json({ error: 'Order not found.' });
      // Payment not finished yet: show it as waiting, without saving anything.
      return res.json({
        reference: f.reference, status: 'pending', label: f.label, network: f.network, capacityGB: f.capacityGB,
        priceGHS: f.priceGHS, phone: f.phone, createdAt: null, updatedAt: null, refundStatus: null,
      });
    }
    if (!order) return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.status === 'pending') {
    try {
      const tx = await verifyTransaction(req.params.reference);
      if (paymentMatchesOrder(tx, order)) await confirmAndFulfill(req.params.reference, tx);
    } catch (e) {
      // Webhook remains the primary confirmation path.
    }
  }
  const fresh = await getOrder(req.params.reference);
  res.json({
    reference: fresh.reference, status: fresh.status, label: fresh.label, network: fresh.network,
    capacityGB: fresh.capacityGB, priceGHS: fresh.priceGHS, phone: fresh.phone,
    createdAt: fresh.createdAt, updatedAt: fresh.updatedAt, refundStatus: fresh.refundStatus,
  });
});

async function confirmAndFulfill(reference, eventData = null) {
  let order = await getOrder(reference);
  let tx = eventData;
  if (!order) {
    // First time we hear about this payment: confirm it with Paystack, then create the order.
    tx = await verifyTransaction(reference);
    if (!tx || tx.status !== 'success') return;
    const fields = orderFromMetadata(reference, tx);
    if (!fields) { console.warn('Paystack payment has no valid order details, ignored:', reference); return; }
    if (String(tx.currency || '').toUpperCase() !== 'GHS' || Math.round(Number(tx.amount)) !== Math.round(Number(fields.priceGHS) * 100)) {
      console.warn('Paystack payment amount does not match the order, ignored:', reference);
      return;
    }
    order = await createOrder(fields);
    if (!order) return;
  }

  // Always verify server-to-server before delivering digital value.
  if (!tx || tx.status !== 'success' || Number(tx.amount) / 100 !== Number(order.priceGHS) || String(tx.currency || '').toUpperCase() !== 'GHS') {
    tx = await verifyTransaction(reference);
  }
  if (!paymentMatchesOrder(tx, order)) {
    console.warn('Payment verification failed for order:', reference);
    return;
  }

  const actualFeeGHS = Number.isFinite(Number(tx.fees)) ? Number(tx.fees) / 100 : null;
  order = await claimOrderForFulfillment(reference, {
    amountGHS: Number(tx.amount) / 100,
    currency: tx.currency,
    feeGHS: actualFeeGHS,
  });
  if (!order) return; // another webhook/poll already claimed it

  await deliverOrder(order);
}

async function handlePaystackRefundEvent(eventName, reference, data) {
  const order = await getOrder(reference);
  if (!order) return;
  const statusMap = {
    'refund.pending': 'pending',
    'refund.processing': 'processing',
    'refund.needs-attention': 'needs_attention',
    'refund.failed': 'failed',
    'refund.processed': 'processed',
  };
  const refundStatus = statusMap[eventName];
  if (!refundStatus) return;
  const nextStatus = refundStatus === 'processed' ? 'refunded' : (['failed', 'needs_attention'].includes(refundStatus) ? 'delivery_failed' : 'refunding');
  await updateOrder(reference, {
    status: nextStatus,
    refundStatus,
    refundId: data.refund_reference || order.refundId || null,
  }, `customer.${eventName}`);
}

/*
 * Clean-up of checkouts that were never paid. An order older than 24 hours that Paystack says
 * was not paid is removed. If Paystack says it WAS paid (a missed webhook), it is delivered instead.
 * Any error from Paystack leaves the order untouched.
 */
async function sweepPendingOrders() {
  const references = await getStalePendingOrders(24, 50);
  let removed = 0, rescued = 0;
  for (const reference of references) {
    try {
      const tx = await verifyTransaction(reference);
      if (tx && tx.status === 'success') {
        await confirmAndFulfill(reference, tx);
        rescued += 1;
      } else if (tx && ['abandoned', 'failed', 'reversed'].includes(tx.status)) {
        if (await deleteUnpaidOrder(reference)) removed += 1;
      }
    } catch (err) {
      console.warn('Pending sweep skipped', reference, err.response?.status || err.message);
    }
  }
  if (removed || rescued) console.log(`Pending sweep: removed ${removed} unpaid, delivered ${rescued} paid.`);
}
router.sweepPendingOrders = sweepPendingOrders;

module.exports = router;
