/*
 * Agents: people who sell everything the store sells through their own shop link (abrantsdata.com/s/kwame-data)
 * and keep the difference between their selling price and the agent price the store sets.
 *
 *  - The store sets an agent price per product (Admin → Agents). Each agent sets their own selling price, never
 *    below the agent price and with no upper limit. Their customers pay that price through Paystack as usual.
 *  - What the agent earns is saved on the order: selling price minus agent price, less Paystack's cut of that
 *    difference when the store carries the fee. The store's own takings are exactly those of a sale at the agent price.
 *  - The money becomes the agent's only once the order is delivered (checker PINs sent, AFA approved), and is held a
 *    little longer (holdHours) before it can be paid out. A failed or refunded order earns nothing; if the agent was
 *    already paid for it, the amount comes off their next payout.
 *  - Payouts go to the agent's MoMo: sent through Paystack Transfers, or paid by hand and marked paid in Admin.
 *    Weekly automatic payouts are optional.
 *
 * Neon (README 19): agents and shop links are kept in memory, so a customer opening a shop link costs no database
 * query. The database is read when someone buys, when an agent or the admin opens their pages, and on payout day.
 */
const crypto = require('crypto');
const { pool, getSettings, saveSettings, normalizePhone, PHONE_RE } = require('./orderStore');
const { hashPassword, verifyPassword, passwordProblem } = require('./customers');
const { feeRate, round2 } = require('./fees');

const NETWORKS = ['MTN', 'Telecel', 'AirtelTigo'];
const MOMO_BANK = { MTN: 'MTN', Telecel: 'VOD', AirtelTigo: 'ATL' }; // Paystack's mobile money codes for Ghana
const STATUSES = ['pending', 'active', 'suspended', 'rejected'];
const MAX_PRICE = 10000;
const DEFAULTS = {
  enabled: false, autoApprove: false, prices: {},
  holdHours: 24, minPayout: 20, payoutFee: 1,
  payoutMethod: 'manual', autoPayout: false, payoutDay: 1, lastAutoPayout: null,
};

// What counts as a finished sale, and what means "no sale", for each kind of order.
const DATA_DONE = ['fulfilled'];
const DATA_BAD = ['delivery_failed', 'refunding', 'refunded'];
const DATA_OPEN = ['paid', 'processing', 'delivery_review'];
const SVC_BAD = ['failed', 'refunding', 'refunded', 'rejected'];
const SVC_OPEN = ['paid', 'sending', 'submitted', 'review'];
const svcDone = (r) => (r.kind === 'checker' && r.status === 'completed') || (r.kind === 'afa' && r.status === 'approved');

const floor2 = (n) => Math.floor(Number(n) * 100 + 1e-6) / 100;
const lazy = (name) => require('./' + name);

function conf(settings) {
  const a = { ...DEFAULTS, ...((settings && settings.agents) || {}) };
  a.prices = a.prices && typeof a.prices === 'object' ? a.prices : {};
  return a;
}
async function settingsNow() { return conf(await getSettings()); }

/* ------------------------------------------------------------------ schema and memory */

