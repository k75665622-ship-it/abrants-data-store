/*
 * Tracking links: a link like abrantsdata.com/?from=kwame tells the store who sent the visitor.
 *
 * The storefront remembers the tag in the visitor's browser (public/js/track.js) and sends it with the
 * checkout. It is saved on the order, so the admin can see what each link brought. Nothing is written
 * when someone merely opens a link: that would keep the database awake (Neon free plan, README 19).
 *
 * The tag is a plain word like "kwame". The `campaigns` table only holds the name, note and commission
 * the owner gave it. An order can carry a tag that has no row there (someone typed ?from=tiktok by hand,
 * or a link was deleted); the admin page lists those too, so no order is ever hidden.
 */
const crypto = require('crypto');
const { pool } = require('./orderStore');

// Every link opens the whole website (home page); the visitor picks data, AFA or checkers from there.
// The tag is remembered in the browser, so it still counts if they go on to the checker page.
const pathFor = (code) => `/?from=${code}`;

// Orders that really were paid and not refunded. Data matches the dashboard's own revenue figure.
const DATA_PAID = ['paid', 'processing', 'fulfilled'];
const SERVICE_PAID = ['paid', 'sending', 'completed', 'submitted', 'approved'];

const RANGES = { '7d': 'Last 7 days', '30d': 'Last 30 days', month: 'This month', all: 'All time' };

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** A tag is a short lowercase word: letters, digits, - and _. Anything else is ignored, never stored. */
function cleanCode(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v) ? v : null;
}

function slug(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '');
  return s || 'link';
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Checks what the admin typed. Returns { error } or { value }. */
function validate(input, { partial = false } = {}) {
  const b = input || {};
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = cleanText(b.name, 60);
    if (out.name.length < 2) return { error: 'Type a name, like the influencer\'s name.' };
  }
  if (!partial || b.note !== undefined) out.note = cleanText(b.note, 200) || null;
  if (!partial || b.commissionGHS !== undefined) {
    if (b.commissionGHS === '' || b.commissionGHS == null) out.commissionGHS = null;
    else {
      const c = Number(b.commissionGHS);
      if (!Number.isFinite(c) || c < 0 || c > 1000) return { error: 'Commission must be an amount between 0 and 1000.' };
      out.commissionGHS = round2(c);
    }
  }
  return { value: out };
}

function mapLink(r) {
  return {
    code: r.code, name: r.name, note: r.note || '', path: pathFor(r.code),
    commissionGHS: r.commission_ghs == null ? null : Number(r.commission_ghs), createdAt: r.created_at,
  };
}

async function listLinks() {
  const r = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
  return r.rows.map(mapLink);
}

