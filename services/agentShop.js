/*
 * An agent's own shop page (abrantsdata.com/s/kwame-data-hub) and how the agent makes it theirs:
 * logo or photo, colour, a few words about them, an announcement, and which products are shown or "popular".
 *
 * A shop visit never reads the database: the agent is in memory, the page is public/shop.html with the shop's
 * details written in (so a link shared on WhatsApp previews with the shop's own name), and a logo is read once and
 * then kept in memory. Logos are small (the browser shrinks them to 320 × 320 before uploading).
 */
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-generator');
const { pool } = require('./orderStore');
const { siteOrigin } = require('./siteUrl');

const lazy = (name) => require('./' + name);
const A = () => lazy('agents');

const THEMES = ['gold', 'blue', 'green', 'purple', 'red', 'teal', 'orange', 'pink'];
const LOGO_MAX = 150 * 1024;
const LOGO_TYPES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

/* ------------------------------------------------------------------ the agent's settings */

/** Shop name, WhatsApp, about line, announcement and colour (agent page → My shop). */
async function updateShop(id, b) {
  const agents = A();
  const a = agents.getAgent(id);
  if (!a) return { error: 'Not found.', status: 404 };
  const shopName = b.shopName === undefined ? a.shopName : agents.cleanText(b.shopName, 40);
  if (shopName.length < 2) return { error: 'Give your shop a name.', field: 'shopName' };
  let whatsapp = a.whatsapp || null;
  if (b.whatsapp !== undefined) {
    const raw = String(b.whatsapp || '').trim();
    const p = raw ? require('./orderStore').normalizePhone(raw) : '';
    if (raw && !require('./orderStore').PHONE_RE.test(p)) return { error: 'Enter a valid WhatsApp number, or leave it empty.', field: 'whatsapp' };
    whatsapp = p || null;
  }
  const bio = b.bio === undefined ? a.bio : agents.cleanText(b.bio, 140);
  const announcement = b.announcement === undefined ? a.announcement : agents.cleanText(b.announcement, 120);
  const theme = b.theme === undefined ? a.theme : String(b.theme || '');
  if (!THEMES.includes(theme)) return { error: 'Choose one of the colours.', field: 'theme' };
  await pool.query('UPDATE agents SET shop_name = $2, whatsapp = $3, bio = $4, announcement = $5, theme = $6 WHERE id = $1',
    [id, shopName, whatsapp, bio || null, announcement || null, theme]);
  return { agent: await agents.reload(id) };
}

/* ------------------------------------------------------------------ logo */

const logos = new Map(); // agent id -> { v, type, data }
const logoUrl = (a) => (a && a.logoV ? `/s/${a.slug}/logo?v=${a.logoV}` : null);
const forgetLogo = (id) => logos.delete(Number(id));

/** data:image/jpeg;base64,... (or png / webp), at most 150 KB. */
async function setLogo(id, dataUrl) {
  const a = A().getAgent(id);
  if (!a) return { error: 'Not found.', status: 404 };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Choose a photo or logo (JPG, PNG or WebP).' };
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || data.length > LOGO_MAX) return { error: 'That picture is too big. Choose a smaller one.' };
  const magic = LOGO_TYPES[m[1]];
  if (!magic.every((byte, i) => data[i] === byte) || (m[1] === 'image/webp' && data.slice(8, 12).toString('latin1') !== 'WEBP')) {
    return { error: 'That file is not a picture.' };
  }
  await pool.query(`INSERT INTO agent_logos (agent_id, data, type, updated_at) VALUES ($1, $2, $3, NOW())
    ON CONFLICT (agent_id) DO UPDATE SET data = EXCLUDED.data, type = EXCLUDED.type, updated_at = NOW()`, [id, data, m[1]]);
  const r = await pool.query('UPDATE agents SET logo_v = logo_v + 1 WHERE id = $1 RETURNING logo_v', [id]);
  logos.set(Number(id), { v: Number(r.rows[0].logo_v), type: m[1], data });
  return { agent: await A().reload(id) };
}

async function removeLogo(id) {
  await pool.query('DELETE FROM agent_logos WHERE agent_id = $1', [id]);
  await pool.query('UPDATE agents SET logo_v = 0 WHERE id = $1', [id]);
  forgetLogo(id);
  return { agent: await A().reload(id) };
}

