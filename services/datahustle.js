const axios = require('axios');

const client = axios.create({
  // Always DataHustle's own address. DATAHUSTLE_API_URL exists only so the tests can point at a stand-in.
  baseURL: process.env.DATAHUSTLE_API_URL || 'https://api.datahustle.shop/api/developer',
  timeout: 15000,
  headers: {
    'X-API-Key': process.env.DATAHUSTLE_API_KEY,
    'Content-Type': 'application/json',
  },
});

/*
 * DataHustle gives every order its own code ("DM-RM7520GP"). That code is what its "order status" address
 * wants, but where the code sits in an answer is not documented, so it is looked up by name. Answers passed
 * on from DataHustle's own supplier (keys ending in "Response") are skipped: their codes are someone else's.
 */
function findOrderReference(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return null;
  for (const [k, v] of Object.entries(value)) {
    if (/^order_?(ref|reference)(_?(code|id|no|number))?$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      const text = String(v).trim();
      if (text && text.length <= 80) return text;
    }
  }
  for (const [k, v] of Object.entries(value)) {
    if (/response$/i.test(k)) continue;
    const found = findOrderReference(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// DataHustle's order statuses: pending -> processing -> completed | failed (failed orders are refunded to
// the wallet, and may then read "refunded"). Anything else is treated as "still waiting".
function stateOf(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase();
  if (s === 'completed' || s === 'delivered') return 'delivered';
  if (s === 'failed' || s === 'refunded') return 'failed';
  return 'pending';
}

let saidNoReference = false;

/**
 * Places a data bundle order. DataHustle accepts this instantly (status:
 * "pending"/"processing") but actual delivery is confirmed later via their
 * webhook (order.completed / order.failed) - see routes/api.js. If that update never arrives, the store asks
 * for the status itself (services/fulfillment.js).
 */
async function purchaseData({ network, phone, capacityGB, reference }) {
  if (process.env.DATAHUSTLE_MOCK_MODE === 'true') {
    console.log(`[MOCK] Would order ${capacityGB}GB (${network}) to ${phone} for order ${reference}`);
    return {
      accepted: true,
      transactionReference: `MOCK-TRX-${reference}`,
      purchaseId: `MOCK-${reference}`,
      mock: true,
      priceGHS: null,
    };
  }

  const res = await client.post('/purchase', {
    phoneNumber: phone,
    network,
    capacity: String(capacityGB),
    gateway: 'wallet',
  });

  const ok = res.data?.status === 'success';
  const orderReference = findOrderReference(res.data?.data);
  if (ok && !orderReference && !saidNoReference) {
    saidNoReference = true; // field names only, never values: useful if DataHustle ever renames things
    console.log('DataHustle purchase answer carries no order reference. Fields:', Object.keys(res.data?.data || {}).join(', '));
  }

  return {
    accepted: ok,
    transactionReference: res.data?.data?.transactionReference || null,
    purchaseId: res.data?.data?.purchaseId || null,
    orderReference,
    priceGHS: res.data?.data?.price == null ? null : Number(res.data.data.price),
    raw: res.data,
  };
}

async function getWalletBalance() {
  const res = await client.get('/balance');
  return res.data?.data?.walletBalance;
}

async function getDataPackages(network) {
  const res = await client.get('/data-packages', {
    params: network ? { network } : {},
  });

  return res.data?.data;
}

/**
 * Asks DataHustle what happened to one order, by its order reference (the "DM-..." code).
 * -> { state: 'delivered' | 'failed' | 'pending', status, trackingId, phone, capacityGB }, or null when DataHustle
 * does not know it.
 */
async function getOrderStatus(orderReference) {
  try {
    const res = await client.get('/order-status/' + encodeURIComponent(String(orderReference)));
    const d = res.data?.data;
    if (!d || typeof d !== 'object' || d.status == null) return null;
    const capacity = d.capacity == null || d.capacity === '' ? null : Number(d.capacity);
    return {
      state: stateOf(d.status), status: String(d.status), trackingId: d.trackingId ? String(d.trackingId) : null,
      phone: d.phoneNumber || d.phone || null, capacityGB: capacity,
    };
  } catch (err) {
    if (err.response && (err.response.status === 404 || err.response.status === 400)) return null;
    throw err;
  }
}

// The first list of records found in an answer (its exact shape is not documented).
function listIn(value, depth = 0) {
  if (Array.isArray(value)) return value.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (!value || typeof value !== 'object' || depth > 3) return [];
  for (const k of ['orders', 'history', 'purchases', 'items', 'results', 'records', 'data']) {
    if (value[k] != null) { const list = listIn(value[k], depth + 1); if (list.length) return list; }
  }
  for (const v of Object.values(value)) { const list = listIn(v, depth + 1); if (list.length) return list; }
  return [];
}

/** The most recent orders placed through the API (DataHustle keeps up to 200). */
async function getRecentOrders(limit = 200) {
  const res = await client.get('/usage/history', { params: { limit } });
  return listIn(res.data);
}

// Every plain value in a record (two levels deep), as text: used to recognise our order by its ids.
function valuesOf(item, depth = 0, out = new Set()) {
  if (!item || typeof item !== 'object' || depth > 2) return out;
  for (const v of Object.values(item)) {
    if (typeof v === 'string' || typeof v === 'number') out.add(String(v).trim());
    else if (v && typeof v === 'object' && !Array.isArray(v)) valuesOf(v, depth + 1, out);
  }
  return out;
}

/**
 * Finds our order in DataHustle's list of recent orders. Only an exact match on one of the ids DataHustle
 * gave us when we bought (its purchase id or its transaction reference) counts; never a guess by phone number.
 * -> { orderReference, state, status, trackingId } or null
 */
function findInRecent(list, { purchaseId, transactionReference }) {
  const ids = [purchaseId, transactionReference].map((v) => String(v == null ? '' : v).trim()).filter((v) => v.length >= 8);
  if (!ids.length) return null;
  for (const item of list || []) {
    const values = valuesOf(item);
    if (!ids.some((id) => values.has(id))) continue;
    const status = item.status != null ? item.status : item.orderStatus;
    return {
      orderReference: findOrderReference(item),
      state: status == null ? 'pending' : stateOf(status),
      status: status == null ? null : String(status),
      trackingId: item.trackingId ? String(item.trackingId) : null,
      fields: Object.keys(item),
    };
  }
  return null;
}

async function getWebhookStatus() {
  const res = await client.get('/webhook/status');
  return res.data;
}

async function setWebhookActive(isActive) {
  const res = await client.put('/webhook/toggle', { isActive: Boolean(isActive) });
  return res.data;
}

module.exports = {
  getOrderStatus,
  getRecentOrders,
  findInRecent,
  findOrderReference,
  stateOf,
  listIn,
  getWebhookStatus,
  setWebhookActive,
  purchaseData,
  getWalletBalance,
  getDataPackages,
};