/*
 * Delivery and refund steps shared by paid orders (routes/api.js) and free-bundle
 * redemptions (routes/account.js).
 */
const crypto = require('crypto');
const providers = require('./providers');
const work = require('./workHints');
const fastdeals = require('./fastdeals');
const datahustle = require('./datahustle');
const { refundTransaction } = require('./paystack');
const { updateOrder, transitionOrder, getOrder, getSettings, saveSettings, getProcessingOrdersByProvider, getOutOfStockOrders, setProviderOrderRef, normalizePhone } = require('./orderStore');

/**
 * Sends a paid (or gifted) order to the data provider. The order must already be in the
 * 'paid' state. Delivery is confirmed by the provider's webhook (DataHustle) or straight away (FastDealsGH);
 * whatever is still unconfirmed after that is picked up by pollProviderOrders() below.
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
        // Always replaced, so a code from an earlier attempt at this order is never asked about again.
        providerOrderRef: result.orderReference || null,
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

// Pauses a network for customers because its provider has no stock, and leaves a message for the admin.
// It never switches provider: the admin decides that. The pause lifts by itself when stock is back
// (or when the admin switches the network to another provider).
async function pauseForStock(network, provider, how) {
  const s = await getSettings();
  const paused = Array.isArray(s.pausedNetworks) ? s.pausedNetworks : [];
  if (paused.includes(network)) return false;
  const other = provider === 'datahustle' ? 'fastdeals' : 'datahustle';
  await saveSettings({
    pausedNetworks: [...paused, network],
    autoPaused: { ...(s.autoPaused || {}), [network]: new Date().toISOString() },
  });
  await addAlert('danger', `${netLabel(network)} was paused for customers automatically because ${provLabel(provider)} is out of stock (${how}). Customers see the "out of stock" message instead of the bundles. It reopens by itself when stock is back. If ${provLabel(other)} has stock, you can switch ${netLabel(network)} to it in Settings → Delivery provider (check its wallet first); that also reopens it. Orders already paid are waiting.`);
  console.warn(`Auto-paused ${network}: ${provider} out of stock (${how})`);
  return true;
}

// Called when a provider refuses an order because the network is out of stock.
async function handleOutOfStock(network, failedProvider) {
  const s = await getSettings();
  const seen = { ...((s.outOfStock || {})[network] || {}), [failedProvider]: new Date().toISOString() };
  await saveSettings({ outOfStock: { ...(s.outOfStock || {}), [network]: seen } });
  await pauseForStock(network, failedProvider, 'an order was refused');
  return 'paused';
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
    const sw = s.stockWatch || {};
    if (sw[providers.providerFor(s, net) + ':' + net] === 'out') continue; // the provider's own list still says out
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
    const refund = await refundTransaction(reference, order.chargeGHS ?? order.priceGHS);
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
 * Catch-up for deliveries: asks the providers about orders that are still waiting for their "delivered".
 *
 * FastDealsGH has no webhook, so this is how its orders are confirmed. DataHustle does send a webhook, but an
 * update is lost for good when the store does not answer it within 10 seconds (asleep on Render's free plan,
 * restarting, a wrong webhook secret, the webhook switched off). Such orders used to stay on "Processing"
 * until someone pressed "Mark delivered". Now a DataHustle order still waiting after 2 minutes is looked up.
 *
 * Runs every 2 minutes but only looks in the database while orders are waiting, and looks less and less often
 * at orders that have been waiting a long time, so one slow order cannot keep the database awake (README 19).
 */
const POLL = {
  fastdeals: { minAgeSeconds: 45, maxAgeHours: 24 },
  datahustle: { minAgeSeconds: 120, maxAgeHours: 72 },
};
// Per provider: the last "an order went out" mark seen, the mark at which nothing was waiting, and when to look next.
const pollState = {
  fastdeals: { seq: -1, emptySeq: -1, nextAt: 0 },
  datahustle: { seq: -1, emptySeq: -1, nextAt: 0 },
};
const MIN = 60 * 1000;
const waitedMs = (order) => Date.now() - new Date(order.updatedAt).getTime();

// Time until the next look, from how long the newest waiting order has been waiting.
function nextLookMs(newestWaitedMs) {
  if (newestWaitedMs < 30 * MIN) return 0; // every run
  if (newestWaitedMs < 3 * HOUR) return 10 * MIN;
  if (newestWaitedMs < 24 * HOUR) return 30 * MIN;
  return HOUR;
}

function pollReady(name) {
  if (name === 'fastdeals') return fastdeals.configured();
  return Boolean(process.env.DATAHUSTLE_API_KEY) && process.env.DATAHUSTLE_MOCK_MODE !== 'true';
}

async function settle(order, state, extra, how) {
  if (state === 'delivered') {
    const done = await transitionOrder(order.reference, 'processing', { status: 'fulfilled', ...extra, confirmedBy: how }, 'delivery.completed');
    if (done) console.log(`Order ${order.reference} marked delivered (${how}).`);
  } else {
    const failed = await transitionOrder(order.reference, 'processing', { status: 'delivery_failed', confirmedBy: how }, 'delivery.failed');
    if (failed) { console.log(`Order ${order.reference} marked failed (${how}).`); await attemptCustomerRefund(failed.reference); }
  }
}

