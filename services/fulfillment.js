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
    } else {
      const failed = await transitionOrder(reference, 'paid', { status: 'delivery_failed' }, 'delivery.failed');
      if (failed) await attemptCustomerRefund(reference);
    }
  } catch (err) {
    console.error('Provider purchase error:', err.response?.data || err.message);
    if (isOutOfStock(err)) {
      // "Out of stock" is a definite no from the provider (nothing was bought), so it is safe to
      // send the same order to the other provider. Timeouts are different and are never retried by themselves.
      await transitionOrder(reference, 'paid', { status: 'delivery_review' }, 'delivery.out_of_stock');
      try {
        const outcome = await handleOutOfStock(order.network, provider);
        if (outcome === 'switched') {
          const again = await transitionOrder(reference, 'delivery_review', { status: 'paid' }, 'delivery.requeued');
          if (again) await deliverOrder(again);
          await retryOutOfStockOrders(order.network, reference);
        }
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
const FLIP_GUARD_MS = 30 * 60 * 1000;
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

// Returns 'switched' (the network now uses the other provider) or 'paused' (nothing else to try).
async function handleOutOfStock(network, failedProvider) {
  const s = await getSettings();
  const current = providers.providerFor(s, network);
  if (current !== failedProvider) return 'switched'; // already moved by an earlier order
  const other = failedProvider === 'datahustle' ? 'fastdeals' : 'datahustle';
  const earlier = (s.autoFailovers || {})[network];
  const justSwitched = earlier && Date.now() - new Date(earlier.at).getTime() < FLIP_GUARD_MS;
  if (s.autoFailover !== false && providerReady(other) && !justSwitched) {
    await saveSettings({
      providers: { ...(s.providers || {}), [network]: other },
      autoFailovers: { ...(s.autoFailovers || {}), [network]: { from: failedProvider, to: other, at: new Date().toISOString() } },
    });
    await addAlert('warn', `${netLabel(network)} is out of stock at ${provLabel(failedProvider)}. The store switched to ${provLabel(other)} by itself and re-sent the waiting orders. It will try ${provLabel(failedProvider)} again in about an hour.`);
    console.warn(`Auto-switched ${network}: ${failedProvider} -> ${other}`);
    return 'switched';
  }
  const paused = Array.isArray(s.pausedNetworks) ? s.pausedNetworks : [];
  if (!paused.includes(network)) {
    const patch = { pausedNetworks: [...paused, network], autoPaused: { ...(s.autoPaused || {}), [network]: new Date().toISOString() } };
    if (justSwitched) {
      // Both providers are out, so undo the switch; the network will reopen and try again later.
      patch.providers = { ...(s.providers || {}), [network]: earlier.from };
      const left = { ...(s.autoFailovers || {}) }; delete left[network];
      patch.autoFailovers = left;
    }
    await saveSettings(patch);
    await addAlert('danger', `${netLabel(network)} is out of stock and there is no other provider to use, so it has been paused for customers. It will reopen by itself and try again in about an hour. Orders already paid are waiting under review.`);
    console.warn(`Auto-paused ${network}: out of stock`);
  }
  return 'paused';
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

// Runs every few minutes: tries the first provider again an hour after a switch, and reopens
// networks that were paused automatically.
async function autoRecoveryTick() {
  let s = await getSettings();
  for (const [net, af] of Object.entries(s.autoFailovers || {})) {
    if (Date.now() - new Date(af.at).getTime() < HOUR) continue;
    const next = { ...(s.providers || {}) };
    if (providers.providerFor(s, net) === af.to) next[net] = af.from; // leave it if the admin chose something else
    const left = { ...(s.autoFailovers || {}) }; delete left[net];
    await saveSettings({ providers: next, autoFailovers: left });
    await addAlert('info', `${netLabel(net)} was moved back to ${provLabel(af.from)} to check whether it has stock again. If it is still out, the store will move to ${provLabel(af.to)} again by itself.`);
    s = await getSettings();
  }
  for (const [net, at] of Object.entries(s.autoPaused || {})) {
    if (Date.now() - new Date(at).getTime() < HOUR) continue;
    const paused = (s.pausedNetworks || []).filter((n) => n !== net);
    const left = { ...(s.autoPaused || {}) }; delete left[net];
    await saveSettings({ pausedNetworks: paused, autoPaused: left });
    await addAlert('info', `${netLabel(net)} was reopened to customers to check whether stock is back.`);
    await retryOutOfStockOrders(net); // if it is still out, this pauses it again
    s = await getSettings();
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