async function initAgentDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id BIGSERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      shop_name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      whatsapp TEXT,
      momo_number TEXT NOT NULL,
      momo_network TEXT NOT NULL,
      momo_name TEXT NOT NULL,
      recipient_code TEXT,
      recipient_for TEXT,
      prices JSONB NOT NULL DEFAULT '{}'::jsonb,
      admin_note TEXT,
      must_change_password BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      momo_changed_at TIMESTAMPTZ
    );
    -- One row per order an agent earned on ('sale'), plus a negative 'clawback' row when an order the agent was
    -- already paid for is refunded later. payout_id is set once the money is in a payout.
    CREATE TABLE IF NOT EXISTS agent_earnings (
      id BIGSERIAL PRIMARY KEY,
      agent_id BIGINT NOT NULL REFERENCES agents(id),
      order_kind TEXT NOT NULL CHECK (order_kind IN ('data','service')),
      order_ref TEXT NOT NULL,
      entry TEXT NOT NULL DEFAULT 'sale' CHECK (entry IN ('sale','clawback')),
      amount_ghs NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','cancelled')),
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payout_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (order_kind, order_ref, entry)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_earnings_agent ON agent_earnings (agent_id, payout_id, status);
    CREATE TABLE IF NOT EXISTS agent_payouts (
      id BIGSERIAL PRIMARY KEY,
      agent_id BIGINT NOT NULL REFERENCES agents(id),
      amount_ghs NUMERIC(12,2) NOT NULL,
      fee_ghs NUMERIC(12,2) NOT NULL DEFAULT 0,
      sent_ghs NUMERIC(12,2) NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('paystack','manual')),
      status TEXT NOT NULL CHECK (status IN ('sending','otp','paid','failed')),
      reference TEXT UNIQUE,
      transfer_code TEXT,
      momo_number TEXT,
      momo_network TEXT,
      momo_name TEXT,
      note TEXT,
      trigger TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agent_payouts_agent ON agent_payouts (agent_id, created_at DESC);
  `);
  await loadAgents();
}

const byId = new Map();
const bySlug = new Map();

function mapAgent(r) {
  if (!r) return null;
  return {
    id: Number(r.id), slug: r.slug, name: r.name, shopName: r.shop_name, phone: r.phone, passwordHash: r.password_hash,
    status: r.status, whatsapp: r.whatsapp || '', momoNumber: r.momo_number, momoNetwork: r.momo_network, momoName: r.momo_name,
    recipientCode: r.recipient_code || null, recipientFor: r.recipient_for || null,
    prices: r.prices && typeof r.prices === 'object' ? r.prices : {}, adminNote: r.admin_note || '',
    mustChangePassword: Boolean(r.must_change_password), createdAt: r.created_at, approvedAt: r.approved_at,
    lastLoginAt: r.last_login_at, momoChangedAt: r.momo_changed_at,
  };
}
function remember(a) {
  if (!a) return null;
  const old = byId.get(a.id);
  if (old && old.slug !== a.slug) bySlug.delete(old.slug);
  byId.set(a.id, a); bySlug.set(a.slug, a);
  return a;
}
async function loadAgents() {
  const r = await pool.query('SELECT * FROM agents');
  byId.clear(); bySlug.clear();
  for (const row of r.rows) remember(mapAgent(row));
}
async function reload(id) {
  const r = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
  return remember(mapAgent(r.rows[0]));
}
const getAgent = (id) => byId.get(Number(id)) || null;

/** The agent behind a shop link, only while the programme is on and the agent is active. Memory only. */
async function shopAgent(slug) {
  const s = await settingsNow();
  if (!s.enabled) return null;
  const a = bySlug.get(String(slug || '').trim().toLowerCase());
  return a && a.status === 'active' ? a : null;
}

/* ------------------------------------------------------------------ input checks */

const cleanText = (v, max) => String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const RESERVED = new Set(['abrants', 'admin', 'official', 'support', 'help', 'store', 'shop', 'agent', 'agents', 'api', 'www', 'mtn', 'telecel', 'airteltigo', 'paystack']);

function slugBase(shopName) {
  let s = String(shopName || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  if (s.length < 3 || RESERVED.has(s)) s = (s ? s + '-' : '') + 'shop';
  return s;
}

function cleanMomo(b) {
  const momoNumber = normalizePhone(b.momoNumber);
  const momoNetwork = NETWORKS.find((n) => n.toLowerCase() === String(b.momoNetwork || '').trim().toLowerCase());
  const momoName = cleanText(b.momoName, 60);
  if (!PHONE_RE.test(momoNumber)) return { error: 'Enter the MoMo number you want to be paid on.', field: 'momoNumber' };
  if (!momoNetwork) return { error: 'Choose the MoMo network.', field: 'momoNetwork' };
  if (momoName.length < 2) return { error: 'Enter the name on that MoMo account.', field: 'momoName' };
  return { value: { momoNumber, momoNetwork, momoName } };
}

function cleanWhatsapp(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return { value: '' };
  const p = normalizePhone(raw);
  return PHONE_RE.test(p) ? { value: p } : { error: 'Enter a valid WhatsApp number, or leave it empty.', field: 'whatsapp' };
}

/* ------------------------------------------------------------------ accounts */

async function register(input) {
  const b = input || {};
  const s = await settingsNow();
  if (!s.enabled) return { error: 'Agent sign-up is closed right now.', status: 403 };
  const name = cleanText(b.name, 60);
  const shopName = cleanText(b.shopName, 40);
  const phone = normalizePhone(b.phone);
  if (name.length < 2) return { error: 'Enter your full name.', field: 'name' };
  if (shopName.length < 2) return { error: 'Give your shop a name.', field: 'shopName' };
  if (!PHONE_RE.test(phone)) return { error: 'Enter a valid 10-digit phone number.', field: 'phone' };
  const problem = passwordProblem(b.password);
  if (problem) return { error: problem, field: 'password' };
  const momo = cleanMomo({ ...b, momoNumber: b.momoNumber || phone });
  if (momo.error) return momo;
  if (b.agree !== true) return { error: 'Please accept the agent terms.', field: 'agree' };

  const hash = await hashPassword(b.password);
  const status = s.autoApprove ? 'active' : 'pending';
  const base = slugBase(shopName);
  const tries = [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}-${n}`), `${base}-${crypto.randomBytes(2).toString('hex')}`];
  for (const slug of tries) {
    try {
      const r = await pool.query(
        `INSERT INTO agents (slug, name, shop_name, phone, password_hash, status, whatsapp, momo_number, momo_network, momo_name, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $6 = 'active' THEN NOW() END) RETURNING *`,
        [slug, name, shopName, phone, hash, status, phone, momo.value.momoNumber, momo.value.momoNetwork, momo.value.momoName]
      );
      const agent = remember(mapAgent(r.rows[0]));
      if (status === 'pending') await alert('info', `New agent waiting for approval: ${agent.shopName} (${agent.name}, ${agent.phone}). See Admin → Agents.`);
      return { agent };
    } catch (err) {
      if (err.code !== '23505') throw err;
      if (/phone/.test(err.constraint || err.detail || '')) return { error: 'This phone number already has an agent account. Log in instead.', status: 409, field: 'phone' };
    }
  }
  return { error: 'Could not create your shop link. Try a slightly different shop name.', status: 409, field: 'shopName' };
}

async function login(phone, password) {
  const p = normalizePhone(phone);
  const a = [...byId.values()].find((x) => x.phone === p);
  // Same work for unknown numbers, so a wrong number cannot be told apart from a wrong password by timing.
  const ok = await verifyPassword(String(password || ''), a ? a.passwordHash : 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64));
  if (!a || !ok) return null;
  if (a.status === 'rejected') return { blocked: true };
  pool.query('UPDATE agents SET last_login_at = NOW() WHERE id = $1', [a.id]).catch(() => {});
  return { agent: a };
}

async function updateProfile(id, b) {
  const shopName = cleanText(b.shopName, 40);
  if (shopName.length < 2) return { error: 'Give your shop a name.', field: 'shopName' };
  const w = cleanWhatsapp(b.whatsapp);
  if (w.error) return w;
  await pool.query('UPDATE agents SET shop_name = $2, whatsapp = $3 WHERE id = $1', [id, shopName, w.value || null]);
  return { agent: await reload(id) };
}

async function updateMomo(id, b) {
  const a = getAgent(id);
  if (!a) return { error: 'Not found.', status: 404 };
  if (!(await verifyPassword(String(b.password || ''), a.passwordHash))) return { error: 'Your password is not correct.', field: 'password', status: 400 };
  const m = cleanMomo(b);
  if (m.error) return m;
  const same = m.value.momoNumber === a.momoNumber && m.value.momoNetwork === a.momoNetwork && m.value.momoName === a.momoName;
  if (same) return { agent: a };
  // A new MoMo number waits a day before automatic payouts use it: if someone else got into the account,
  // the store has time to notice before money goes to them.
  await pool.query(`UPDATE agents SET momo_number = $2, momo_network = $3, momo_name = $4, recipient_code = NULL, recipient_for = NULL,
    momo_changed_at = NOW() WHERE id = $1`, [id, m.value.momoNumber, m.value.momoNetwork, m.value.momoName]);
  return { agent: await reload(id) };
}

async function changePassword(id, current, next) {
  const a = getAgent(id);
  if (!a || !(await verifyPassword(String(current || ''), a.passwordHash))) return { error: 'Your current password is not correct.' };
  const problem = passwordProblem(next);
  if (problem) return { error: problem };
  await pool.query('UPDATE agents SET password_hash = $2, must_change_password = false WHERE id = $1', [id, await hashPassword(next)]);
  return { agent: await reload(id) };
}

async function resetPassword(id) {
  if (!getAgent(id)) return null;
  const temp = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) + Math.floor(10 + Math.random() * 89);
  await pool.query('UPDATE agents SET password_hash = $2, must_change_password = true WHERE id = $1', [id, await hashPassword(temp)]);
  await reload(id);
  return temp;
}

