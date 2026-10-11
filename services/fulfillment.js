/*
 * Delivery and refund steps shared by paid orders (routes/api.js) and free-bundle
 * redemptions (routes/account.js).
 */
const { purchaseData } = require('./datahustle');
const { refundTransaction } = require('./paystack');
const { updateOrder, transitionOrder, getOrder } = require('./orderStore');

/**
 * Sends a paid (or gifted) order to the data provider. The order must already be in the
 * 'paid' state. Delivery is confirmed later by the provider's webhook.
 */
async function deliverOrder(order) {
  const reference = order.reference;
  try {
    const result = await purchaseData({ network: order.networkCode, phone: order.phone, capacityGB: order.capacityGB, reference });
    if (result.accepted) {
      const changes = {
        status: 'processing',
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
    console.error('DataHustle purchase error:', err.response?.data || err.message);
    // A timeout/network error is ambiguous: the provider may have accepted the order even
    // though our request did not receive the response. Never auto-refund in that case.
    await transitionOrder(reference, 'paid', { status: 'delivery_review' }, 'delivery.review_required');
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

module.exports = { deliverOrder, attemptCustomerRefund };
