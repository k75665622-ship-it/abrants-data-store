/*
 * FastDealsGH API v2: result checkers and AFA registration.
 * Every purchase carries an Idempotency-Key (our own order reference), so a retry after a timeout
 * can never charge the wallet twice. Errors are decided on error.code, never on message text.
 */
const axios = require('axios');

const base = () => process.env.FASTDEALS_V2_BASE_URL || 'https://fastdealsgh.com/api/v2';
const available = () => Boolean(process.env.FASTDEALS_API_KEY);

class FdError extends Error {
  constructor(code, message, status, field) { super(message || code); this.code = code; this.status = status; this.field = field; }
}

async function call(method, path, body, idempotencyKey) {
  if (!available()) throw new FdError('not_configured', 'FastDealsGH is not connected (FASTDEALS_API_KEY).');
  const headers = { Authorization: `Bearer ${process.env.FASTDEALS_API_KEY}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  try {
    const res = await axios({ method, url: base() + path, data: body, headers, timeout: Number(process.env.FASTDEALS_V2_TIMEOUT_MS || 30000) });
    if (!res.data || res.data.success !== true) throw new FdError('bad_response', 'Unexpected answer from FastDealsGH', res.status);
    return res.data.data || {};
  } catch (err) {
    if (err instanceof FdError) throw err;
    const e = err.response?.data?.error;
    if (e && e.code) throw new FdError(e.code, e.message, err.response.status, e.field || e.details?.field);
    // No answer (timeout / network / 5xx): unknown outcome. Safe to retry with the same key.
    throw new FdError('network', err.message, err.response?.status);
  }
}

let productsCache = { at: 0, data: null };
async function products({ fresh = false } = {}) {
  if (!fresh && productsCache.data && Date.now() - productsCache.at < 5 * 60 * 1000) return productsCache.data;
  const d = await call('get', '/products');
  const data = {
    checkers: (Array.isArray(d.checkers) ? d.checkers : []).map((c) => ({
      id: Number(c.checker_type_id), code: String(c.code || c.name || '').toUpperCase(), name: String(c.name || c.code || ''),
      cost: Number(c.price), stock: c.in_stock == null ? null : Number(c.in_stock),
    })).filter((c) => c.id && c.code),
    afaFee: d.afa_registration_fee == null ? null : Number(d.afa_registration_fee),
  };
  productsCache = { at: Date.now(), data };
  return data;
}

const buyChecker = (ref, typeId, quantity, phone) => call('post', '/checkers/purchase', { checker_type_id: typeId, quantity, phone }, ref);
const getChecker = (providerRef) => call('get', `/checkers/orders/${encodeURIComponent(providerRef)}`);
const registerAfa = (ref, afa) => call('post', '/afa/register', afa, ref);
const getAfa = (providerRef) => call('get', `/afa/${encodeURIComponent(providerRef)}`);
const wallet = () => call('get', '/me');

module.exports = { available, products, buyChecker, getChecker, registerAfa, getAfa, wallet, FdError };
