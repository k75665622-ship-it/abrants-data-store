/*
 * FastDealsGH data API (https://fastdealsgh.com/api/v1), used as a second delivery provider.
 * Auth: Bearer API key. Plans are chosen by id, so we look up the id from the plan list.
 * Their buy call answers straight away with a final status; there is no webhook, so orders that
 * come back as "pending" are re-checked by a small poller (see services/fulfillment.js).
 */
const axios = require('axios');

const NETWORK_KEYS = { MTN: 'mtn', Telecel: 'telecel', AirtelTigo: 'airteltigo' };
const DELIVERED = ['successful', 'success', 'completed', 'delivered'];
const FAILED = ['failed', 'refunded', 'cancelled', 'canceled', 'rejected', 'error'];

const client = axios.create({
  baseURL: process.env.FASTDEALS_BASE_URL || 'https://fastdealsgh.com/api/v1',
  timeout: 20000,
  headers: { Authorization: `Bearer ${process.env.FASTDEALS_API_KEY || ''}`, 'Content-Type': 'application/json' },
});

const planCache = new Map(); // network key -> { at, plans }
const CACHE_MS = 5 * 60 * 1000;

function configured() { return Boolean(process.env.FASTDEALS_API_KEY) || process.env.FASTDEALS_MOCK_MODE === 'true'; }

// "MTN 1GB" -> 1, "MTN 500MB" -> 0.5
function sizeGB(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*(GB|MB)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toUpperCase() === 'MB' ? n / 1000 : n;
}

async function listPlans(networkName, { fresh = false } = {}) {
  const key = NETWORK_KEYS[networkName] || String(networkName || '').toLowerCase();
  const hit = planCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.plans;
  const res = await client.get('/plans', { params: { network: key } });
  const plans = Array.isArray(res.data?.plans) ? res.data.plans : [];
  planCache.set(key, { at: Date.now(), plans });
  return plans;
}

// Finds their plan with the same size. If several match, the cheapest one is used.
async function findPlan(networkName, capacityGB, opts) {
  const plans = await listPlans(networkName, opts);
  const matches = plans
    .filter((p) => sizeGB(p.name) != null && Math.abs(sizeGB(p.name) - Number(capacityGB)) < 0.0001)
    .sort((a, b) => Number(a.price) - Number(b.price));
  return matches[0] || null;
}

async function purchaseData({ network, phone, capacityGB, reference }) {
  if (process.env.FASTDEALS_MOCK_MODE === 'true') {
    console.log(`[MOCK FastDeals] Would order ${capacityGB}GB (${network}) to ${phone} for order ${reference}`);
    return { accepted: true, delivered: true, transactionReference: `MOCK-FD-${reference}`, purchaseId: null, priceGHS: null, mock: true };
  }
  const plan = await findPlan(network, capacityGB);
  if (!plan) throw new Error(`FastDealsGH has no ${capacityGB}GB ${network} plan`);

  const res = await client.post('/data/buy', { plan_id: plan.id, phone });
  const status = String(res.data?.status || '').toLowerCase();
  const ok = res.data?.success === true && !FAILED.includes(status);
  return {
    accepted: ok,
    delivered: ok && DELIVERED.includes(status),
    transactionReference: res.data?.reference || null,
    purchaseId: String(plan.id),
    priceGHS: res.data?.amount == null ? (plan.price == null ? null : Number(plan.price)) : Number(res.data.amount),
    raw: res.data,
  };
}

// -> 'delivered' | 'failed' | 'pending'
async function getOrderStatus(reference) {
  const res = await client.get(`/orders/${encodeURIComponent(reference)}`);
  const status = String(res.data?.status || '').toLowerCase();
  if (DELIVERED.includes(status)) return 'delivered';
  if (FAILED.includes(status)) return 'failed';
  return 'pending';
}

async function getWalletBalance() {
  const res = await client.get('/wallet/balance');
  return res.data?.balance;
}

module.exports = { configured, purchaseData, getOrderStatus, getWalletBalance, findPlan, listPlans, sizeGB };
