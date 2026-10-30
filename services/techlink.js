/*
 * Techlink GH API v1: electricity (ECG), Ghana Water and TV (DStv, GOtv, StarTimes) bill payments.
 * Docs: https://documenter.getpostman.com/view/32176725/2sBY4WobyX (auth header: x-api-key).
 *
 * Techlink has no idempotency key, so a payment request that gets no answer may or may not have gone
 * through. Errors therefore come in two kinds:
 *   'rejected' - Techlink answered "no" (4xx or success:false). Nothing was paid; safe to retry or refund.
 *   'unknown'  - timeout, network error or 5xx. Never resend automatically: check Techlink's orders first.
 */
const axios = require('axios');

const base = () => (process.env.TECHLINK_BASE_URL || 'https://api.techlinkgh.com/api/v1').replace(/\/+$/, '');
const available = () => Boolean(process.env.TECHLINK_API_KEY);

class TlError extends Error {
  constructor(kind, message, status) { super(message || kind); this.kind = kind; this.status = status; }
}

function messageOf(d) {
  if (!d || typeof d !== 'object') return '';
  if (typeof d.message === 'string') return d.message;
  if (typeof d.error === 'string') return d.error;
  if (d.error && typeof d.error.message === 'string') return d.error.message;
  return '';
}

async function call(method, path, { body, params, timeout } = {}) {
  if (!available()) throw new TlError('not_configured', 'Techlink is not connected (TECHLINK_API_KEY).');
  let res;
  try {
    res = await axios({
      method, url: base() + path, data: body, params,
      headers: { 'x-api-key': process.env.TECHLINK_API_KEY, 'Content-Type': 'application/json' },
      timeout: timeout || Number(process.env.TECHLINK_TIMEOUT_MS || 45000),
    });
  } catch (err) {
    const status = err.response?.status;
    const msg = messageOf(err.response?.data) || err.message;
    // A clear "no" from Techlink. 408/429 mean "not now", which is not a definite answer about the payment.
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) throw new TlError('rejected', msg, status);
    throw new TlError('unknown', msg, status);
  }
  const d = res.data && typeof res.data === 'object' ? res.data : {};
  if (d.success === false) throw new TlError('rejected', messageOf(d) || 'Techlink refused the request', res.status);
  return d;
}

// "Insufficient balance"-type refusals: the wallet needs a top-up, then the payment can be retried.
const isLowBalance = (err) => err && err.kind === 'rejected' && /insufficient|low balance|wallet balance|top ?up|not enough/i.test(err.message || '');

const TV_SERVICES = ['DSTV', 'GOTV', 'STARTIMES'];

// Customer name for a meter / account / smartcard, so nobody pays a stranger's bill.
// service: DSTV | GOTV | STARTIMES (TV only).
async function lookup(kind, account, service) {
  if (kind === 'ecg') {
    const d = await call('get', '/ecg/lookup', { params: { meter: account }, timeout: 20000 });
    return { name: String(d.customerName || '').trim(), area: String(d.district || '').trim(), amountDue: null };
  }
  const billType = kind === 'tv' ? service : 'WATER';
  const d = await call('post', '/korba/validate', { body: { billType, account }, timeout: 20000 });
  const due = Number(d.balance);
  return {
    name: String(d.customerName || '').trim(), area: String(d.address || '').trim(), amountDue: Number.isFinite(due) ? due : null,
    packageName: d.packageName ? String(d.packageName).trim() : null, dueDate: d.dueDate ? String(d.dueDate).slice(0, 10) : null,
  };
}

// Pays the bill from the Techlink wallet. Returns { orderId, newBalance }.
async function pay(kind, account, amount, phone, service) {
  const path = { ecg: '/ecg', water: '/water', tv: '/tv' }[kind];
  const body = kind === 'tv' ? { service, account, amount } : { meter: account, amount, phone };
  const d = await call('post', path, { body });
  if (!d.orderId) throw new TlError('unknown', 'Techlink did not return an order number');
  const nb = Number(d.newBalance);
  return { orderId: String(d.orderId), newBalance: Number.isFinite(nb) ? nb : null, message: messageOf(d) };
}

// 'completed' | 'failed' | 'pending' for one of our Techlink orders (asks Techlink to re-check with the biller).
async function orderStatus(orderId) {
  const d = await call('post', `/orders/${encodeURIComponent(orderId)}/verify`, { timeout: 20000 });
  const st = String(d.status || '').toLowerCase();
  if (['completed', 'complete', 'successful', 'success', 'delivered', 'paid'].includes(st)) return 'completed';
  if (['failed', 'cancelled', 'canceled', 'refunded', 'reversed', 'rejected', 'declined'].includes(st)) return 'failed';
  return 'pending';
}

// Recent Techlink orders, for the admin to check a payment that got no answer.
async function recentOrders(limit = 25) {
  const d = await call('get', '/orders', { params: { page: 1, limit } });
  const rows = Array.isArray(d.rows) ? d.rows : Array.isArray(d.data) ? d.data : Array.isArray(d) ? d : [];
  return rows.slice(0, limit);
}

async function balance() {
  const d = await call('get', '/wallet/balance', { timeout: 15000 });
  for (const k of ['balance', 'walletBalance', 'wallet_balance', 'amount']) {
    const v = d[k] ?? (d.data && d.data[k]);
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

module.exports = { available, lookup, pay, orderStatus, recentOrders, balance, isLowBalance, TlError, TV_SERVICES };