async function setStatus(id, status) {
  if (!STATUSES.includes(status) || status === 'pending') return null;
  await pool.query(`UPDATE agents SET status = $2, approved_at = CASE WHEN $2 = 'active' THEN COALESCE(approved_at, NOW()) ELSE approved_at END WHERE id = $1`, [id, status]);
  return reload(id);
}

async function setNote(id, note) {
  await pool.query('UPDATE agents SET admin_note = $2 WHERE id = $1', [id, cleanText(note, 300) || null]);
  return reload(id);
}

/* ------------------------------------------------------------------ sessions */

const COOKIE = 'abrants_agent';
const SESSION_DAYS = 30;
function sessionKey() {
  const secret = process.env.CUSTOMER_SECRET || process.env.ADMIN_SECRET;
  return secret ? crypto.createHmac('sha256', secret).update('abrants-agent-session-v1').digest() : null;
}
const fp = (hash) => crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 16);
function sessionToken(a) {
  const key = sessionKey();
  if (!key) throw new Error('Agent sessions are not configured (set CUSTOMER_SECRET).');
  const payload = `${a.id}.${Date.now()}.${fp(a.passwordHash)}`;
  return `${Buffer.from(payload).toString('base64url')}.${crypto.createHmac('sha256', key).update(payload).digest('hex')}`;
}
function cookieFlags() { return `HttpOnly; Path=/; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
function setSession(res, a) { res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sessionToken(a))}; ${cookieFlags()}; Max-Age=${SESSION_DAYS * 86400}`); }
function clearSession(res) { res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags()}; Max-Age=0`); }

/** The signed-in agent (any status but rejected), from memory. */
function agentFromRequest(req) {
  const key = sessionKey();
  const raw = String(req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(COOKIE + '='));
  if (!key || !raw) return null;
  let token; try { token = decodeURIComponent(raw.slice(COOKIE.length + 1)); } catch { return null; }
  const [enc, sig] = token.split('.');
  if (!enc || !/^[a-f0-9]{64}$/.test(sig || '')) return null;
  let payload; try { payload = Buffer.from(enc, 'base64url').toString('utf8'); } catch { return null; }
  const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [id, issued, f] = payload.split('.');
  const age = Date.now() - Number(issued);
  if (!/^\d+$/.test(id) || !(age >= 0 && age < SESSION_DAYS * 86400 * 1000)) return null;
  const a = getAgent(id);
  if (!a || a.status === 'rejected' || fp(a.passwordHash) !== f) return null;
  return a;
}

/* ------------------------------------------------------------------ products and prices */

const keyForPlan = (planId) => 'plan:' + planId;
const keyForChecker = (code) => 'chk:' + String(code).toUpperCase();
const KEY_AFA = 'afa';
const positive = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? round2(v) : null);

/** Everything an agent can sell: data bundles, checkers and AFA, with the store price, cost and agent price. */
async function products() {
  const s = conf(await getSettings());
  const plans = await lazy('orderStore').getPlans();
  let cat = { checkers: [], afa: { available: false } };
  try { cat = await lazy('serviceOrders').catalog(); } catch (e) { /* checkers and AFA not connected */ }
  const out = [];
  for (const p of plans) {
    const key = keyForPlan(p.id);
    out.push({ key, kind: 'data', group: p.network, name: `${p.network} ${p.label}`, label: p.label, network: p.network,
      storePrice: round2(p.priceGHS), cost: p.providerCostGHS == null ? null : round2(p.providerCostGHS),
      agentPrice: positive(s.prices[key]) ?? round2(p.priceGHS), agentPriceSet: positive(s.prices[key]) != null });
  }
  for (const c of cat.checkers || []) {
    if (!c.available) continue;
    const key = keyForChecker(c.code);
    out.push({ key, kind: 'checker', group: 'Result checkers', name: c.name, label: c.name, storePrice: round2(c.price),
      cost: c.cost == null ? null : round2(c.cost), agentPrice: positive(s.prices[key]) ?? round2(c.price), agentPriceSet: positive(s.prices[key]) != null });
  }
  if (cat.afa && cat.afa.available) {
    out.push({ key: KEY_AFA, kind: 'afa', group: 'MTN AFA', name: 'AFA registration', label: 'AFA registration', storePrice: round2(cat.afa.price),
      cost: cat.afa.cost == null ? null : round2(cat.afa.cost), agentPrice: positive(s.prices[KEY_AFA]) ?? round2(cat.afa.price), agentPriceSet: positive(s.prices[KEY_AFA]) != null });
  }
  return out;
}

/** An agent's own price list: their price (or the store price when they have not set one) and what they earn. */
async function agentProducts(agent) {
  const s = await settingsNow();
  const customerPays = (await getSettings()).customerPaysFee !== false;
  return (await products()).map((p) => {
    const mine = positive(agent.prices[p.key]);
    const sell = Math.max(mine ?? p.storePrice, p.agentPrice);
    return { key: p.key, kind: p.kind, group: p.group, name: p.name, label: p.label, network: p.network || null,
      agentPrice: p.agentPrice, storePrice: p.storePrice, myPrice: mine, sellPrice: round2(sell),
      belowAgentPrice: mine != null && mine < p.agentPrice, earn: earning(sell, p.agentPrice, 1, customerPays, s) };
  });
}

function earning(sellUnit, baseUnit, quantity, customerPays) {
  const diff = (Number(sellUnit) - Number(baseUnit)) * (quantity || 1);
  if (!(diff > 0)) return 0;
  return floor2(customerPays ? diff : diff * (1 - feeRate()));
}

// Price of one unit in an agent's shop, and what the agent gets for it.
function quote(agent, key, storeUnit, quantity, settings) {
  const s = conf(settings);
  const base = positive(s.prices[key]) ?? round2(storeUnit);
  const mine = positive(agent.prices[key]);
  const sell = round2(Math.max(mine ?? round2(storeUnit), base));
  const q = quantity || 1;
  const customerPays = settings.customerPaysFee !== false;
  return { unitGHS: sell, priceGHS: round2(sell * q), agentBaseGHS: round2(base * q), agentEarningGHS: earning(sell, base, q, customerPays) };
}
const quoteData = (agent, plan, settings) => quote(agent, keyForPlan(plan.id), plan.priceGHS, 1, settings);
const quoteChecker = (agent, item, quantity, settings) => quote(agent, keyForChecker(item.code), item.price, quantity, settings);
const quoteAfa = (agent, afa, settings) => quote(agent, KEY_AFA, afa.price, 1, settings);

/** Saves an agent's selling prices. Empty means "the store price". Never below the agent price; no upper limit. */
async function setAgentPrices(id, input) {
  const a = getAgent(id);
  if (!a) return { error: 'Not found.', status: 404 };
  const list = await products();
  const known = new Map(list.map((p) => [p.key, p]));
  const next = { ...a.prices };
  for (const [key, raw] of Object.entries(input || {})) {
    const p = known.get(key);
    if (!p) continue;
    if (raw === '' || raw == null) { delete next[key]; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0 || v > MAX_PRICE) return { error: `Check your price for ${p.name}.`, key };
    if (round2(v) < p.agentPrice) return { error: `${p.name}: your price cannot be lower than your agent price, GH₵${p.agentPrice.toFixed(2)}.`, key };
    next[key] = round2(v);
  }
  // Prices for products that are no longer sold are dropped.
  for (const key of Object.keys(next)) if (!known.has(key)) delete next[key];
  await pool.query('UPDATE agents SET prices = $2::jsonb WHERE id = $1', [id, JSON.stringify(next)]);
  return { agent: await reload(id) };
}

/** Admin: agent prices for each product. Empty means agents pay the store price (and earn only what they add). */
async function setBasePrices(input) {
  const list = await products();
  const known = new Map(list.map((p) => [p.key, p]));
  const s = await settingsNow();
  const next = { ...s.prices };
  for (const [key, raw] of Object.entries(input || {})) {
    const p = known.get(key);
    if (!p) continue;
    if (raw === '' || raw == null) { delete next[key]; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0 || v > MAX_PRICE) return { error: `Check the agent price for ${p.name}.`, key };
    next[key] = round2(v);
  }
  for (const key of Object.keys(next)) if (!known.has(key)) delete next[key];
  const all = (await getSettings()).agents || {};
  await saveSettings({ agents: { ...DEFAULTS, ...all, prices: next } });
  return { prices: next };
}

async function saveProgramme(input) {
  const b = input || {};
  const cur = await settingsNow();
  const next = { ...cur };
  const num = (v, lo, hi, label) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error(`${label} must be between ${lo} and ${hi}.`), { user: true });
    return round2(n);
  };
  try {
    if (b.enabled !== undefined) next.enabled = b.enabled === true;
    if (b.autoApprove !== undefined) next.autoApprove = b.autoApprove === true;
    if (b.holdHours !== undefined) next.holdHours = Math.round(num(b.holdHours, 0, 720, 'Hold time'));
    if (b.minPayout !== undefined) next.minPayout = num(b.minPayout, 1, 10000, 'Minimum payout');
    if (b.payoutFee !== undefined) next.payoutFee = num(b.payoutFee, 0, 50, 'Payout fee');
    if (b.payoutMethod !== undefined) {
      if (!['manual', 'paystack'].includes(b.payoutMethod)) throw Object.assign(new Error('Choose how agents are paid.'), { user: true });
      next.payoutMethod = b.payoutMethod;
    }
    if (b.autoPayout !== undefined) next.autoPayout = b.autoPayout === true;
    if (b.payoutDay !== undefined) next.payoutDay = Math.round(num(b.payoutDay, 0, 6, 'Payout day'));
  } catch (err) { if (err.user) return { error: err.message }; throw err; }
  if (next.payoutMethod !== 'paystack') next.autoPayout = false;
  if (next.minPayout <= next.payoutFee) return { error: 'The minimum payout must be more than the payout fee.' };
  const all = (await getSettings()).agents || {};
  await saveSettings({ agents: { ...DEFAULTS, ...all, ...next } });
  return { settings: await settingsNow() };
}

/* ------------------------------------------------------------------ earnings */

/**
 * Keeps one order's earnings in step with the order. Called whenever an agent's order changes status.
 * Delivered -> the earning is the agent's (after the hold). Failed or refunded -> no earning; if it was already
 * in a payout, an equal negative amount comes off the next one.
 */
async function syncOrder(kind, row) {
  const agentId = row.agent_id == null ? null : Number(row.agent_id);
  const amount = Number(row.agent_earning_ghs);
  if (!agentId || !(amount > 0)) return;
  const ref = row.reference;
  const done = kind === 'data' ? DATA_DONE.includes(row.status) : svcDone(row);
  const bad = kind === 'data' ? DATA_BAD.includes(row.status) : SVC_BAD.includes(row.status);
  if (done) {
    const hold = Number((await settingsNow()).holdHours) || 0;
    await pool.query(
      `INSERT INTO agent_earnings (agent_id, order_kind, order_ref, entry, amount_ghs, status, available_at)
       VALUES ($1,$2,$3,'sale',$4,'available', NOW() + make_interval(hours => $5::int))
       ON CONFLICT (order_kind, order_ref, entry) DO UPDATE SET status = 'available', available_at = EXCLUDED.available_at
         WHERE agent_earnings.status = 'cancelled' AND agent_earnings.payout_id IS NULL`,
      [agentId, kind, ref, amount, hold]
    );
    // Delivered after all (for example after a retry): a claw-back that was not paid out yet no longer applies.
    await pool.query(`UPDATE agent_earnings SET status = 'cancelled' WHERE order_kind = $1 AND order_ref = $2 AND entry = 'clawback'
      AND status = 'available' AND payout_id IS NULL`, [kind, ref]);
  } else if (bad) {
    await pool.query(`UPDATE agent_earnings SET status = 'cancelled' WHERE order_kind = $1 AND order_ref = $2 AND entry = 'sale'
      AND status = 'available' AND payout_id IS NULL`, [kind, ref]);
    await pool.query(
      `INSERT INTO agent_earnings (agent_id, order_kind, order_ref, entry, amount_ghs, status, available_at)
       SELECT agent_id, order_kind, order_ref, 'clawback', -amount_ghs, 'available', NOW() FROM agent_earnings
        WHERE order_kind = $1 AND order_ref = $2 AND entry = 'sale' AND status = 'available' AND payout_id IS NOT NULL
       ON CONFLICT (order_kind, order_ref, entry) DO UPDATE SET status = 'available'
         WHERE agent_earnings.status = 'cancelled' AND agent_earnings.payout_id IS NULL`,
      [kind, ref]
    );
  }
}

/** Repairs earnings from the orders themselves (in case a status change was missed). Run before any money decision. */
async function reconcile(agentId = null) {
  const hold = Number((await settingsNow()).holdHours) || 0;
  const only = agentId == null ? null : Number(agentId);
  await pool.query(`
    INSERT INTO agent_earnings (agent_id, order_kind, order_ref, entry, amount_ghs, status, available_at)
    SELECT agent_id, 'data', reference, 'sale', agent_earning_ghs, 'available', updated_at + make_interval(hours => $1::int)
      FROM orders WHERE agent_id IS NOT NULL AND agent_earning_ghs > 0 AND status = ANY($3) AND ($2::bigint IS NULL OR agent_id = $2)
    ON CONFLICT DO NOTHING`, [hold, only, DATA_DONE]);
  await pool.query(`
    INSERT INTO agent_earnings (agent_id, order_kind, order_ref, entry, amount_ghs, status, available_at)
    SELECT agent_id, 'service', reference, 'sale', agent_earning_ghs, 'available', updated_at + make_interval(hours => $1::int)
      FROM service_orders WHERE agent_id IS NOT NULL AND agent_earning_ghs > 0
       AND ((kind = 'checker' AND status = 'completed') OR (kind = 'afa' AND status = 'approved')) AND ($2::bigint IS NULL OR agent_id = $2)
    ON CONFLICT DO NOTHING`, [hold, only]);
  const badJoin = `((e.order_kind = 'data' AND e.order_ref IN (SELECT reference FROM orders WHERE status = ANY($2)))
      OR (e.order_kind = 'service' AND e.order_ref IN (SELECT reference FROM service_orders WHERE status = ANY($3))))`;
  await pool.query(`UPDATE agent_earnings e SET status = 'cancelled' WHERE e.entry = 'sale' AND e.status = 'available' AND e.payout_id IS NULL
    AND ($1::bigint IS NULL OR e.agent_id = $1) AND ${badJoin}`, [only, DATA_BAD, SVC_BAD]);
  await pool.query(`
    INSERT INTO agent_earnings (agent_id, order_kind, order_ref, entry, amount_ghs, status, available_at)
    SELECT e.agent_id, e.order_kind, e.order_ref, 'clawback', -e.amount_ghs, 'available', NOW() FROM agent_earnings e
     WHERE e.entry = 'sale' AND e.status = 'available' AND e.payout_id IS NOT NULL AND ($1::bigint IS NULL OR e.agent_id = $1) AND ${badJoin}
    ON CONFLICT DO NOTHING`, [only, DATA_BAD, SVC_BAD]);
}

/** Money per agent: ready to pay, on hold, on the way (orders not delivered yet), being paid, paid out. */
async function balances(agentIds = null) {
  const ids = agentIds == null ? null : agentIds.map(Number);
  const out = new Map();
  const blank = () => ({ readyGHS: 0, heldGHS: 0, onTheWayGHS: 0, sendingGHS: 0, paidGHS: 0, earnedGHS: 0, sales: 0, nextReleaseAt: null });
  const at = (id) => { const k = Number(id); if (!out.has(k)) out.set(k, blank()); return out.get(k); };
  const e = await pool.query(`
    SELECT agent_id,
      COALESCE(SUM(amount_ghs) FILTER (WHERE status = 'available' AND payout_id IS NULL AND available_at <= NOW()), 0) AS ready,
      COALESCE(SUM(amount_ghs) FILTER (WHERE status = 'available' AND payout_id IS NULL AND available_at > NOW()), 0) AS held,
      COALESCE(SUM(amount_ghs) FILTER (WHERE status = 'available'), 0) AS earned,
      COUNT(*) FILTER (WHERE status = 'available' AND entry = 'sale')::int AS sales,
      MIN(available_at) FILTER (WHERE status = 'available' AND payout_id IS NULL AND available_at > NOW()) AS next_release
    FROM agent_earnings WHERE ($1::bigint[] IS NULL OR agent_id = ANY($1)) GROUP BY agent_id`, [ids]);
  for (const r of e.rows) Object.assign(at(r.agent_id), { readyGHS: round2(r.ready), heldGHS: round2(r.held), earnedGHS: round2(r.earned), sales: r.sales, nextReleaseAt: r.next_release });
  const w = await pool.query(`
    SELECT agent_id, SUM(agent_earning_ghs) AS amt FROM (
      SELECT agent_id, agent_earning_ghs FROM orders WHERE agent_id IS NOT NULL AND status = ANY($2)
      UNION ALL SELECT agent_id, agent_earning_ghs FROM service_orders WHERE agent_id IS NOT NULL AND status = ANY($3)
    ) x WHERE ($1::bigint[] IS NULL OR agent_id = ANY($1)) GROUP BY agent_id`, [ids, DATA_OPEN, SVC_OPEN]);
  for (const r of w.rows) at(r.agent_id).onTheWayGHS = round2(r.amt);
  const p = await pool.query(`
    SELECT agent_id, COALESCE(SUM(sent_ghs) FILTER (WHERE status = 'paid'), 0) AS paid,
      COALESCE(SUM(sent_ghs) FILTER (WHERE status IN ('sending','otp')), 0) AS sending
    FROM agent_payouts WHERE ($1::bigint[] IS NULL OR agent_id = ANY($1)) GROUP BY agent_id`, [ids]);
  for (const r of p.rows) Object.assign(at(r.agent_id), { paidGHS: round2(r.paid), sendingGHS: round2(r.sending) });
  return out;
}

const maskPhone = (p) => (p && p.length === 10 ? p.slice(0, 3) + '••••' + p.slice(7) : p || '');
function saleState(kind, r) {
  if (kind === 'data') {
    if (DATA_DONE.includes(r.status)) return 'delivered';
    if (DATA_BAD.includes(r.status)) return r.status === 'delivery_failed' ? 'failed' : 'refunded';
    return 'on_the_way';
  }
  if (svcDone(r)) return 'delivered';
  if (r.status === 'rejected') return 'failed';
  if (SVC_BAD.includes(r.status)) return r.status === 'failed' ? 'failed' : 'refunded';
  return 'on_the_way';
}

/** An agent's sales, newest first (data, checkers and AFA together). */
async function sales(agentId, { limit = 30, offset = 0, maskPhones = true } = {}) {
  const r = await pool.query(`
    SELECT * FROM (
      SELECT 'data' AS k, reference, label AS what, phone, price_ghs, agent_earning_ghs, status, NULL AS kind, created_at FROM orders
       WHERE agent_id = $1 AND status <> 'pending'
      UNION ALL
      SELECT 'service', reference, CASE WHEN quantity > 1 THEN quantity || ' × ' || item_name ELSE item_name END, phone, price_ghs,
        agent_earning_ghs, status, kind, created_at FROM service_orders WHERE agent_id = $1 AND status <> 'pending'
    ) x ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [agentId, Math.min(Number(limit) || 30, 200), Math.max(Number(offset) || 0, 0)]);
  return r.rows.map((x) => ({
    reference: x.reference, what: x.what, phone: maskPhones ? maskPhone(x.phone) : x.phone, priceGHS: round2(x.price_ghs),
    earningGHS: round2(x.agent_earning_ghs || 0), state: saleState(x.k, x), status: x.status, createdAt: x.created_at,
  }));
}