// -> the references that are no longer waiting
async function checkFastdealsOrders(orders) {
  const finished = new Set();
  for (const order of orders) {
    if (!order.providerReference || waitedMs(order) < POLL.fastdeals.minAgeSeconds * 1000) continue;
    try {
      const state = await fastdeals.getOrderStatus(order.providerReference);
      if (state !== 'delivered' && state !== 'failed') continue;
      await settle(order, state, {}, 'FastDealsGH status check');
      finished.add(order.reference);
    } catch (err) {
      console.warn('FastDeals status check skipped', order.reference, err.response?.status || err.message);
    }
  }
  return finished;
}

let saidRecentShape = false;

async function checkDatahustleOrders(orders) {
  const finished = new Set();
  let recent = null; // DataHustle's list of recent orders: fetched at most once per run, and only if needed
  const loadRecent = async () => {
    if (recent) return recent;
    try { recent = await datahustle.getRecentOrders(200); }
    catch (err) { recent = []; console.warn('DataHustle recent orders not available:', err.response?.status || err.message); }
    return recent;
  };

  for (const order of orders) {
    if (waitedMs(order) < POLL.datahustle.minAgeSeconds * 1000) continue;
    try {
      // 1. Ask about the order by DataHustle's own code for it, when we have it.
      let answer = order.providerOrderRef ? await datahustle.getOrderStatus(order.providerOrderRef) : null;

      // 2. Otherwise find the order in DataHustle's recent list by the ids it gave us at purchase.
      if (!answer) {
        const found = datahustle.findInRecent(await loadRecent(), { purchaseId: order.purchaseId, transactionReference: order.providerReference });
        if (found && found.orderReference && found.orderReference !== order.providerOrderRef) {
          await setProviderOrderRef(order.reference, found.orderReference);
          answer = await datahustle.getOrderStatus(found.orderReference);
        }
        // The list's own "delivered" is accepted as it is. A failure refunds the customer, so that is only
        // ever taken from the documented order-status answer above.
        if (!answer && found && found.state === 'delivered') answer = { state: 'delivered', trackingId: found.trackingId };
        if (!answer && !saidRecentShape) {
          saidRecentShape = true; // field names only, never values
          console.log('DataHustle status check could not place order', order.reference + '.',
            found ? 'List entry fields: ' + found.fields.join(', ') : 'Not in the recent list; list entry fields: ' + Object.keys((recent && recent[0]) || {}).join(', '));
        }
      }
      if (!answer || (answer.state !== 'delivered' && answer.state !== 'failed')) continue;

      // Belt and braces: the answer must be about the same number and bundle size as our order.
      if (answer.phone && normalizePhone(answer.phone) !== normalizePhone(order.phone)) {
        console.warn('DataHustle status check ignored for', order.reference, '(the answer is for a different phone number).');
        continue;
      }
      if (answer.capacityGB != null && Number.isFinite(answer.capacityGB) && answer.capacityGB !== Number(order.capacityGB)) {
        console.warn('DataHustle status check ignored for', order.reference, '(the answer is for a different bundle size).');
        continue;
      }
      await settle(order, answer.state, answer.trackingId ? { trackingId: answer.trackingId } : {}, 'DataHustle status check');
      finished.add(order.reference);
    } catch (err) {
      console.warn('DataHustle status check skipped', order.reference, err.response?.status || err.message);
    }
  }
  return finished;
}

async function pollProviderOrders() {
  if (!work.pending('provider-poll')) return;
  const mark = work.lastMark('provider-poll');
  let waiting = false;
  for (const name of Object.keys(POLL)) {
    if (!pollReady(name)) continue;
    const st = pollState[name];
    if (st.seq !== mark.seq) { st.seq = mark.seq; st.nextAt = 0; } // an order went out since the last look: look now
    if (st.emptySeq === mark.seq) continue; // nothing of this provider's has been waiting since then
    if (Date.now() < st.nextAt) { waiting = true; continue; } // orders are waiting, but it is not time yet

    const all = await getProcessingOrdersByProvider(name, 0, 200, POLL[name].maxAgeHours);
    // Only orders the provider can actually be asked about (test orders from mock mode cannot).
    const orders = all.filter((o) => (name === 'fastdeals' ? o.providerReference : !String(o.providerReference || o.purchaseId || '').startsWith('MOCK-')));
    const finished = orders.length ? await (name === 'fastdeals' ? checkFastdealsOrders(orders) : checkDatahustleOrders(orders)) : new Set();
    const left = orders.filter((o) => !finished.has(o.reference));
    if (!left.length) {
      // An order marked a moment ago may not be saved yet, so "nothing waiting" only counts once the mark has settled.
      if (Date.now() - mark.at >= work.GRACE_MS) st.emptySeq = mark.seq;
      continue;
    }
    waiting = true;
    st.nextAt = Date.now() + nextLookMs(Math.min(...left.map(waitedMs))) - 30 * 1000;
  }
  if (!waiting) work.done('provider-poll');
}

module.exports = { pauseForStock, addAlert, deliverOrder, attemptCustomerRefund, pollProviderOrders, nextLookMs, autoRecoveryTick, handleOutOfStock, retryOutOfStockOrders, isOutOfStock };
