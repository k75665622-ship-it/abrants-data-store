/*
 * The store's pulse for the home page: how fast each network has been delivering, what sold most this week, and the
 * latest deliveries ("059•••••42 got MTN 4GB"). Kept in memory: one query when the server starts, then every
 * delivered order is added as it happens (orderStore's status hook), so the home page never reads the database.
 * Numbers are shown as their first 3 and last 2 digits only.
 */
const DAY = 24 * 60 * 60 * 1000;
const KEEP_MS = 7 * DAY;
const MAX = 600;
let deliveries = []; // newest first: { ref, network, label, planId, phone, paidAt, doneAt }

const ms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
function prune(now = Date.now()) {
  deliveries = deliveries.filter((d) => now - d.doneAt < KEEP_MS).slice(0, MAX);
}

/** The last week's delivered data orders, once at start. */
async function load() {
  const { pool } = require('./orderStore');
  const r = await pool.query(`SELECT reference, plan_id, network, label, phone, created_at, updated_at FROM orders
    WHERE status = 'fulfilled' AND updated_at > NOW() - INTERVAL '7 days' ORDER BY updated_at DESC LIMIT ${MAX}`);
  deliveries = r.rows.map((x) => ({ ref: x.reference, network: x.network, label: x.label, planId: x.plan_id, phone: x.phone, paidAt: ms(x.created_at), doneAt: ms(x.updated_at) }));
}

/** An order changed status (orderStore): a newly delivered data order joins the pulse. */
function record(row, oldStatus) {
  if (!row || row.status !== 'fulfilled' || oldStatus === 'fulfilled' || deliveries.some((d) => d.ref === row.reference)) return;
  deliveries.unshift({ ref: row.reference, network: row.network, label: row.label, planId: row.plan_id, phone: row.phone, paidAt: ms(row.created_at), doneAt: Date.now() });
  prune();
}

// 0241234567 -> 024•••••67
const mask = (p) => (/^0\d{9}$/.test(String(p)) ? `${p.slice(0, 3)}•••••${p.slice(-2)}` : '•••');

function speedLabel(min) {
  if (min < 1) return 'Under a minute';
  if (min < 5) return 'Under 5 mins';
  if (min < 15) return '5–15 mins';
  if (min < 30) return '15–30 mins';
  if (min < 60) return '30–60 mins';
  const h = Math.round(min / 60);
  return h <= 1 ? 'About an hour' : `About ${h} hours`;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** What the home page shows. Networks need 3 deliveries this week to get a speed; a list needs 3 entries to show. */
function summary(now = Date.now()) {
  prune(now);
  const speed = [];
  for (const network of ['MTN', 'MTN UP2U', 'Telecel', 'AirtelTigo']) {
    const last = deliveries.filter((d) => d.network === network && d.doneAt >= d.paidAt).slice(0, 20);
    if (last.length < 3) continue;
    const min = median(last.map((d) => (d.doneAt - d.paidAt) / 60000));
    // A fuller bar is faster: under a minute is full, 4 hours or more is nearly empty.
    const fill = Math.max(0.08, Math.min(1, 1 - Math.log(1 + min) / Math.log(1 + 240)));
    speed.push({ network, minutes: Math.round(min * 10) / 10, label: speedLabel(min), fill: Math.round(fill * 100) / 100 });
  }
  const counts = new Map();
  for (const d of deliveries) counts.set(d.planId, (counts.get(d.planId) || 0) + 1);
  const popular = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([planId, sold]) => ({ planId, sold }));
  const live = deliveries.filter((d) => now - d.doneAt < 2 * DAY).slice(0, 10)
    .map((d) => ({ who: mask(d.phone), network: d.network, label: d.label, agoMs: now - d.doneAt }));
  return { speed, popular: popular.length >= 3 ? popular : [], live: live.length >= 3 ? live : [] };
}

module.exports = { load, record, summary, mask, speedLabel };