function mapPayout(r) {
  return {
    id: Number(r.id), agentId: Number(r.agent_id), amountGHS: round2(r.amount_ghs), feeGHS: round2(r.fee_ghs), sentGHS: round2(r.sent_ghs),
    method: r.method, status: r.status, reference: r.reference, transferCode: r.transfer_code || null,
    momoNumber: r.momo_number, momoNetwork: r.momo_network, momoName: r.momo_name, note: r.note || '', trigger: r.trigger || null,
    createdAt: r.created_at, updatedAt: r.updated_at, paidAt: r.paid_at,
  };
}
async function payouts({ agentId = null, limit = 30 } = {}) {
  const r = await pool.query(`SELECT * FROM agent_payouts WHERE ($1::bigint IS NULL OR agent_id = $1) ORDER BY created_at DESC LIMIT $2`,
    [agentId == null ? null : Number(agentId), Math.min(Number(limit) || 30, 200)]);
  return r.rows.map(mapPayout);
}
async function getPayout(id) {
  const r = await pool.query('SELECT * FROM agent_payouts WHERE id = $1', [Number(id)]);
  return r.rows[0] ? mapPayout(r.rows[0]) : null;
}

/* ------------------------------------------------------------------ payouts */

async function release(payoutId) {
  await pool.query('UPDATE agent_earnings SET payout_id = NULL WHERE payout_id = $1', [payoutId]);
}

