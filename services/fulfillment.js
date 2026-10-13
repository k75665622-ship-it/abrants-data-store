/*
 * Delivery and refund steps shared by paid orders (routes/api.js) and free-bundle
 * redemptions (routes/account.js).
 */
const crypto = require('crypto');
const providers = require('./providers');
const fastdeals = require('./fastdeals');
const { refundTransaction } = require('./paystack');
const { updateOrder, transitionOrder, getOrder, getSettings, saveSettings, getProcessingOrdersByProvider, getOutOfStockOrders } = require('./orderStore');

/**
 * Sends a paid (or gifted) order to the data provider. The order must already be in the
 * 'paid' state. Delivery is confirmed by the provider's webhook (DataHustle) or straight away / by polling (FastDealsGH).
 */
async function deliverOrder(order) {
  const reference = order.reference;
  let provider = null;
  try {
    provider = providers.providerFor(await getSettings(), order.network);
    const result = await providers.purchase(provider, order);
    if (result.accepted) {
      // A provider that answers "delivered" straight away (FastDealsGH) finishes the order now;
      // otherwise the order waits in 'processing' for the provider's confirmation.
      const changes = {
        status: result.delivered ? 'fulfilled' : 'processing',
        provider,
        providerReference: result.transactionReference,
        purchaseId: result.purchaseId,
      };
      if (Number.isFinite(Number(result.priceGHS))) changes.providerCostGHS = Number(result.priceGHS);
      await updateOrder(reference, changes, 'provider.order_accepted');
      await stockIsBack(order.network, provider).catch(() => {});
    } else {
      const failed = await transitionOrder(reference, 'paid', { status: 'delivery_failed' }, 'delivery.failed');
      if (failed) await attemptCustomerRefund(reference);
    }
  } catch (err) {
    console.error('Provider purchase error:', err.response?.data || err.message);
    if (isOutOfStock(err)) {
      // "Out of stock" is a definite no from the provider (nothing was bought). The order waits under
      // review; the admin decides whether to switch provider. Timeouts are never treated this way.
      await transitionOrder(reference, 'paid', { status: 'delivery_review' }, 'delivery.out_of_stock');
      try {
        await handleOutOfStock(order.network, provider);
      } catch (e) { console.error('Out-of-stock handling failed:', e.message); }
      return;
    }
    // A timeout/network error is ambiguous: the provider may have accepted the order even
    // though our request did not receive the response. Never auto-refund in that case.
    await transitionOrder(reference, 'paid', { status: 'delivery_review' }, 'delivery.review_required');
  }
}

/* ---------------------------------------------------------------- */
/* Out of stock: automatic switch to the other provider, and back     */
/* ---------------------------------------------------------------- */
const HOUR = 60 * 60 * 1000;
const netLabel = (n) => (n === 'Telecel' ? 'Telecel (Vodafone)' : n);
const provLabel = (p) => (p === 'fastdeals' ? 'FastDealsGH' : 'DataHustle');

function isOutOfStock(err) {
  const text = String(err?.response?.data?.message || err?.response?.data?.error || err?.message || '');
  return /out of stock/i.test(text);
}

function providerReady(name) {
  return name === 'fastdeals' ? fastdeals.configured() : Boolean(process.env.DATAHUSTLE_API_KEY);
}

// Adds a message for the admin dashboard (kept short; the same message is not repeated within 3 hours).
async function addAlert(level, text) {
  const s = await getSettings();
  const list = Array.isArray(s.adminAlerts) ? s.adminAlerts : [];
  if (list.some((a) => a.text === text && Date.now() - new Date(a.at).getTime() < 3 * HOUR)) return;
  const entry = { id: crypto.randomBytes(4).toString('hex'), at: new Date().toISOString(), level, text };
  await saveSettings({ adminAlerts: [entry, ...list].slice(0, 20) });
}

// Called when a provider says a network is out of stock. It never switches provider by itself:
// it tells the admin to switch, and pauses the network for customers only when there is nowhere
// left to send orders (the other provider also said "out of stock" recently, or is not set up).
async function handleOutOfStock(network, failedProvider) {
  const s = await getSettings();
  const now = Date.now();
  const other = failedProvider === 'datahustle' ? 'fastdeals' : 'datahustle';
  const seen = { ...((s.outOfStock || {})[network] || {}), [failedProvider]: new Date(now).toISOString() };
  await saveSettings({ outOfStock: { ...(s.outOfStock || {}), [network]: seen } });
  const otherRecently = seen[other] && now - new Date(seen[other]).getTime() < 2 * HOUR;
  if (!providerReady(other) || otherRecently) {
    const paused = Array.isArray(s.pausedNetworks) ? s.pausedNetworks : [];
    if (!paused.includes(network)) {
      await saveSettings({ pausedNetworks: [...paused, network], autoPaused: { ...(s.autoPaused || {}), [network]: new Date(now).toISOString() } });
      await addAlert('danger', `${netLabel(network)} is out of stock at ${otherRecently ? 'both DataHustle and FastDealsGH' : provLabel(failedProvider) + ' and there is no other provider set up'}, so it has been paused for customers with a friendly message. It reopens by itself when stock is back. Orders already paid are waiting under review.`);
      console.warn(`Auto-paused ${network}: out of stock`);
    }
    return 'paused';
  }
  await addAlert('warn', `${netLabel(network)} is out of stock at ${provLabel(failedProvider)}. Go to Settings → Delivery provider and switch ${netLabel(network)} to ${provLabel(other)} (check its wallet first). Paid orders are waiting and will be sent there as soon as you save the switch.`);
  return 'notified';
}

