const express = require('express');
const { requireAdmin, login, logout, session } = require('../services/adminAuth');
const {
  getAllOrders, getOrdersPage, getOrderStats, getOrderEvents, getOrder,
  getPlans, getPlan, createPlan, updatePlan, updatePlanPrice, updatePlanProviderCost, deletePlan,
  getBlockedNumbers, blockNumber, unblockNumber,
  getSettings, saveSettings, logAdminAction, getAuditLog,
  updateOrder, normalizePhone, PHONE_RE, ORDER_STATUSES, countOldOrders, deleteOldOrders,
} = require('../services/orderStore');
const { getWalletBalance, getWebhookStatus, setWebhookActive } = require('../services/datahustle');
const providers = require('../services/providers');
const fastdeals = require('../services/fastdeals');
const { refundTransaction } = require('../services/paystack');
const {
  listCustomersAdmin, customerSummary, getCustomer, listOffers, createOffers, deactivateOffer,
  createNotice, createNoticeForMany, listNotices, listCustomerOrders, customerIdsWhere,
  setPassword, setCustomerStatus, setCustomerNote, passwordProblem,
} = require('../services/customers');
const crypto = require('crypto');

const router = express.Router();

function audit(req, action, details = {}) {
  return logAdminAction(action, details, req.ip || req.socket?.remoteAddress || null);
}

router.post('/login', login);
router.post('/logout', logout);
router.get('/session', session);

router.use(requireAdmin);

/* ---------------------------------------------------------------- */
/* Dashboard                                                         */
/* ---------------------------------------------------------------- */