async function setPayout(id, changes, fromStatuses) {
  const cols = { status: 'status', note: 'note', transferCode: 'transfer_code', reference: 'reference' };
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(changes)) { if (cols[k]) { vals.push(v); sets.push(`${cols[k]} = $${vals.length}`); } }
  if (changes.status === 'paid') sets.push('paid_at = COALESCE(paid_at, NOW())');
  sets.push('updated_at = NOW()');
  vals.push(Number(id)); vals.push(fromStatuses);
  const r = await pool.query(`UPDATE agent_payouts SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND status = ANY($${vals.length}) RETURNING *`, vals);
  if (!r.rows[0]) return null;
  if (changes.status === 'failed') await release(Number(id));
  return mapPayout(r.rows[0]);
}

async function alert(level, text) { try { await lazy('fulfillment').addAlert(level, text); } catch (e) { /* alerts are best effort */ } }

/**
 * Puts everything an agent can be paid into one payout. method 'manual' = the admin has paid it by hand (it is
 * recorded as paid); 'paystack' = sent to their MoMo now through Paystack Transfers.
 */
async function createPayout(agentId, { method, note = '', trigger = 'admin', ignoreMinimum = false } = {}) {
  const a = getAgent(agentId);
  if (!a) return { error: 'Agent not found.', status: 404 };
  if (!['manual', 'paystack'].includes(method)) return { error: 'Choose how to pay.' };
  if (method === 'paystack' && !process.env.PAYSTACK_SECRET_KEY) return { error: 'Paystack is not set up.' };
  const s = await settingsNow();
  await reconcile(a.id);
  const client = await pool.connect();
  let payout;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM agents WHERE id = $1 FOR UPDATE', [a.id]); // one payout at a time per agent
    const due = await client.query(`SELECT id, amount_ghs FROM agent_earnings WHERE agent_id = $1 AND status = 'available'
      AND payout_id IS NULL AND available_at <= NOW()`, [a.id]);
    const amount = round2(due.rows.reduce((t, r) => t + Number(r.amount_ghs), 0));
    const fee = round2(s.payoutFee || 0);
    const sent = round2(amount - fee);
    if (!(sent > 0)) { await client.query('ROLLBACK'); return { error: amount > 0 ? `GH₵${amount.toFixed(2)} is not more than the GH₵${fee.toFixed(2)} payout fee.` : 'Nothing to pay yet.', status: 409 }; }
    if (!ignoreMinimum && amount < s.minPayout) { await client.query('ROLLBACK'); return { error: `Below the GH₵${Number(s.minPayout).toFixed(2)} minimum.`, status: 409 }; }
    const reference = `abrants-payout-${a.id}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const ins = await client.query(`INSERT INTO agent_payouts (agent_id, amount_ghs, fee_ghs, sent_ghs, method, status, reference,
        momo_number, momo_network, momo_name, note, trigger)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [a.id, amount, fee, sent, method, method === 'manual' ? 'paid' : 'sending', reference, a.momoNumber, a.momoNetwork, a.momoName,
        cleanText(note, 200) || null, trigger]);
    payout = mapPayout(ins.rows[0]);
    await client.query('UPDATE agent_earnings SET payout_id = $1 WHERE id = ANY($2)', [payout.id, due.rows.map((r) => r.id)]);
    if (method === 'manual') await client.query('UPDATE agent_payouts SET paid_at = NOW() WHERE id = $1', [payout.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  if (method === 'manual') return { payout: await getPayout(payout.id) };
  return { payout: await sendTransfer(payout, a) };
}

const TRANSFER_STATE = { success: 'paid', pending: 'sending', received: 'sending', processing: 'sending', otp: 'otp',
  failed: 'failed', abandoned: 'failed', blocked: 'failed', rejected: 'failed', reversed: 'failed' };

async function recipientFor(a) {
  const forKey = `${a.momoNumber}|${a.momoNetwork}|${a.momoName}`;
  if (a.recipientCode && a.recipientFor === forKey) return a.recipientCode;
  const ps = lazy('paystack');
  const r = await ps.createTransferRecipient({ name: a.momoName, accountNumber: a.momoNumber, bankCode: MOMO_BANK[a.momoNetwork] });
  if (!r || !r.recipient_code) throw new Error('Paystack did not return a recipient.');
  await pool.query('UPDATE agents SET recipient_code = $2, recipient_for = $3 WHERE id = $1', [a.id, r.recipient_code, forKey]);
  await reload(a.id);
  return r.recipient_code;
}

async function sendTransfer(payout, a) {
  const ps = lazy('paystack');
  let recipient;
  try { recipient = await recipientFor(a); }
  catch (err) {
    const why = String(err.response?.data?.message || err.message).slice(0, 160);
    await alert('danger', `Payout to agent ${a.shopName} failed: Paystack did not accept their MoMo details (${why}). Ask them to check the MoMo number and name.`);
    return setPayout(payout.id, { status: 'failed', note: `MoMo details not accepted: ${why}` }, ['sending']);
  }
  try {
    const t = await ps.initiateTransfer({ amountGHS: payout.sentGHS, recipient, reference: payout.reference, reason: `Abrants agent earnings #${payout.id}` });
    const state = TRANSFER_STATE[String(t && t.status || '').toLowerCase()] || 'sending';
    const changes = { status: state, transferCode: t && t.transfer_code ? String(t.transfer_code) : null };
    if (state === 'otp') changes.note = 'Enter the code Paystack sent you to release this payout.';
    if (state === 'failed') changes.note = String(t.reason || t.message || 'Paystack did not send it.').slice(0, 200);
    return (await setPayout(payout.id, changes, ['sending'])) || getPayout(payout.id);
  } catch (err) {
    if (err.response && err.response.status >= 400 && err.response.status < 500) {
      // A definite no from Paystack (for example "balance is not enough" or transfers not allowed): nothing was sent.
      const why = String(err.response.data?.message || 'Paystack refused the transfer').slice(0, 200);
      await alert('danger', `Agent payout not sent: ${why}`);
      return setPayout(payout.id, { status: 'failed', note: why }, ['sending']);
    }
    // No clear answer: the transfer may or may not exist. Never retry blindly; "Check" asks Paystack.
    return setPayout(payout.id, { note: 'No clear answer from Paystack. Press Check.' }, ['sending']);
  }
}

async function submitOtp(id, otp) {
  const p = await getPayout(id);
  if (!p || p.status !== 'otp' || !p.transferCode) return { error: 'This payout is not waiting for a code.', status: 409 };
  const code = String(otp || '').replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(code)) return { error: 'Enter the code Paystack sent you.' };
  try {
    const t = await lazy('paystack').finalizeTransfer(p.transferCode, code);
    const state = TRANSFER_STATE[String(t && t.status || '').toLowerCase()] || 'sending';
    return { payout: (await setPayout(p.id, { status: state === 'otp' ? 'otp' : state, note: state === 'failed' ? 'Paystack did not send it.' : '' }, ['otp'])) || await getPayout(p.id) };
  } catch (err) {
    return { error: String(err.response?.data?.message || 'Paystack did not accept the code.').slice(0, 200), status: 400 };
  }
}