// A provider just accepted an order, so it has stock: clear its "out of stock" flag and, if the
// network was paused automatically, reopen it.
async function stockIsBack(network, provider) {
  const s = await getSettings();
  const oos = { ...(s.outOfStock || {}) };
  const had = oos[network] && oos[network][provider];
  const wasPaused = (s.autoPaused || {})[network];
  if (!had && !wasPaused) return;
  if (had) { oos[network] = { ...oos[network] }; delete oos[network][provider]; }
  const patch = { outOfStock: oos };
  if (wasPaused) {
    patch.pausedNetworks = (s.pausedNetworks || []).filter((n) => n !== network);
    const left = { ...(s.autoPaused || {}) }; delete left[network];
    patch.autoPaused = left;
  }
  await saveSettings(patch);
  if (wasPaused) await addAlert('info', `${netLabel(network)} is back in stock at ${provLabel(provider)}. The pause message was removed and customers can buy again.`);
}

// Re-sends paid orders that a provider definitely refused for being out of stock.
async function retryOutOfStockOrders(network, exceptReference) {
  const waiting = await getOutOfStockOrders(network, 20);
  for (const o of waiting) {
    if (o.reference === exceptReference) continue;
    const again = await transitionOrder(o.reference, 'delivery_review', { status: 'paid' }, 'delivery.requeued');
    if (again) await deliverOrder(again);
  }
}

// Runs every few minutes: networks that were paused automatically are checked again after a short
// wait. A waiting paid order is used as the test (it was already paid for), and if a provider accepts
// it, stockIsBack() reopens the network. With no waiting order the network just reopens.
const REOPEN_AFTER_MS = 15 * 60 * 1000;
async function autoRecoveryTick() {
  const s = await getSettings();
  for (const [net, at] of Object.entries(s.autoPaused || {})) {
    if (Date.now() - new Date(at).getTime() < REOPEN_AFTER_MS) continue;
    const waiting = await getOutOfStockOrders(net, 1);
    if (waiting.length) {
      // Test with a waiting order. If it is accepted the network reopens; if not, it is paused again.
      const fresh = await getSettings();
      const left = { ...(fresh.autoPaused || {}), [net]: new Date().toISOString() };
      await saveSettings({ autoPaused: left }); // restart the wait; stockIsBack() clears it on success
      await retryOutOfStockOrders(net);
    } else {
      const fresh = await getSettings();
      const left = { ...(fresh.autoPaused || {}) }; delete left[net];
      await saveSettings({ pausedNetworks: (fresh.pausedNetworks || []).filter((n) => n !== net), autoPaused: left });
      await addAlert('info', `${netLabel(net)} was reopened to customers to check whether stock is back.`);
    }
  }
}

async function attemptCustomerRefund(reference) {
  const order = await getOrder(reference);
  if (!order || !['delivery_failed', 'paid'].includes(order.status) || order.refundStatus === 'queued' || order.refundStatus === 'processed') return;
  // Free bundles were never paid for, so there is nothing to refund. A failed gift does not
  // use up the customer's offer, so they can simply try again.
  if (order.source === 'gift' || Number(order.priceGHS) <= 0) return;
  try {
    const refund = await refundTransaction(reference, order.priceGHS);
    await updateOrder(reference, {
      status: 'refunding',
      refundId: refund?.id ? String(refund.id) : null,
      refundStatus: refund?.status || 'pending',
    }, 'customer.refund.queued');
  } catch (err) {
    console.error('Customer refund failed to start:', err.response?.data || err.message);
    await updateOrder(reference, { refundStatus: 'needs_manual_refund' }, 'customer.refund.failed');
  }
}

/*
 * FastDealsGH has no webhook, so orders it did not mark delivered straight away are re-checked.
 * Called every couple of minutes.
 */
async function pollFastdealsOrders() {
  if (!fastdeals.configured()) return;
  const orders = await getProcessingOrdersByProvider('fastdeals', 45, 50);
  for (const order of orders) {
    try {
      const state = await fastdeals.getOrderStatus(order.providerReference);
      if (state === 'delivered') {
        await transitionOrder(order.reference, 'processing', { status: 'fulfilled' }, 'delivery.completed');
      } else if (state === 'failed') {
        const failed = await transitionOrder(order.reference, 'processing', { status: 'delivery_failed' }, 'delivery.failed');
        if (failed) await attemptCustomerRefund(failed.reference);
      }
    } catch (err) {
      console.warn('FastDeals status check skipped', order.reference, err.response?.status || err.message);
    }
  }
}

module.exports = { deliverOrder, attemptCustomerRefund, pollFastdealsOrders, autoRecoveryTick, handleOutOfStock, retryOutOfStockOrders, isOutOfStock };
