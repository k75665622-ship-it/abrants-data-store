/*
 * FastDealsGH API v2: result checkers, AFA registration and MTN UP2U packages (data + minutes, delivered by their team).
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

/*
 * One MTN UP2U package from the "mtnup2u" list in /products -> { id, name, cost, dataGB, minutes, validity, inStock }.
 * Sizes are read from the package's own fields, or else from its name ("10GB + 100 mins").
 */
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
function up2uPackage(p) {
  if (!p) return null;
  const id = num(p.package_id ?? p.id);
  const name = String(p.name || p.title || p.label || '').trim();
  const cost = num(p.price ?? p.cost ?? p.amount);
  if (!id || cost == null) return null;
  const text = `${name} ${p.description || ''}`;
  const gbIn = text.match(/(\d+(?:\.\d+)?)\s*(GB|MB)\b/i);
  let dataGB = num(p.data_gb ?? p.volume_gb ?? p.capacity_gb);
  if (dataGB == null && num(p.data_mb ?? p.volume_mb) != null) dataGB = num(p.data_mb ?? p.volume_mb) / 1000;
  if (dataGB == null && gbIn) dataGB = Number(gbIn[1]) / (gbIn[2].toUpperCase() === 'MB' ? 1000 : 1);
  const minIn = text.match(/(\d+)\s*(?:mins?|minutes)\b/i);
  const minutes = num(p.minutes ?? p.mins ?? p.voice_minutes) ?? (minIn ? Number(minIn[1]) : null);
  const stock = p.in_stock ?? p.available ?? p.active;
  return {
    id, name, cost, dataGB, minutes,
    validity: String(p.validity || p.duration || '').trim() || null,
    inStock: stock == null ? true : stock !== false && stock !== 0 && stock !== '0',
  };
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
    up2u: (Array.isArray(d.mtnup2u) ? d.mtnup2u : []).map(up2uPackage).filter(Boolean),
  };
  productsCache = { at: Date.now(), data };
  return data;
}

const buyChecker = (ref, typeId, quantity, phone) => call('post', '/checkers/purchase', { checker_type_id: typeId, quantity, phone }, ref);
const getChecker = (providerRef) => call('get', `/checkers/orders/${encodeURIComponent(providerRef)}`);
const registerAfa = (ref, afa) => call('post', '/afa/register', afa, ref);
const getAfa = (providerRef) => call('get', `/afa/${encodeURIComponent(providerRef)}`);
const wallet = () => call('get', '/me');
// MTN UP2U: charged once; the order starts "pending", then "processing", then "successful" or "failed"/"refunded".
const buyUp2u = (ref, packageId, phone) => call('post', '/mtnup2u/purchase', { package_id: packageId, phone }, ref);
const getOrder = (reference) => call('get', `/orders/${encodeURIComponent(reference)}`);

module.exports = { available, products, buyChecker, getChecker, registerAfa, getAfa, wallet, buyUp2u, getOrder, up2uPackage, FdError };