/** Asks Paystack what happened to a payout that has no final answer yet. */
async function checkPayout(id) {
  const p = await getPayout(id);
  if (!p || p.method !== 'paystack' || !['sending', 'otp'].includes(p.status)) return { payout: p };
  try {
    const t = await lazy('paystack').verifyTransfer(p.reference);
    const state = TRANSFER_STATE[String(t && t.status || '').toLowerCase()];
    if (!state || state === p.status) return { payout: p };
    return { payout: (await setPayout(p.id, { status: state, transferCode: t.transfer_code || p.transferCode, note: state === 'failed' ? String(t.reason || 'Paystack did not send it.').slice(0, 200) : '' }, ['sending', 'otp'])) || p };
  } catch (err) {
    if (err.response && err.response.status === 404) return { payout: await setPayout(p.id, { status: 'failed', note: 'Paystack has no such transfer: nothing was sent.' }, ['sending', 'otp']) };
    return { error: 'Could not reach Paystack. Try again in a minute.', status: 502 };
  }
}

/** Admin settles a payout by hand: 'paid' (it did arrive) or 'failed' (it did not; the money goes back to the agent's balance). */
async function markPayout(id, status, note) {
  if (!['paid', 'failed'].includes(status)) return { error: 'Choose paid or failed.' };
  const p = await setPayout(id, { status, note: cleanText(note, 200) || (status === 'paid' ? 'Marked paid in Admin' : 'Marked failed in Admin') }, ['sending', 'otp']);
  return p ? { payout: p } : { error: 'Only a payout that is still being sent can be changed.', status: 409 };
}

