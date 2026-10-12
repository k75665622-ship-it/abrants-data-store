/*
 * Delivery and refund steps shared by paid orders (routes/api.js) and free-bundle
 * redemptions (routes/account.js).
 */
const providers = require('./providers');
const fastdeals = require('./fastdeals');
const { refundTransaction } = require('./paystack');
const { updateOrder, transitionOrder, getOrder, getSettings, saveSettings, getProcessingOrdersByProvider } = require('./orderStore');

/**
 * Sends a paid (or gifted) order to the data provider. The order must already be in the
 * 'paid' state. Delivery is confirmed by the provider's webhook (DataHustle) or straight away / by polling (FastDealsGH).
 */
async function deliverOrder(order) {
  const reference = order.reference;
  try {
    const provider = providers.providerFor(await getSettings(), order.network);
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
    // A timeout/network error is ambiguous: the provider may have accepted the order even
    // though our request did not receive the response. Never auto-refund in that case.
    await transitionOrder(reference, 'paid', { status: 'delivery_review' }, 'delivery.review_required');
    // If the provider says the network is out of stock, stop selling it so more customers do not pay for it.
    const text = String(err.response?.data?.message || err.response?.data?.error || err.message || '');
    if (/out of stock/i.test(text)) {
      try {
        const network = (await getOrder(reference))?.network;
        const settings = await getSettings();
        const paused = Array.isArray(settings.pausedNetworks) ? settings.pausedNetworks : [];
        if (network && !paused.includes(network)) {
          await saveSettings({ pausedNetworks: [...paused, network] });
          console.warn('Auto-paused ' + network + ' because the provider reported it is out of stock.');
        }
      } catch (e) { console.error('Auto-pause failed:', e.message); }
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

module.exports = { deliverOrder, attemptCustomerRefund, pollFastdealsOrders };
