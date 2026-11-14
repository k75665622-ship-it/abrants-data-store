/* Chooses which delivery provider handles an order and gives them one common interface. */
const datahustle = require('./datahustle');
const fastdeals = require('./fastdeals');
const up2u = require('./up2u');

// The providers the admin chooses between for MTN, Telecel and AirtelTigo. MTN UP2U is always FastDealsGH (v2).
const PROVIDER_NAMES = ['datahustle', 'fastdeals'];
const providerLabel = (p) => (String(p || '').startsWith('fastdeals') ? 'FastDealsGH' : 'DataHustle');

function providerFor(settings, networkName) {
  if (up2u.isUp2u(networkName)) return up2u.PROVIDER;
  const chosen = settings && settings.providers && settings.providers[networkName];
  return PROVIDER_NAMES.includes(chosen) ? chosen : 'datahustle';
}

// Always resolves to { accepted, delivered, transactionReference, purchaseId, priceGHS }.
async function purchase(provider, order) {
  if (provider === up2u.PROVIDER) return up2u.purchase(order);
  if (provider === 'fastdeals') {
    return fastdeals.purchaseData({ network: order.network, phone: order.phone, capacityGB: order.capacityGB, reference: order.reference });
  }
  const r = await datahustle.purchaseData({ network: order.networkCode, phone: order.phone, capacityGB: order.capacityGB, reference: order.reference });
  return { ...r, delivered: false };
}

module.exports = { PROVIDER_NAMES, providerFor, providerLabel, purchase };
