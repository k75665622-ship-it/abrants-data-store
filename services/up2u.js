/*
 * MTN UP2U: data (and data + minutes) packages from FastDealsGH (API v2), delivered by their team, so an order waits in
 * "processing" until they finish (the poller in services/fulfillment.js asks, see README 30).
 *
 * Each package is an ordinary store bundle under the network "MTN UP2U" whose network code is "UP2U-<package id>".
 * Checkout, agent prices, the order page, texts and refunds therefore work as for every other bundle.
 * Admin → Bundles → "Load MTN UP2U" adds new packages (hidden until priced) and keeps their costs current.
 */
const fdv2 = require('./fdv2');
const lazy = (name) => require('./' + name);

const NETWORK = 'MTN UP2U';
const PROVIDER = 'fastdeals-up2u';
// Only MTN numbers are accepted by FastDealsGH for UP2U (422 invalid_phone otherwise).
const MTN_PREFIXES = ['024', '025', '053', '054', '055', '059'];

const isUp2u = (x) => (typeof x === 'string' ? x : x && x.network) === NETWORK;
const codeFor = (packageId) => `UP2U-${packageId}`;
function packageIdOf(networkCode) {
  const m = /^UP2U-(\d+)$/.exec(String(networkCode || ''));
  return m ? Number(m[1]) : null;
}
const isMtnNumber = (phone) => MTN_PREFIXES.includes(String(phone || '').replace(/\D/g, '').replace(/^233/, '0').slice(0, 3));

// Their answers that mean nothing was bought: the customer is refunded straight away.
const DEFINITE_NO = new Set(['invalid_phone', 'package_not_found', 'validation_error', 'invalid_package']);
const DELIVERED = new Set(['successful', 'success', 'completed', 'delivered']);
const FAILED = new Set(['failed', 'refunded', 'cancelled', 'canceled', 'rejected']);

/** -> 'delivered' | 'failed' | 'waiting' */
function stateOf(status) {
  const s = String(status || '').toLowerCase();
  if (DELIVERED.has(s)) return 'delivered';
  if (FAILED.has(s)) return 'failed';
  return 'waiting';
}

/** Buys the package for a paid order. Same shape as every provider: { accepted, delivered, transactionReference, ... }. */
async function purchase(order) {
  const packageId = packageIdOf(order.networkCode);
  if (!packageId) return { accepted: false, problem: 'no_package' };
  let d;
  try {
    d = await fdv2.buyUp2u(order.reference, packageId, order.phone); // the order reference is the Idempotency-Key
  } catch (err) {
    if (err instanceof fdv2.FdError && DEFINITE_NO.has(err.code)) {
      if (err.code === 'package_not_found') packageGone(order).catch(() => {});
      return { accepted: false, problem: err.code };
    }
    throw err; // no answer, wallet empty, ...: the order waits for the admin (never refunded on a guess)
  }
  const state = stateOf(d.status);
  return {
    accepted: state !== 'failed',
    delivered: state === 'delivered',
    transactionReference: d.reference || d.order_reference || (d.id != null ? String(d.id) : null),
    purchaseId: String(packageId),
    priceGHS: d.amount == null ? null : Number(d.amount),
  };
}

// FastDealsGH no longer has the package: hide our bundle and tell the admin.
async function packageGone(order) {
  await lazy('orderStore').updatePlan(order.planId, { active: false });
  await lazy('fulfillment').addAlert('warn', `FastDealsGH no longer offers the MTN UP2U package "${order.label}". It was hidden from customers and the order refunded. Use "Load MTN UP2U" in Bundles to see what they offer now.`);
}

/** Asks FastDealsGH how an order is going. -> 'delivered' | 'failed' | 'waiting' */
async function check(providerReference) {
  const d = await fdv2.getOrder(providerReference);
  return stateOf(d.status);
}

const round = (v, step) => Math.ceil(Number(v) / step - 1e-9) * step;
function labelFor(pkg) {
  const gb = pkg.dataGB != null && pkg.dataGB > 0 ? (pkg.dataGB < 1 ? `${Math.round(pkg.dataGB * 1000)}MB` : `${+pkg.dataGB.toFixed(2)}GB`) : '';
  const mins = pkg.minutes > 0 ? `${pkg.minutes} mins` : '';
  return ([gb, mins].filter(Boolean).join(' + ') || pkg.name || `Package ${pkg.id}`).slice(0, 40);
}

/*
 * Brings our MTN UP2U bundles in line with FastDealsGH's list:
 *  - a new package becomes a hidden bundle, priced at its cost plus 10% (rounded up to 50 pesewas) for the admin to check;
 *  - a known package gets its current cost (the admin's price and name are kept);
 *  - a package they dropped (or have run out of) is hidden. Hidden packages are never switched back on here.
 */
async function syncPackages() {
  const { getPlans, createPlan, updatePlan } = lazy('orderStore');
  const { up2u } = await fdv2.products({ fresh: true });
  const ours = new Map((await getPlans({ includeInactive: true })).filter(isUp2u).map((p) => [packageIdOf(p.networkCode), p]));
  const out = { offered: up2u.length, added: 0, costChanged: 0, hidden: 0 };
  for (const pkg of up2u) {
    const have = ours.get(pkg.id);
    ours.delete(pkg.id);
    if (!have) {
      const r = await createPlan({
        network: NETWORK, networkCode: codeFor(pkg.id), label: labelFor(pkg),
        capacityGB: pkg.dataGB > 0 ? pkg.dataGB : 0.01, validity: pkg.validity || 'No expiry',
        priceGHS: Math.max(0.5, round(pkg.cost * 1.1, 0.5)), providerCostGHS: pkg.cost, active: false,
      });
      if (!r.error) out.added += 1;
      continue;
    }
    if (Number(have.providerCostGHS) !== pkg.cost) { await updatePlan(have.id, { providerCostGHS: pkg.cost }); out.costChanged += 1; }
    if (!pkg.inStock && have.active) { await updatePlan(have.id, { active: false }); out.hidden += 1; }
  }
  for (const gone of ours.values()) {
    if (gone.active) { await updatePlan(gone.id, { active: false }); out.hidden += 1; }
  }
  return out;
}

module.exports = { NETWORK, PROVIDER, MTN_PREFIXES, isUp2u, isMtnNumber, codeFor, packageIdOf, stateOf, purchase, check, syncPackages, labelFor };