/** Paystack's transfer.success / transfer.failed / transfer.reversed. */
async function transferEvent(event) {
  const d = (event && event.data) || {};
  const ref = String(d.reference || '');
  if (!ref.startsWith('abrants-payout-')) return false;
  const r = await pool.query('SELECT * FROM agent_payouts WHERE reference = $1', [ref]);
  const p = r.rows[0] ? mapPayout(r.rows[0]) : null;
  if (!p) return true;
  if (event.event === 'transfer.success') await setPayout(p.id, { status: 'paid', note: '' }, ['sending', 'otp']);
  else if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
    const done = await setPayout(p.id, { status: 'failed', note: event.event === 'transfer.reversed' ? 'Reversed by the MoMo network: the money is back in the agent\'s balance.' : 'Paystack could not send it: the money is back in the agent\'s balance.' }, ['sending', 'otp', 'paid']);
    if (done) {
      const a = getAgent(p.agentId);
      await alert('danger', `Payout of GH₵${p.sentGHS.toFixed(2)} to agent ${a ? a.shopName : p.agentId} ${event.event === 'transfer.reversed' ? 'was reversed' : 'failed'}. It is back in their balance.`);
    }
  }
  return true;
}

/** Pays every active agent who is due at least the minimum. A MoMo number changed in the last 24 hours waits. */
async function payAllDue({ trigger = 'admin', method } = {}) {
  const s = await settingsNow();
  const how = method || s.payoutMethod;
  await reconcile(null);
  const bal = await balances(null);
  const results = [];
  for (const [id, b] of bal) {
    const a = getAgent(id);
    if (!a || a.status !== 'active' || b.readyGHS < s.minPayout || b.readyGHS <= s.payoutFee) continue;
    if (a.momoChangedAt && Date.now() - new Date(a.momoChangedAt).getTime() < 24 * 3600 * 1000) {
      results.push({ agentId: a.id, shopName: a.shopName, skipped: 'MoMo number changed in the last 24 hours' });
      continue;
    }
    try {
      const out = await createPayout(a.id, { method: how, trigger });
      results.push({ agentId: a.id, shopName: a.shopName, ...(out.error ? { skipped: out.error } : { payout: out.payout }) });
    } catch (err) {
      results.push({ agentId: a.id, shopName: a.shopName, skipped: 'Error: ' + err.message });
    }
  }
  return results;
}

