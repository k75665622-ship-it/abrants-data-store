/*
 * Early warning: asks each provider for its list of bundles and looks for a stock / availability
 * flag. Providers name this differently (inStock, available, status ...), so the check is
 * deliberately tolerant. If a provider publishes no such flag, the result says "unknown" and the
 * admin still gets the warning the moment an order is refused for being out of stock.
 */
const datahustle = require('./datahustle');
const fastdeals = require('./fastdeals');
const { getSettings, saveSettings } = require('./orderStore');

const NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];
const label = (n) => (n === 'Telecel' ? 'Telecel (Vodafone)' : n);
const provLabel = (p) => (p === 'fastdeals' ? 'FastDealsGH' : 'DataHustle');

function networkOf(item) {
  const t = String(item.network || item.networkCode || item.network_code || item.network_name || item.networkName || item.type || '').toLowerCase();
  if (/mtn|yello/.test(t)) return 'MTN';
  if (/telecel|vodafone|vod/.test(t)) return 'Telecel';
  if (/airtel|tigo|^at/.test(t)) return 'AirtelTigo';
  return null;
}

// true = available, false = unavailable, null = no flag found on this item
function availability(item) {
  if (!item || typeof item !== 'object') return null;
  for (const k of ['inStock', 'in_stock', 'isAvailable', 'is_available', 'available', 'isActive', 'is_active', 'active', 'enabled']) {
    if (typeof item[k] === 'boolean') return item[k];
  }
  for (const k of ['outOfStock', 'out_of_stock', 'soldOut', 'sold_out']) {
    if (typeof item[k] === 'boolean') return !item[k];
  }
  for (const k of ['stock', 'quantity', 'stockQuantity', 'stock_quantity']) {
    if (typeof item[k] === 'number') return item[k] > 0;
  }
  for (const k of ['status', 'stockStatus', 'stock_status', 'availability']) {
    if (typeof item[k] === 'string') {
      const v = item[k].toLowerCase();
      if (/out.?of.?stock|unavailable|sold.?out|inactive|disabled|offline|empty/.test(v)) return false;
      if (/in.?stock|available|active|enabled|online/.test(v)) return true;
    }
  }
  return null;
}

function flatten(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const out = [];
    for (const v of Object.values(data)) { if (Array.isArray(v)) out.push(...v); }
    return out.length ? out : [data];
  }
  return [];
}

function summarise(items, forcedNetwork) {
  const per = {};
  for (const n of NETWORKS) per[n] = { total: 0, up: 0, down: 0, unknown: 0 };
  for (const item of items) {
    const n = forcedNetwork || networkOf(item);
    if (!n || !per[n]) continue;
    per[n].total++;
    const a = availability(item);
    if (a === true) per[n].up++; else if (a === false) per[n].down++; else per[n].unknown++;
  }
  const result = {};
  for (const n of NETWORKS) {
    const p = per[n];
    result[n] = !p.total ? 'unknown' : (p.down === p.total ? 'out' : (p.up + p.down === 0 ? 'unknown' : (p.down ? 'partial' : 'ok')));
    result[n + 'Counts'] = p;
  }
  return result;
}

async function checkProviders() {
  const out = { datahustle: null, fastdeals: null, sample: {} };
  if (process.env.DATAHUSTLE_API_KEY && process.env.DATAHUSTLE_MOCK_MODE !== 'true') {
    try {
      const items = flatten(await datahustle.getDataPackages());
      out.datahustle = summarise(items);
      out.sample.datahustle = items[0] ? Object.keys(items[0]) : [];
    } catch (e) { out.datahustle = { error: String(e.response?.data?.message || e.message).slice(0, 120) }; }
  }
  if (fastdeals.configured() && process.env.FASTDEALS_MOCK_MODE !== 'true') {
    const items = []; let err = null;
    for (const n of NETWORKS) {
      try { const plans = await fastdeals.listPlans(n, { fresh: true }); plans.forEach((p) => items.push({ ...p, network: p.network || n })); }
      catch (e) { err = String(e.response?.data?.message || e.message).slice(0, 120); }
    }
    out.fastdeals = items.length ? summarise(items) : { error: err || 'No plans returned' };
    out.sample.fastdeals = items[0] ? Object.keys(items[0]) : [];
  }
  return out;
}

// Runs every 10 minutes. Posts one admin notice when a provider newly shows a network as out, and one
// when it is back. Never pauses or switches anything.
async function stockWatchTick(addAlert) {
  const res = await checkProviders();
  const s = await getSettings();
  const prev = { ...(s.stockWatch || {}) };
  const next = { ...prev };
  for (const prov of ['datahustle', 'fastdeals']) {
    const r = res[prov];
    if (!r || r.error) continue;
    for (const n of NETWORKS) {
      const key = prov + ':' + n;
      const now = r[n];
      if (now === 'unknown') continue;
      if (now === 'out' && prev[key] !== 'out') {
        await addAlert('warn', `Early warning: ${provLabel(prov)} now shows ${label(n)} as out of stock. You may want to post a notice for customers, or switch ${label(n)} to the other provider in Settings once you have checked its wallet.`);
      } else if (now !== 'out' && prev[key] === 'out') {
        await addAlert('info', `${provLabel(prov)} shows ${label(n)} in stock again.`);
      }
      next[key] = now === 'out' ? 'out' : 'ok';
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(prev)) await saveSettings({ stockWatch: next });
  return res;
}

module.exports = { checkProviders, stockWatchTick, summarise, availability, flatten };