/** -> { type, data, v } or null. From memory after the first time. */
async function getLogo(slug) {
  const a = A().bySlug.get(String(slug || '').toLowerCase());
  if (!a || !a.logoV || a.status === 'deleted') return null;
  const hit = logos.get(a.id);
  if (hit && hit.v === a.logoV) return hit;
  const r = await pool.query('SELECT data, type FROM agent_logos WHERE agent_id = $1', [a.id]);
  if (!r.rows[0]) return null;
  const out = { v: a.logoV, type: r.rows[0].type, data: r.rows[0].data };
  logos.set(a.id, out);
  return out;
}

/* ------------------------------------------------------------------ QR code */

const qrs = new Map(); // url -> svg
function qrSvg(url) {
  if (qrs.has(url)) return qrs.get(url);
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  const n = q.getModuleCount();
  const quiet = 2;
  let d = '';
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (q.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const size = n + quiet * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0b1020"/></svg>`;
  if (qrs.size > 2000) qrs.clear();
  qrs.set(url, svg);
  return svg;
}

/* ------------------------------------------------------------------ what a visitor sees */

const origin = (req) => siteOrigin() || `${req.protocol}://${req.get('host')}`;

/** The public view of a shop. owner: the visitor is this shop's agent (logged in). */
function view(a, { open, owner = false, off = null } = {}) {
  if (!a || !open) {
    // While every shop is switched off, everyone is told whether it comes back; the agent also sees why.
    const why = off && a && a.status === 'active' ? { programmeOff: { back: off.back, backOn: off.backOn, ...(owner ? { reason: off.reason } : {}) } } : {};
    return { open: false, ...why, ...(owner && a ? { owner: true, status: a.status } : {}) };
  }
  const x = A().extraOf(a.id);
  return {
    open: true, slug: a.slug, name: a.shopName, bio: a.bio, announcement: a.announcement, theme: a.theme, logo: logoUrl(a),
    whatsapp: a.whatsapp || '', delivered: x.delivered >= 10 ? x.delivered : null,
    since: a.approvedAt ? new Date(a.approvedAt).toISOString().slice(0, 7) : null, owner,
  };
}

async function shopFor(req, slug) {
  const s = String(slug || '').toLowerCase();
  const a = A().bySlug.get(s) || null;
  const open = Boolean(await A().shopAgent(s));
  const me = A().agentFromRequest(req);
  return { a, open, owner: Boolean(me && a && me.id === a.id), off: A().offInfo(await A().settingsNow()) };
}

let template = null;
function page() {
  if (!template || process.env.NODE_ENV !== 'production') template = fs.readFileSync(path.join(__dirname, '..', 'public', 'shop.html'), 'utf8');
  return template;
}
const attr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The shop page with the shop's name, description, colour and details written in. */
async function render(req, slug) {
  const { a, open, owner, off } = await shopFor(req, slug);
  const data = view(a, { open, owner, off });
  const base = origin(req);
  const title = open ? `${a.shopName} · Data, result checkers and AFA` : 'Shop closed · Abrants Data Store';
  const desc = open ? (a.bio || `Buy MTN, Telecel and AirtelTigo data, WASSCE and BECE result checkers and MTN AFA from ${a.shopName}. Pay with MoMo or card.`)
    : 'This shop is not open right now.';
  const head = [
    `<title>${attr(title)}</title>`,
    `<meta name="description" content="${attr(desc)}" />`,
    `<meta property="og:title" content="${attr(open ? a.shopName : 'Shop closed')}" />`,
    `<meta property="og:description" content="${attr(desc)}" />`,
    '<meta property="og:type" content="website" />',
    open ? `<meta property="og:url" content="${attr(`${base}/s/${a.slug}`)}" />` : '',
    open && a.logoV ? `<meta property="og:image" content="${attr(base + logoUrl(a))}" />` : '',
    open ? '' : '<meta name="robots" content="noindex" />',
  ].filter(Boolean).join('\n');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return {
    status: a && a.status !== 'deleted' ? 200 : 404,
    html: page()
      .replace('<html lang="en" data-theme="gold">', `<html lang="en" data-theme="${open && THEMES.includes(a.theme) ? a.theme : 'gold'}">`)
      .replace('<!--SHOP_HEAD-->', head)
      .replace('<!--SHOP_DATA-->', `<script type="application/json" id="shopData">${json}</script>`),
  };
}

module.exports = { THEMES, updateShop, setLogo, removeLogo, getLogo, logoUrl, forgetLogo, qrSvg, view, shopFor, render, origin };