router.get('/stats', async (req, res) => {
  try {
    const [stats, settings] = await Promise.all([getOrderStats(), getSettings()]);
    let wallet = null;
    try { wallet = Number(await getWalletBalance() || 0); } catch { wallet = null; }
    res.json({
      ...stats,
      wallet,
      mockMode: process.env.DATAHUSTLE_MOCK_MODE === 'true',
      lowWallet: wallet != null && settings.lowWalletThreshold > 0 && wallet < Number(settings.lowWalletThreshold),
      lowWalletThreshold: Number(settings.lowWalletThreshold || 0),
      maintenanceMode: Boolean(settings.maintenanceMode),
      notices: Array.isArray(settings.adminAlerts) ? settings.adminAlerts : [],
      pausedNetworks: Array.isArray(settings.pausedNetworks) ? settings.pausedNetworks : [],
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load dashboard statistics.' }); }
});

router.post('/notices/dismiss', async (req, res) => {
  try {
    const id = String(req.body?.id || '');
    const s = await getSettings();
    const list = (Array.isArray(s.adminAlerts) ? s.adminAlerts : []).filter((a) => id !== 'all' && a.id !== id);
    await saveSettings({ adminAlerts: list });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not dismiss.' }); }
});

/* ---------------------------------------------------------------- */
/* Orders                                                            */
/* ---------------------------------------------------------------- */

// What DataHustle itself says about the webhook (with anything secret removed), so the owner can
// see from a phone whether it is on, where it points and how recent deliveries were answered.
function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!/secret|api.?key|token|password/i.test(k)) out[k] = stripSecrets(v);
    return out;
  }
  return value;
}

router.get('/datahustle/webhook', async (req, res) => {
  try {
    const provider = await getWebhookStatus();
    res.json({
      secretSetOnServer: Boolean(process.env.DATAHUSTLE_WEBHOOK_SECRET),
      expectedUrl: `${req.protocol}://${req.get('host')}/api/webhook/datahustle`,
      provider: stripSecrets(provider),
    });
  } catch (err) {
    console.error('Webhook status error:', err.response?.data || err.message);
    res.status(502).json({
      error: 'Could not reach DataHustle: ' + (err.response?.data?.message || err.message),
      secretSetOnServer: Boolean(process.env.DATAHUSTLE_WEBHOOK_SECRET),
    });
  }
});

router.post('/datahustle/webhook/enable', async (req, res) => {
  try {
    const provider = await setWebhookActive(true);
    await audit(req, 'datahustle.webhook_enable', {});
    res.json({ ok: true, provider: stripSecrets(provider) });
  } catch (err) {
    console.error('Webhook enable error:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not switch the webhook on: ' + (err.response?.data?.message || err.message) });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const { status, search, network, from, to, page, pageSize, limit, offset } = req.query;
    // Backwards-compatible: no page/pageSize means the old flat-array response.
    if (page == null && pageSize == null) {
      return res.json(await getAllOrders({ status, search, network, from, to, limit, offset }));
    }
    res.json(await getOrdersPage({ status, search, network, from, to, page, pageSize }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load orders.' }); }
});

// Fetch one order directly. This avoids relying on the paginated/search response
// when the admin opens an order from the Orders table.
router.get('/orders/cleanup-preview', async (req, res) => {
  try {
    const months = [6, 12].includes(Number(req.query.months)) ? Number(req.query.months) : 6;
    res.json(await countOldOrders(months));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not check old orders.' }); }
});

router.get('/orders/:reference', async (req, res, next) => {
  if (req.params.reference === 'export') return next();
  try {
    const reference = String(req.params.reference || '').trim();
    const order = await getOrder(reference);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load this order.' });
  }
});

router.get('/orders/export', async (req, res) => {
  try {
    const { status, search, network, from, to } = req.query;
    const rows = await getAllOrders({ status, search, network, from, to, limit: 500, offset: 0 });
    const header = [
      'Reference', 'Date', 'Status', 'Network', 'Bundle', 'Size (GB)', 'Customer paid (GHS)',
      'Provider cost (GHS)', 'Paystack fee (GHS)', 'Est. profit (GHS)', 'Phone', 'Email',
      'Provider ref', 'Tracking ID', 'Refund status',
    ];
    const csvCell = (value) => {
      let s = value == null ? '' : String(value);
      // Treat customer-controlled cells as text, never spreadsheet formulas.
      if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const o of rows) {
      lines.push([
        o.reference, new Date(o.createdAt).toISOString(), o.status, o.network, o.label, o.capacityGB,
        o.priceGHS, o.providerCostGHS, o.paymentFeeGHS, o.estimatedProfitGHS, o.phone, o.email,
        o.providerReference, o.trackingId, o.refundStatus,
      ].map(csvCell).join(','));
    }
    await audit(req, 'orders.export', { rows: rows.length, status: status || 'all' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="abrants-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not export orders.' }); }
});

router.get('/orders/:reference/events', async (req, res) => {
  try { res.json(await getOrderEvents(req.params.reference)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not load order history.' }); }
});

// Manual status override for edge cases support staff need to fix by hand.
router.post('/orders/:reference/status', async (req, res) => {
  try {
    const reference = String(req.params.reference || '');
    const status = String(req.body?.status || '');
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown order status.' });
    const order = await getOrder(reference);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    const updated = await updateOrder(reference, { status }, `admin.status.${status}`);
    await audit(req, 'order.status', { reference, from: order.status, to: status });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not update order status.' }); }
});

router.post('/orders/:reference/note', async (req, res) => {
  try {
    const reference = String(req.params.reference || '');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const order = await getOrder(reference);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    const updated = await updateOrder(reference, { adminNote: note || null }, 'admin.note');
    await audit(req, 'order.note', { reference });
    res.json(updated);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save the note.' }); }
});

// Re-attempt delivery for an order whose provider result was ambiguous.
router.post('/orders/:reference/retry', async (req, res) => {
  try {
    const reference = String(req.params.reference || '');
    const order = await getOrder(reference);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (!['delivery_review', 'delivery_failed', 'paid'].includes(order.status)) {
      return res.status(400).json({ error: 'Only paid, failed or under-review orders can be retried.' });
    }
    if (order.providerReference) {
      return res.status(409).json({ error: 'The provider already accepted this order. Check the tracking ID before retrying.' });
    }

    const provider = providers.providerFor(await getSettings(), order.network);
    const result = await providers.purchase(provider, order);
    if (!result.accepted) {
      const failed = await updateOrder(reference, { status: 'delivery_failed' }, 'admin.retry.failed');
      await audit(req, 'order.retry', { reference, result: 'rejected' });
      return res.status(502).json({ error: 'The provider rejected the retry.', order: failed });
    }
    const changes = { status: result.delivered ? 'fulfilled' : 'processing', provider, providerReference: result.transactionReference, purchaseId: result.purchaseId };
    if (Number.isFinite(Number(result.priceGHS))) changes.providerCostGHS = Number(result.priceGHS);
    const updated = await updateOrder(reference, changes, 'admin.retry.accepted');
    await audit(req, 'order.retry', { reference, result: 'accepted' });
    res.json(updated);
  } catch (err) {
    console.error('Retry error:', err.response?.data || err.message);
    await audit(req, 'order.retry', { reference: req.params.reference, result: 'error' });
    const why = String(err.response?.data?.message || err.response?.data?.error || err.message || '').slice(0, 160);
    res.status(502).json({ error: 'The retry could not be confirmed' + (why ? ' (' + why + ')' : '') + '. The order was left under review. If the provider has no record of it, use Refund customer.' });
  }
});

router.post('/orders/cleanup', async (req, res) => {
  try {
    const months = [6, 12].includes(Number(req.body?.months)) ? Number(req.body.months) : 6;
    if (String(req.body?.confirm || '') !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
    const deleted = await deleteOldOrders(months);
    await audit(req, 'orders.cleanup', { months, deleted });
    res.json({ deleted, months });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not delete old orders.' }); }
});

router.post('/orders/:reference/refund', async (req, res) => {
  try {
    const ref = String(req.params.reference || '');
    const order = await getOrder(ref);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (!['delivery_failed', 'delivery_review', 'paid'].includes(order.status)) return res.status(400).json({ error: 'Only failed/paid orders can be refunded.' });
    if (order.source === 'gift' || Number(order.priceGHS) <= 0) return res.status(400).json({ error: 'This was a free bundle, so there is nothing to refund.' });
    if (['refunding', 'refunded'].includes(order.status) || ['pending', 'processing', 'processed', 'queued'].includes(order.refundStatus || '')) {
      return res.status(409).json({ error: 'This order has already been refunded or a refund is in progress. Do not refund it again.' });
    }
    const refund = await refundTransaction(order.reference, order.priceGHS);
    const updated = await updateOrder(order.reference, {
      status: 'refunding', refundId: refund?.id ? String(refund.id) : null,
      refundStatus: refund?.status || 'pending',
    }, 'customer.refund.queued.manual');
    await audit(req, 'order.refund', { reference: order.reference, amount: order.priceGHS });
    res.json(updated);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(502).json({ error: 'Could not start the refund. Check Paystack and try again.' });
  }
});

/* ---------------------------------------------------------------- */
/* Bundles                                                           */
/* ---------------------------------------------------------------- */

router.get('/plans', async (req, res) => {
  try { res.json(await getPlans({ includeInactive: true })); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not load bundle settings.' }); }
});

router.post('/plans', async (req, res) => {
  try {
    const result = await createPlan(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    await audit(req, 'plan.create', { planId: result.plan.id, label: result.plan.label, price: result.plan.priceGHS });
    res.status(201).json(result.plan);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not create this bundle.' }); }
});

router.put('/plans/:planId', async (req, res) => {
  try {
    const body = req.body || {};
    const changes = {};

    if (body.priceGHS != null) {
      const priceGHS = Number(body.priceGHS);
      if (!Number.isFinite(priceGHS) || priceGHS < 0.01 || priceGHS > 10000) {
        return res.status(400).json({ error: 'Enter a valid price between GH₵0.01 and GH₵10,000.' });
      }
      changes.priceGHS = priceGHS;
    }
    if (body.providerCostGHS != null) {
      const cost = Number(body.providerCostGHS);
      if (!Number.isFinite(cost) || cost < 0 || cost > 10000) {
        return res.status(400).json({ error: 'Enter a valid provider cost between GH₵0.00 and GH₵10,000.' });
      }
      changes.providerCostGHS = cost;
    }
    if (body.active != null) changes.active = Boolean(body.active);
    if (body.label != null) changes.label = String(body.label).trim().slice(0, 40);
    if (body.validity != null) changes.validity = String(body.validity).trim().slice(0, 40) || '30 days';
    if (body.capacityGB != null) {
      const gb = Number(body.capacityGB);
      if (!Number.isFinite(gb) || gb <= 0 || gb > 5000) return res.status(400).json({ error: 'Enter a valid bundle size in GB.' });
      changes.capacityGB = gb;
    }
    if (body.network != null) changes.network = String(body.network).trim().slice(0, 40);
    if (body.networkCode != null) changes.networkCode = String(body.networkCode).trim().slice(0, 40);

    const plan = await updatePlan(req.params.planId, changes);
    if (!plan) return res.status(404).json({ error: 'Bundle not found.' });
    await audit(req, 'plan.update', { planId: plan.id, changes });
    res.json(plan);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not update this bundle.' }); }
});

router.put('/plans/:planId/cost', async (req, res) => {
  try {
    const providerCostGHS = Number(req.body.providerCostGHS);
    if (!Number.isFinite(providerCostGHS) || providerCostGHS < 0 || providerCostGHS > 10000) {
      return res.status(400).json({ error: 'Enter a valid provider cost between GH₵0.00 and GH₵10,000.' });
    }
    const plan = await updatePlanProviderCost(req.params.planId, providerCostGHS);
    if (!plan) return res.status(404).json({ error: 'Bundle not found.' });
    await audit(req, 'plan.cost', { planId: plan.id, providerCostGHS });
    res.json(plan);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not update provider cost.' }); }
});

router.delete('/plans/:planId', async (req, res) => {
  try {
    const result = await deletePlan(req.params.planId);
    if (!result) return res.status(404).json({ error: 'Bundle not found.' });
    await audit(req, 'plan.delete', { planId: req.params.planId, ...result });
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not remove this bundle.' }); }
});

/* ---------------------------------------------------------------- */
/* Customers, offers and notices                                     */
/* ---------------------------------------------------------------- */

router.get('/customers', async (req, res) => {
  try {
    const { search, sort, minWeek, page, pageSize } = req.query;
    const [list, summary] = await Promise.all([
      listCustomersAdmin({ search, sort, minWeekOrders: minWeek, page, pageSize }),
      customerSummary(),
    ]);
    res.json({ ...list, summary });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load customers.' }); }
});

router.get('/customers/:id', async (req, res) => {
  try {
    const customer = await getCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const [offers, orders, notices, plans] = await Promise.all([
      listOffers(customer.id), listCustomerOrders(customer.id, 15), listNotices(customer.id, 10), getPlans({ includeInactive: true }),
    ]);
    const byId = new Map(plans.map((p) => [p.id, p]));
    res.json({
      customer: {
        id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, status: customer.status,
        adminNote: customer.adminNote, createdAt: customer.createdAt, lastLoginAt: customer.lastLoginAt,
      },
      offers: offers.map((o) => {
        const plan = o.planId ? byId.get(o.planId) : null;
        return { ...o, planLabel: plan ? `${plan.network} ${plan.label}` : null };
      }),
      orders, notices,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load this customer.' }); }
});

// Give an offer (special price, % off, or free bundle) to one or many chosen customers.
router.post('/offers', async (req, res) => {
  try {
    const ids = await customerIdsWhere(req.body?.customerIds);
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one active customer.' });
    const plans = await getPlans({ includeInactive: true });
    const result = await createOffers(ids, req.body || {}, new Map(plans.map((p) => [p.id, p])));
    if (result.error) return res.status(400).json({ error: result.error });
    const first = result.offers[0];
    await audit(req, 'offer.create', { customers: ids.length, kind: first.kind, planId: first.planId, value: first.value, maxUses: first.maxUses, title: first.title });
    res.status(201).json({ created: result.offers.length });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save this offer.' }); }
});

router.delete('/customers/:id/offers/:offerId', async (req, res) => {
  try {
    const offer = await deactivateOffer(req.params.id, req.params.offerId);
    if (!offer) return res.status(404).json({ error: 'Offer not found.' });
    await audit(req, 'offer.cancel', { customerId: Number(req.params.id), offerId: offer.id, title: offer.title });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not cancel this offer.' }); }
});

router.post('/notices', async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 100);
    const body = String(req.body?.body || '').trim().slice(0, 600);
    if (!title || !body) return res.status(400).json({ error: 'Write a title and a message.' });
    const ids = await customerIdsWhere(req.body?.customerIds);
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one active customer.' });
    const sent = await createNoticeForMany(ids, title, body);
    await audit(req, 'notice.send', { customers: sent, title });
    res.status(201).json({ sent });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not send the notice.' }); }
});

// Gives the customer a one-time temporary password (shown once to the admin).
router.post('/customers/:id/reset-password', async (req, res) => {
  try {
    const customer = await getCustomer(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let temp = '';
    for (const b of crypto.randomBytes(10)) temp += alphabet[b % alphabet.length];
    if (passwordProblem(temp)) return res.status(500).json({ error: 'Try again.' });
    await setPassword(customer.id, temp, true);
    await audit(req, 'customer.reset_password', { customerId: customer.id, phone: customer.phone });
    res.json({ temporaryPassword: temp });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not reset the password.' }); }
});

router.post('/customers/:id/status', async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Unknown status.' });
    const customer = await setCustomerStatus(req.params.id, status);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    await audit(req, 'customer.status', { customerId: customer.id, status });
    res.json({ ok: true, status: customer.status });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not update this customer.' }); }
});

router.post('/customers/:id/note', async (req, res) => {
  try {
    const customer = await setCustomerNote(req.params.id, String(req.body?.note || '').trim().slice(0, 500));
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    await audit(req, 'customer.note', { customerId: customer.id });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save the note.' }); }
});

/* ---------------------------------------------------------------- */
/* Blocked numbers                                                   */
/* ---------------------------------------------------------------- */

router.get('/blocked-numbers', async (req, res) => {
  try { res.json(await getBlockedNumbers(req.query.search)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not load blocked numbers.' }); }
});

router.post('/blocked-numbers', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit Ghana phone number.' });
    const row = await blockNumber(phone, reason);
    await audit(req, 'number.block', { phone, reason });
    res.json(row);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not block this number.' }); }
});

router.delete('/blocked-numbers/:phone', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    await unblockNumber(phone);
    await audit(req, 'number.unblock', { phone });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not unblock this number.' }); }
});

/* ---------------------------------------------------------------- */
/* Settings, wallet and audit log                                    */
/* ---------------------------------------------------------------- */

router.get('/settings', async (req, res) => {
  try { res.json(await getSettings()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not load settings.' }); }
});

router.put('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.storeName != null) patch.storeName = String(body.storeName).trim().slice(0, 60) || 'Abrants Data Store';
    if (body.announcement != null) patch.announcement = String(body.announcement).trim().slice(0, 200);
    if (body.announcementEnabled != null) patch.announcementEnabled = Boolean(body.announcementEnabled);
    if (body.supportWhatsapp != null) patch.supportWhatsapp = String(body.supportWhatsapp).replace(/[^\d+]/g, '').slice(0, 20);
    if (body.supportPhone != null) patch.supportPhone = String(body.supportPhone).replace(/[^\d+]/g, '').slice(0, 20);
    if (body.channelLink != null) {
      const link = String(body.channelLink).trim().slice(0, 300);
      if (link && !/^https:\/\/(www\.)?(whatsapp\.com\/channel\/|chat\.whatsapp\.com\/)[A-Za-z0-9_-]+\/?$/i.test(link)) {
        return res.status(400).json({ error: 'Please paste a valid WhatsApp channel or group link (it starts with https://whatsapp.com/channel/ or https://chat.whatsapp.com/).' });
      }
      patch.channelLink = link;
    }
    if (body.providers != null && typeof body.providers === 'object') {
      const current = (await getSettings()).providers || {};
      const next = { ...current };
      for (const net of ['MTN', 'Telecel', 'AirtelTigo']) {
        if (body.providers[net] == null) continue;
        if (!providers.PROVIDER_NAMES.includes(body.providers[net])) return res.status(400).json({ error: 'Unknown delivery provider.' });
        if (body.providers[net] === 'fastdeals' && !fastdeals.configured()) {
          return res.status(400).json({ error: 'FastDealsGH is not connected yet. Add FASTDEALS_API_KEY in Render first.' });
        }
        next[net] = body.providers[net];
      }
      patch.providers = next;
    }
    if (Array.isArray(body.pausedNetworks)) {
      patch.pausedNetworks = ['MTN', 'Telecel', 'AirtelTigo'].filter((n) => body.pausedNetworks.includes(n));
      const cur = (await getSettings()).autoPaused || {};
      patch.autoPaused = Object.fromEntries(Object.entries(cur).filter(([n]) => patch.pausedNetworks.includes(n)));
    }
    if (body.pauseMessage != null) patch.pauseMessage = String(body.pauseMessage).trim().slice(0, 300);
    if (body.maintenanceMode != null) patch.maintenanceMode = Boolean(body.maintenanceMode);
    if (body.maintenanceMessage != null) patch.maintenanceMessage = String(body.maintenanceMessage).trim().slice(0, 200);
    if (body.lowWalletThreshold != null) {
      const t = Number(body.lowWalletThreshold);
      patch.lowWalletThreshold = Number.isFinite(t) && t >= 0 && t <= 100000 ? t : 0;
    }
    const before = (await getSettings()).providers || {};
    const settings = await saveSettings(patch);
    await audit(req, 'settings.update', patch);
    // When the admin switches a network to another provider, send that network's orders that were
    // refused for being out of stock to the new provider (they were never bought, so this is safe).
    if (patch.providers) {
      const changed = Object.keys(patch.providers).filter((n) => (before[n] || 'datahustle') !== patch.providers[n]);
      if (changed.length) {
        const { retryOutOfStockOrders } = require('../services/fulfillment');
        changed.reduce((chain, n) => chain.then(() => retryOutOfStockOrders(n)), Promise.resolve())
          .catch((e) => console.error('Re-sending waiting orders failed:', e.message));
      }
    }
    res.json(settings);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save settings.' }); }
});

// FastDealsGH: balance, plus how each of our bundles lines up with one of their plans.
router.get('/fastdeals', async (req, res) => {
  if (!fastdeals.configured()) return res.json({ keySet: false });
  try {
    const [balance, ours] = await Promise.all([fastdeals.getWalletBalance(), getPlans()]);
    const rows = [];
    for (const p of ours) {
      let match = null, problem = null;
      try { match = await fastdeals.findPlan(p.network, p.capacityGB, { fresh: true }); } catch (e) { problem = e.response?.status ? 'HTTP ' + e.response.status : e.message; }
      rows.push({
        network: p.network, label: p.label, ourCost: p.providerCostGHS, ourPrice: p.priceGHS,
        theirName: match ? match.name : null, theirPrice: match && match.price != null ? Number(match.price) : null, problem,
      });
    }
    res.json({ keySet: true, balance: balance == null ? null : Number(balance), plans: rows });
  } catch (err) {
    console.error('FastDeals check error:', err.response?.data || err.message);
    res.status(502).json({ keySet: true, error: 'Could not reach FastDealsGH: ' + (err.response?.data?.message || err.message) });
  }
});

router.get('/wallet', async (req, res) => {
  const settings = await getSettings();
  const pv = settings.providers || {};
  const used = ['MTN', 'Telecel', 'AirtelTigo'].map((n) => pv[n] || 'datahustle');
  let dh = null;
  try { dh = Number(await getWalletBalance() || 0); } catch { dh = null; }
  let fd = null;
  if (fastdeals.configured()) {
    try { const b = await fastdeals.getWalletBalance(); fd = b == null ? null : Number(b); } catch { fd = null; }
  }
  if (dh == null && fd == null) return res.status(502).json({ error: 'Could not check wallets.' });
  res.json({
    balance: dh,
    datahustle: dh,
    fastdeals: fd,
    fastdealsConfigured: fastdeals.configured(),
    usesDatahustle: used.includes('datahustle'),
    usesFastdeals: used.includes('fastdeals'),
    mockMode: process.env.DATAHUSTLE_MOCK_MODE === 'true',
    lowWalletThreshold: Number(settings.lowWalletThreshold || 0),
  });
});

router.get('/audit', async (req, res) => {
  try { res.json(await getAuditLog(req.query.limit)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not load the activity log.' }); }
});

module.exports = router;