/** Runs every hour; pays agents on the chosen weekday (from 10:00 Ghana time) when automatic payouts are on. */
async function autoPayoutTick() {
  const s = await settingsNow();
  if (!s.enabled || !s.autoPayout || s.payoutMethod !== 'paystack' || !process.env.PAYSTACK_SECRET_KEY) return null;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = Number(process.env.AGENT_PAYOUT_HOUR ?? 10); // GMT (Ghana time)
  if (now.getUTCDay() !== Number(s.payoutDay) || now.getUTCHours() < hour || s.lastAutoPayout === today) return null;
  const all = (await getSettings({ fresh: true })).agents || {};
  if (all.lastAutoPayout === today) return null;
  await saveSettings({ agents: { ...DEFAULTS, ...all, lastAutoPayout: today } }); // first, so a crash never pays twice
  const results = await payAllDue({ trigger: 'auto', method: 'paystack' });
  const paid = results.filter((r) => r.payout && r.payout.status !== 'failed');
  if (results.length) await alert(paid.length === results.length ? 'info' : 'warn', `Weekly agent payouts: ${paid.length} of ${results.length} agent(s) sent. See Admin → Agents.`);
  return results;
}

/* ------------------------------------------------------------------ views */

function publicAgent(a) {
  return { id: a.id, name: a.name, shopName: a.shopName, slug: a.slug, phone: a.phone, status: a.status, whatsapp: a.whatsapp,
    momoNumber: a.momoNumber, momoNetwork: a.momoNetwork, momoName: a.momoName, createdAt: a.createdAt, approvedAt: a.approvedAt,
    mustChangePassword: a.mustChangePassword };
}
function adminAgent(a, b) {
  return { ...publicAgent(a), adminNote: a.adminNote, lastLoginAt: a.lastLoginAt, momoChangedAt: a.momoChangedAt,
    pricesSet: Object.keys(a.prices).length, ...(b || {}) };
}

async function overview() {
  await reconcile(null);
  const s = await settingsNow();
  const bal = await balances(null);
  const agents = [...byId.values()].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))
    .map((a) => adminAgent(a, bal.get(a.id) || { readyGHS: 0, heldGHS: 0, onTheWayGHS: 0, sendingGHS: 0, paidGHS: 0, earnedGHS: 0, sales: 0 }));
  const month = await pool.query(`
    SELECT COUNT(*)::int AS orders, COALESCE(SUM(price_ghs), 0) AS sales, COALESCE(SUM(agent_earning_ghs), 0) AS earned FROM (
      SELECT price_ghs, agent_earning_ghs FROM orders WHERE agent_id IS NOT NULL AND status = ANY($1) AND created_at >= date_trunc('month', NOW())
      UNION ALL SELECT price_ghs, agent_earning_ghs FROM service_orders WHERE agent_id IS NOT NULL
        AND ((kind = 'checker' AND status = 'completed') OR (kind = 'afa' AND status IN ('approved','submitted'))) AND created_at >= date_trunc('month', NOW())
    ) x`, [[...DATA_DONE, ...DATA_OPEN]]);
  const m = month.rows[0];
  const totals = agents.reduce((t, a) => ({ ready: t.ready + a.readyGHS, held: t.held + a.heldGHS, onTheWay: t.onTheWay + a.onTheWayGHS }), { ready: 0, held: 0, onTheWay: 0 });
  return {
    settings: s,
    counts: { active: agents.filter((a) => a.status === 'active').length, pending: agents.filter((a) => a.status === 'pending').length, all: agents.length },
    month: { orders: m.orders, salesGHS: round2(m.sales), agentEarningsGHS: round2(m.earned) },
    owed: { readyGHS: round2(totals.ready), heldGHS: round2(totals.held), onTheWayGHS: round2(totals.onTheWay) },
    agents, payouts: await payouts({ limit: 40 }), products: await products(),
    paystackReady: Boolean(process.env.PAYSTACK_SECRET_KEY), feeRate: feeRate(), customerPaysFee: (await getSettings()).customerPaysFee !== false,
  };
}

async function agentDetail(id) {
  const a = getAgent(id);
  if (!a) return null;
  await reconcile(a.id);
  const b = (await balances([a.id])).get(a.id);
  return { agent: adminAgent(a, b), sales: await sales(a.id, { limit: 50, maskPhones: false }), payouts: await payouts({ agentId: a.id, limit: 30 }) };
}

async function dashboard(a) {
  await reconcile(a.id);
  const s = await settingsNow();
  const b = (await balances([a.id])).get(a.id) || { readyGHS: 0, heldGHS: 0, onTheWayGHS: 0, sendingGHS: 0, paidGHS: 0, earnedGHS: 0, sales: 0 };
  return {
    agent: publicAgent(a),
    programme: { open: s.enabled, minPayoutGHS: s.minPayout, payoutFeeGHS: s.payoutFee, holdHours: s.holdHours,
      payoutDay: s.autoPayout && s.payoutMethod === 'paystack' ? s.payoutDay : null,
      // What share of the amount added on top of the agent price reaches the agent (Paystack's cut when the store pays it).
      marginFactor: (await getSettings()).customerPaysFee !== false ? 1 : 1 - feeRate() },
    balances: b,
    products: await agentProducts(a),
    sales: await sales(a.id, { limit: 30 }),
    payouts: (await payouts({ agentId: a.id, limit: 20 })).map((p) => ({ id: p.id, sentGHS: p.sentGHS, feeGHS: p.feeGHS, amountGHS: p.amountGHS,
      status: p.status, method: p.method, momoNumber: maskPhone(p.momoNumber), createdAt: p.createdAt, paidAt: p.paidAt })),
  };
}

module.exports = {
  initAgentDb, loadAgents, getAgent, shopAgent, register, login, updateProfile, updateMomo, changePassword, resetPassword,
  setStatus, setNote, setSession, clearSession, agentFromRequest, products, agentProducts, setAgentPrices, setBasePrices,
  saveProgramme, settingsNow, quoteData, quoteChecker, quoteAfa, earning, syncOrder, reconcile, balances, sales, payouts,
  getPayout, createPayout, submitOtp, checkPayout, markPayout, transferEvent, payAllDue, autoPayoutTick, overview,
  agentDetail, dashboard, publicAgent, NETWORKS, MOMO_BANK, KEY_AFA, keyForPlan, keyForChecker, conf,
};
