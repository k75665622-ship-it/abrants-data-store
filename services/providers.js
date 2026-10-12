/* Chooses which delivery provider handles an order and gives them one common interface. */
const datahustle = require('./datahustle');
const fastdeals = require('./fastdeals');

const PROVIDER_NAMES = ['datahustle', 'fastdeals'];

function providerFor(settings, networkName) {
  const chosen = settings && settings.providers && settings.providers[networkName];
  return PROVIDER_NAMES.includes(chosen) ? chosen : 'datahustle';
}

// Always resolves to { accepted, delivered, transactionReference, purchaseId, priceGHS }.
async function purchase(provider, order) {
  if (provider === 'fastdeals') {
    return fastdeals.purchaseData({ network: order.network, phone: order.phone, capacityGB: order.capacityGB, reference: order.reference });
  }
  const r = await datahustle.purchaseData({ network: order.networkCode, phone: order.phone, capacityGB: order.capacityGB, reference: order.reference });
  return { ...r, delivered: false };
}

module.exports = { PROVIDER_NAMES, providerFor, purchase };