/** Makes a new link. The code comes from the name ("Kwame Mensah" -> kwame-mensah), made unique if taken. */
async function createLink(input, wantedCode) {
  const v = validate(input);
  if (v.error) return { error: v.error };
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM campaigns');
  if (count.rows[0].n >= 500) return { error: 'That is a lot of links. Delete some you no longer use.' };

  const explicit = wantedCode == null ? null : cleanCode(wantedCode);
  if (wantedCode != null && !explicit) return { error: 'That link tag is not valid.' };
  const base = explicit || slug(v.value.name);
  const tries = explicit ? [base] : [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}-${n}`), `${base}-${crypto.randomBytes(2).toString('hex')}`];
  for (const code of tries) {
    const r = await pool.query(
      `INSERT INTO campaigns (code, name, note, commission_ghs) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO NOTHING RETURNING *`,
      [code, v.value.name, v.value.note, v.value.commissionGHS]
    );
    if (r.rows[0]) return { link: mapLink(r.rows[0]) };
  }
  return { error: explicit ? 'You already have a link with that tag.' : 'Could not make a unique link. Try a slightly different name.', status: 409 };
}

async function updateLink(code, input) {
  const v = validate(input, { partial: true });
  if (v.error) return { error: v.error };
  const cols = { name: 'name', note: 'note', commissionGHS: 'commission_ghs' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(cols)) {
    if (v.value[k] === undefined) continue;
    vals.push(v.value[k]); sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return { error: 'Nothing to change.' };
  vals.push(String(code));
  const r = await pool.query(`UPDATE campaigns SET ${sets.join(', ')} WHERE code = $${vals.length} RETURNING *`, vals);
  return r.rows[0] ? { link: mapLink(r.rows[0]) } : { error: 'That link no longer exists.', status: 404 };
}

/** Deleting a link never touches orders: they keep their tag and still show up as "not saved as a link". */
async function deleteLink(code) {
  const r = await pool.query('DELETE FROM campaigns WHERE code = $1', [String(code)]);
  return r.rowCount > 0;
}

function rangeStart(range) {
  const now = new Date();
  if (range === '7d') return new Date(now.getTime() - 7 * 864e5);
  if (range === '30d') return new Date(now.getTime() - 30 * 864e5);
  if (range === 'month') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return null;
}

/**
 * What each tag brought. One pass over paid data orders and paid checker/AFA orders.
 * A customer is "new" when this was their first paid order here, ever (even if the range is shorter).
 */
async function stats(range) {
  const key = RANGES[range] ? range : '30d';
  const since = rangeStart(key);
  const r = await pool.query(`
    WITH paid AS (
      SELECT campaign, (campaign IS NOT NULL) AS tagged, phone, price_ghs::numeric AS revenue,
             CASE WHEN provider_cost_ghs IS NULL THEN NULL ELSE price_ghs - provider_cost_ghs - COALESCE(payment_fee_ghs, 0) END AS profit,
             created_at
        FROM orders WHERE source = 'store' AND status = ANY($1)
      UNION ALL
      SELECT campaign, (campaign IS NOT NULL), phone, price_ghs::numeric,
             CASE WHEN cost_ghs IS NULL THEN NULL ELSE price_ghs - cost_ghs - COALESCE(payment_fee_ghs, 0) END,
             created_at
        FROM service_orders WHERE status = ANY($2)
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY phone ORDER BY created_at) AS nth FROM paid
    )
    SELECT campaign, tagged, GROUPING(campaign)::int AS rolled_up,
           COUNT(*)::int AS orders, COUNT(DISTINCT phone)::int AS customers,
           COUNT(*) FILTER (WHERE nth = 1)::int AS new_customers,
           COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(profit), 0) AS profit, MAX(created_at) AS last_order
      FROM ranked
     WHERE ($3::timestamptz IS NULL OR created_at >= $3)
     GROUP BY GROUPING SETS ((campaign), (tagged))
  `, [DATA_PAID, SERVICE_PAID, since]);

  const zero = { orders: 0, customers: 0, newCustomers: 0, revenueGHS: 0, profitGHS: 0, lastOrderAt: null };
  const shape = (x) => ({
    orders: x.orders, customers: x.customers, newCustomers: x.new_customers,
    revenueGHS: round2(x.revenue), profitGHS: round2(x.profit), lastOrderAt: x.last_order,
  });
  const byCode = new Map();
  let tagged = { ...zero }; let direct = { ...zero };
  for (const x of r.rows) {
    if (x.rolled_up === 0) { if (x.campaign) byCode.set(x.campaign, shape(x)); }
    else if (x.tagged) tagged = shape(x);
    else direct = shape(x);
  }

  const saved = await listLinks();
  const known = new Set(saved.map((l) => l.code));
  const links = saved.map((l) => {
    const s = byCode.get(l.code) || zero;
    return { ...l, ...s, commissionEarnedGHS: l.commissionGHS == null ? null : round2(l.commissionGHS * s.orders) };
  });
  // Best first: the order count, then the money, then the newest link.
  links.sort((a, b) => b.orders - a.orders || b.revenueGHS - a.revenueGHS || new Date(b.createdAt) - new Date(a.createdAt));
  const others = [...byCode.entries()].filter(([code]) => !known.has(code))
    .map(([code, s]) => ({ code, ...s })).sort((a, b) => b.orders - a.orders);

  const total = tagged.orders + direct.orders;
  return {
    range: key, ranges: RANGES,
    links, others, totals: tagged, direct,
    sharePercent: total ? Math.round((tagged.orders / total) * 100) : 0,
  };
}

module.exports = { cleanCode, listLinks, createLink, updateLink, deleteLink, stats, RANGES };
