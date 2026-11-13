/*
 * Chat with the store (the "Chat with us" button on the website; Admin → Inbox). Website only, no SMS.
 *
 * Who is writing:
 *   - an agent who is logged in: their shop (name, phone, status)
 *   - a customer who is logged in: their name, phone and email
 *   - anyone else: a visitor with a chat ID such as "K7M2QD". The chat is tied to this browser by a cookie that
 *     lasts a year, so closing the browser and coming back shows the same chat.
 *   A visitor who later logs in keeps their chat: it becomes the customer's (or the agent's).
 *
 * Who answers: Abrants (Admin → Inbox), or, for a customer writing from inside an agent's shop, that agent (agent page →
 * Inbox → Customers). A shop's chats are the shop's: the admin's inbox does not list them. Each browser has one chat
 * with Abrants and one with each shop it wrote to (a cookie per shop). An agent on their own shop page talks to Abrants.
 *
 * Neon (README 19): every thread is kept in memory with its unread counts, and its messages once someone opens it.
 * The "anything new?" checks the pages make every few seconds are answered from memory: no database query. The
 * database is used when a message is sent, when a chat is opened for the first time since the server started, and
 * when someone reads new messages. Old chats are deleted after a while (Admin → Inbox, 30 days by default).
 */
const crypto = require('crypto');
const { pool, getSettings, saveSettings, normalizePhone, PHONE_RE } = require('./orderStore');

const MAX_TEXT = 1000;
const KEEP = [7, 30, 90];
const DEFAULTS = { enabled: true, keepDays: 30 };
const lazy = (name) => require('./' + name);

async function chatSettings() {
  const s = (await getSettings()).chat || {};
  return { ...DEFAULTS, ...s, keepDays: KEEP.includes(Number(s.keepDays)) ? Number(s.keepDays) : DEFAULTS.keepDays };
}
async function saveChatSettings(b) {
  const cur = await chatSettings();
  const next = { ...cur };
  if (b.enabled !== undefined) next.enabled = b.enabled === true;
  if (b.keepDays !== undefined) {
    if (!KEEP.includes(Number(b.keepDays))) return { error: 'Choose 7, 30 or 90 days.' };
    next.keepDays = Number(b.keepDays);
  }
  await saveSettings({ chat: next });
  return { settings: next, before: cur };
}

/* ------------------------------------------------------------------ schema and memory */

async function initChatDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      agent_id BIGINT,
      customer_id BIGINT,
      name TEXT,
      phone TEXT,
      email TEXT,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'open',
      last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_text TEXT,
      last_from_admin BOOLEAN NOT NULL DEFAULT false,
      admin_unread INT NOT NULL DEFAULT 0,
      user_unread INT NOT NULL DEFAULT 0,
      admin_read_id BIGINT NOT NULL DEFAULT 0,
      user_read_id BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_threads_last ON chat_threads (last_at DESC);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      thread_id BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      from_admin BOOLEAN NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id, id);
    -- The agent whose shop the chat is with (NULL = Abrants). from_admin means "from the side that answers".
    ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS shop_id BIGINT;
    CREATE INDEX IF NOT EXISTS idx_chat_threads_shop ON chat_threads (shop_id);
  `);
  await loadThreads();
}

const threads = new Map(); // id -> thread
const byCode = new Map();
const byAgent = new Map(); // an agent's own chat with Abrants
const byCustomer = new Map(); // "<owner>:<customer id>" -> thread (owner 0 = Abrants)
let adminSeenAt = 0; // when the admin last looked at the inbox (for "online now")
const shopSeenAt = new Map(); // agent id -> when they last looked at their customers' chats
const ownerOf = (t) => t.shopId || 0;

function mapThread(r) {
  return {
    id: Number(r.id), code: r.code, agentId: r.agent_id == null ? null : Number(r.agent_id), customerId: r.customer_id == null ? null : Number(r.customer_id),
    name: r.name || '', phone: r.phone || '', email: r.email || '', context: r.context || {}, status: r.status,
    lastAt: r.last_at, lastText: r.last_text || '', lastFromAdmin: Boolean(r.last_from_admin),
    adminUnread: Number(r.admin_unread) || 0, userUnread: Number(r.user_unread) || 0,
    adminReadId: Number(r.admin_read_id) || 0, userReadId: Number(r.user_read_id) || 0,
    lastMsgId: Number(r.last_msg_id) || 0, createdAt: r.created_at, msgs: null, shopId: r.shop_id == null ? null : Number(r.shop_id),
  };
}
function index(t) {
  threads.set(t.id, t); byCode.set(t.code, t.id);
  if (t.agentId && !t.shopId) byAgent.set(t.agentId, t.id);
  if (t.customerId) byCustomer.set(ownerOf(t) + ':' + t.customerId, t.id);
  return t;
}
function unindex(t) {
  threads.delete(t.id); byCode.delete(t.code);
  if (t.agentId && byAgent.get(t.agentId) === t.id) byAgent.delete(t.agentId);
  const ck = ownerOf(t) + ':' + t.customerId;
  if (t.customerId && byCustomer.get(ck) === t.id) byCustomer.delete(ck);
}
async function loadThreads() {
  const r = await pool.query(`SELECT t.*, (SELECT MAX(id) FROM chat_messages m WHERE m.thread_id = t.id) AS last_msg_id FROM chat_threads t`);
  threads.clear(); byCode.clear(); byAgent.clear(); byCustomer.clear();
  for (const row of r.rows) index(mapThread(row));
}

const mapMessage = (r) => ({ id: Number(r.id), fromAdmin: Boolean(r.from_admin), text: r.body, at: r.created_at });
/** The thread's messages (the last 200), read from the database once and then kept. */
async function messagesOf(t) {
  if (!t.msgs) {
    const r = await pool.query('SELECT * FROM (SELECT * FROM chat_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT 200) x ORDER BY id', [t.id]);
    t.msgs = r.rows.map(mapMessage);
  }
  return t.msgs;
}
/** Messages after id `after`, without the database when nothing is new. */
async function newSince(t, after) {
  const a = Number(after) || 0;
  if (a >= t.lastMsgId && !t.msgs) return [];
  return (await messagesOf(t)).filter((m) => m.id > a);
}

/* ------------------------------------------------------------------ who is writing */

const COOKIE = 'abrants_chat'; // the chat with Abrants; abrants_chat_<agent id> for a chat with that agent's shop
const cookieName = (owner) => (owner ? `${COOKIE}_${owner}` : COOKIE);
function key() {
  const secret = process.env.CUSTOMER_SECRET || process.env.ADMIN_SECRET;
  return secret ? crypto.createHmac('sha256', secret).update('abrants-chat-v1').digest() : null;
}
const sign = (code) => `${code}.${crypto.createHmac('sha256', key()).update(code).digest('hex').slice(0, 32)}`;
function threadFromCookie(req, owner = 0) {
  if (!key()) return null;
  const name = cookieName(owner);
  const raw = String(req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '='));
  if (!raw) return null;
  let v; try { v = decodeURIComponent(raw.slice(name.length + 1)); } catch { return null; }
  const [code, sig] = v.split('.');
  if (!/^[A-Z0-9]{6}$/.test(code || '') || !/^[a-f0-9]{32}$/.test(sig || '')) return null;
  const expected = sign(code).split('.')[1];
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const t = threads.get(byCode.get(code));
  return t && ownerOf(t) === owner ? t : null;
}
function setCookie(res, t) {
  res.append('Set-Cookie', `${cookieName(ownerOf(t))}=${encodeURIComponent(sign(t.code))}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${365 * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

// No 0/O or 1/I, so a chat ID read out over the phone is not mistaken.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const b = crypto.randomBytes(6);
    const code = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
    if (!byCode.has(code)) return code;
  }
}

/**
 * Who the chat is with, from the shop the page is in: an open agent shop -> that agent; otherwise (or the agent on
 * their own shop) -> 0, Abrants. From memory. -> { owner, shop }
 */
async function ownerFor(req, slug) {
  const s = String(slug || '').toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(s)) return { owner: 0, shop: null };
  const shop = await lazy('agents').shopAgent(s);
  const me = lazy('agents').agentFromRequest(req);
  if (!shop || (me && me.id === shop.id)) return { owner: 0, shop: null };
  return { owner: shop.id, shop };
}

/**
 * Who is chatting on this request, with Abrants (owner 0) or a shop. light: true = without the database (agents and
 * the chat cookie only), for the frequent checks. -> { kind: 'agent'|'customer'|'visitor', agent?, customer?, thread? }
 */
async function identify(req, { light = false, owner = 0 } = {}) {
  const agent = owner ? null : lazy('agents').agentFromRequest(req); // in someone's shop, an agent is just a customer
  const cookieThread = threadFromCookie(req, owner);
  if (agent) return { kind: 'agent', agent, thread: threads.get(byAgent.get(agent.id)) || adopt(cookieThread) };
  if (!light && /abrants_customer=/.test(req.headers.cookie || '')) {
    let customer = null;
    try { customer = await lazy('customers').customerFromRequest(req); } catch { customer = null; }
    if (customer) return { kind: 'customer', customer, thread: threads.get(byCustomer.get(owner + ':' + customer.id)) || adopt(cookieThread) };
  }
  // Not logged in: the chat this browser already has (whoever started it), or none yet.
  return { kind: cookieThread ? label(cookieThread).kind : 'visitor', thread: cookieThread };
}
// A visitor's chat can become a logged-in person's chat (it is only moved when they next write).
function adopt(t) { return t && !t.agentId && !t.customerId ? t : null; }

function label(t) {
  if (t.agentId) {
    const a = lazy('agents').getAgent(t.agentId);
    return { kind: 'agent', name: a ? a.shopName : t.name || 'Agent', sub: a && a.status !== 'deleted' ? `${a.name}, ${a.phone}` : t.phone };
  }
  if (t.customerId) return { kind: 'customer', name: t.name || 'Customer', sub: [t.phone, t.email].filter(Boolean).join(', ') };
  return { kind: 'visitor', name: t.name || (t.shopId ? `Customer ${t.code}` : `Visitor ${t.code}`), sub: t.phone || '' };
}

/* ------------------------------------------------------------------ writing */

function cleanText(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
}
function cleanContext(c) {
  const x = c && typeof c === 'object' ? c : {};
  const out = {};
  if (typeof x.page === 'string') out.page = x.page.slice(0, 80).replace(/[^\w/.#-]/g, '');
  if (typeof x.shop === 'string' && /^[a-z0-9-]{1,40}$/.test(x.shop)) out.shop = x.shop;
  if (typeof x.lastOrder === 'string' && /^[A-Z]{2,3}-[A-Za-z0-9-]{6,60}$/.test(x.lastOrder)) out.lastOrder = x.lastOrder;
  return out;
}

const sends = new Map(); // thread or ip -> { n, reset }
function allow(k, max, windowMs) {
  const now = Date.now();
  let b = sends.get(k);
  if (!b || now >= b.reset) b = { n: 0, reset: now + windowMs };
  b.n += 1; sends.set(k, b);
  if (sends.size > 5000) for (const [x, y] of sends) if (y.reset <= now) sends.delete(x);
  return b.n <= max;
}

/** Someone on the website writes to the store. Creates their chat with the first message. */
async function userSend(req, res, body) {
  if (!(await chatSettings()).enabled) return { error: 'Chat is closed right now.', status: 403 };
  const text = cleanText(body.text);
  if (!text) return { error: 'Write a message first.' };
  const { owner } = await ownerFor(req, body.shop);
  const who = await identify(req, { owner });
  const ip = req.ip || 'x';
  let t = who.thread;
  if (!t && !allow('new:' + ip, 8, 60 * 60 * 1000)) return { error: 'Too many new chats from here. Please wait a while.', status: 429 };
  if (t && !allow('t:' + t.id, 20, 5 * 60 * 1000)) return { error: 'You are sending messages very fast. Please wait a moment.', status: 429 };
  if (!allow('ip:' + ip, 60, 10 * 60 * 1000)) return { error: 'Please wait a moment before sending more.', status: 429 };

  // What we know about them, kept up to date on the thread.
  const ctx = cleanContext(body.context);
  let name = '', phone = '', email = '', agentId = null, customerId = null;
  if (who.agent) { agentId = who.agent.id; name = who.agent.shopName; phone = who.agent.phone; }
  else if (who.customer) { customerId = who.customer.id; name = who.customer.name || ''; phone = who.customer.phone || ''; email = who.customer.email || ''; }
  else if (t && (t.agentId || t.customerId)) { /* their chat, from this browser: keep what we know */ }
  else {
    const p = normalizePhone(body.phone || '');
    if (body.phone && !PHONE_RE.test(p)) return { error: 'Check the phone number, or leave it empty.', field: 'phone' };
    phone = PHONE_RE.test(p) ? p : (t ? t.phone : '');
    name = t ? t.name : '';
  }

  const client = await pool.connect();
  let msg;
  try {
    await client.query('BEGIN');
    if (!t) {
      const r = await client.query(`INSERT INTO chat_threads (code, agent_id, customer_id, name, phone, email, context, shop_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
        RETURNING *, 0 AS last_msg_id`, [newCode(), agentId, customerId, name || null, phone || null, email || null, JSON.stringify(ctx), owner || null]);
      t = index(mapThread(r.rows[0]));
      t.msgs = [];
    }
    const m = await client.query('INSERT INTO chat_messages (thread_id, from_admin, body) VALUES ($1, false, $2) RETURNING *', [t.id, text]);
    msg = mapMessage(m.rows[0]);
    const context = { ...t.context, ...ctx };
    const u = await client.query(`UPDATE chat_threads SET agent_id = COALESCE($2, agent_id), customer_id = COALESCE($3, customer_id),
        name = COALESCE(NULLIF($4, ''), name), phone = COALESCE(NULLIF($5, ''), phone), email = COALESCE(NULLIF($6, ''), email),
        context = $7::jsonb, status = 'open', last_at = $8, last_text = $9, last_from_admin = false, admin_unread = admin_unread + 1
      WHERE id = $1 RETURNING *`, [t.id, agentId, customerId, name, phone, email, JSON.stringify(context), msg.at, text.slice(0, 200)]);
    await client.query('COMMIT');
    const fresh = mapThread({ ...u.rows[0], last_msg_id: msg.id });
    const msgs = t.msgs;
    unindex(t);
    t = index(Object.assign(fresh, { msgs }));
    if (t.msgs) t.msgs.push(msg);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  setCookie(res, t);
  return { message: msg, thread: userView(t) };
}

/* ------------------------------------------------------------------ the answering side (owner 0 = Abrants, else a shop) */

const threadFor = (owner, id) => { const t = threads.get(Number(id)); return t && ownerOf(t) === owner ? t : null; };
function seenBy(owner) { if (owner) shopSeenAt.set(owner, Date.now()); else adminSeenAt = Date.now(); }
const online = (owner = 0) => Date.now() - (owner ? shopSeenAt.get(owner) || 0 : adminSeenAt) < 3 * 60 * 1000;

/** The admin (owner 0) or the shop's agent answers. */
async function reply(owner, id, text) {
  const t = threadFor(owner, id);
  if (!t) return { error: 'Chat not found.', status: 404 };
  const body = cleanText(text);
  if (!body) return { error: 'Write a reply first.' };
  await messagesOf(t);
  const m = await pool.query('INSERT INTO chat_messages (thread_id, from_admin, body) VALUES ($1, true, $2) RETURNING *', [t.id, body]);
  const msg = mapMessage(m.rows[0]);
  await pool.query(`UPDATE chat_threads SET last_at = $2, last_text = $3, last_from_admin = true, user_unread = user_unread + 1,
    admin_unread = 0, admin_read_id = $4 WHERE id = $1`, [t.id, msg.at, body.slice(0, 200), msg.id]);
  Object.assign(t, { lastAt: msg.at, lastText: body.slice(0, 200), lastFromAdmin: true, userUnread: t.userUnread + 1, adminUnread: 0,
    adminReadId: msg.id, lastMsgId: msg.id });
  t.msgs.push(msg);
  seenBy(owner);
  return { message: msg };
}

/* ------------------------------------------------------------------ reading, on the website */

function userView(t) {
  return { code: t.code, status: t.status, unread: t.userUnread, adminReadId: t.adminReadId, lastMsgId: t.lastMsgId };
}
// Who they are talking to: Abrants (null) or the shop's name and look.
function withWhom(shop) {
  return shop ? { name: shop.shopName, logo: lazy('agentShop').logoUrl(shop), theme: shop.theme || 'gold' } : null;
}

/** The button on every page: is chat on, who answers, anything unread? From memory. */
async function userHello(req, slug) {
  const s = await chatSettings();
  const { owner, shop } = await ownerFor(req, slug);
  const { thread: t } = await identify(req, { light: true, owner });
  return { enabled: s.enabled, online: online(owner), unread: t ? t.userUnread : 0, hasChat: Boolean(t), with: withWhom(shop) };
}

/** Opening the chat on the website: who they are, and their messages. */
async function userOpen(req, res, slug) {
  const s = await chatSettings();
  const { owner, shop } = await ownerFor(req, slug);
  const who = await identify(req, { owner });
  const t = who.thread;
  if (t) setCookie(res, t);
  const me = who.agent ? { kind: 'agent', name: who.agent.shopName }
    : who.customer ? { kind: 'customer', name: who.customer.name || who.customer.phone }
      : t && (t.agentId || t.customerId) ? { kind: label(t).kind, name: label(t).name }
        : { kind: 'visitor', code: t ? t.code : null, phone: t ? t.phone : '' };
  return { enabled: s.enabled, online: online(owner), with: withWhom(shop), me, thread: t ? userView(t) : null, messages: t ? (await messagesOf(t)).slice(-100) : [] };
}

/** The frequent check from the website: from memory, unless new messages need reading for the first time. */
async function userPoll(req, after, slug) {
  const { owner } = await ownerFor(req, slug);
  const { thread: t } = await identify(req, { light: true, owner });
  if (!t) return { online: online(owner), thread: null, messages: [] };
  return { online: online(owner), thread: userView(t), messages: await newSince(t, after) };
}

/** They have read the answers. Only writes when something was unread. */
async function userSeen(req, slug) {
  const { owner } = await ownerFor(req, slug);
  const { thread: t } = await identify(req, { light: true, owner });
  if (!t || (!t.userUnread && t.userReadId >= t.lastMsgId)) return { ok: true };
  await pool.query('UPDATE chat_threads SET user_unread = 0, user_read_id = $2 WHERE id = $1', [t.id, t.lastMsgId]);
  t.userUnread = 0; t.userReadId = t.lastMsgId;
  return { ok: true };
}

/* ------------------------------------------------------------------ the inbox: Admin (owner 0) or an agent's Customers */

function summary(t) {
  const l = label(t);
  const a = t.agentId && !t.shopId ? lazy('agents').getAgent(t.agentId) : null;
  return { id: t.id, code: t.code, kind: l.kind, name: l.name, sub: l.sub, logo: a ? lazy('agentShop').logoUrl(a) : null,
    status: t.status, lastAt: t.lastAt, lastText: t.lastText, lastFromAdmin: t.lastFromAdmin, unread: t.adminUnread,
    userReadId: t.userReadId, lastMsgId: t.lastMsgId, context: t.context, createdAt: t.createdAt };
}

/** Every chat for this inbox, newest first, from memory. Looking at it counts as being online. */
function list(owner = 0) {
  seenBy(owner);
  const out = [...threads.values()].filter((t) => ownerOf(t) === owner).sort((x, y) => new Date(y.lastAt) - new Date(x.lastAt)).map(summary);
  return { threads: out, unread: out.reduce((n, t) => n + (t.unread ? 1 : 0), 0) };
}
/** How many chats are unread (memory). touch: counts as being online. */
function unreadCount(owner = 0, { touch = true } = {}) {
  if (touch) seenBy(owner);
  let n = 0;
  for (const t of threads.values()) if (t.adminUnread && ownerOf(t) === owner) n += 1;
  return n;
}

async function open(owner, id, after) {
  const t = threadFor(owner, id);
  if (!t) return null;
  seenBy(owner);
  return { thread: summary(t), messages: Number(after) ? await newSince(t, after) : (await messagesOf(t)).slice(-200) };
}

async function markSeen(owner, id) {
  const t = threadFor(owner, id);
  if (!t) return { error: 'Chat not found.', status: 404 };
  if (t.adminUnread || t.adminReadId < t.lastMsgId) {
    await pool.query('UPDATE chat_threads SET admin_unread = 0, admin_read_id = $2 WHERE id = $1', [t.id, t.lastMsgId]);
    t.adminUnread = 0; t.adminReadId = t.lastMsgId;
  }
  return { ok: true };
}

async function setStatus(owner, id, status) {
  const t = threadFor(owner, id);
  if (!t) return { error: 'Chat not found.', status: 404 };
  if (!['open', 'done'].includes(status)) return { error: 'Choose open or done.' };
  await pool.query('UPDATE chat_threads SET status = $2 WHERE id = $1', [t.id, status]);
  t.status = status;
  return { thread: summary(t) };
}

async function remove(owner, id) {
  const t = threadFor(owner, id);
  if (!t) return { error: 'Chat not found.', status: 404 };
  await pool.query('DELETE FROM chat_threads WHERE id = $1', [t.id]);
  unindex(t);
  return { ok: true, who: label(t).name };
}

/**
 * Who they are and their recent orders, when a chat is opened. A shop's agent sees only orders from their own shop.
 */
async function about(owner, id) {
  const t = threadFor(owner, id);
  if (!t) return null;
  const out = { ...label(t), code: t.code, phone: t.phone, email: owner ? '' : t.email, context: t.context, since: t.createdAt };
  if (t.agentId && !owner) {
    const a = lazy('agents').getAgent(t.agentId);
    if (a) Object.assign(out, { agent: { id: a.id, shopName: a.shopName, slug: a.slug, status: a.status, phone: a.phone, strikes: lazy('agents').extraOf(a.id).strikes } });
  }
  const phones = [...new Set([t.phone, out.agent && out.agent.phone].filter((p) => PHONE_RE.test(p || '')))];
  const refs = t.context && t.context.lastOrder ? [t.context.lastOrder] : [];
  if (phones.length || refs.length) {
    const r = await pool.query(`
      SELECT * FROM (
        SELECT reference, network || ' ' || label AS what, phone, price_ghs, status, created_at, agent_id FROM orders
         WHERE status <> 'pending' AND (phone = ANY($1) OR reference = ANY($2))
        UNION ALL
        SELECT reference, CASE WHEN quantity > 1 THEN quantity || ' × ' || item_name ELSE item_name END, phone, price_ghs, status, created_at, agent_id FROM service_orders
         WHERE status <> 'pending' AND (phone = ANY($1) OR reference = ANY($2))
      ) x WHERE ($3::bigint IS NULL OR agent_id = $3) ORDER BY created_at DESC LIMIT 6`, [phones, refs, owner || null]);
    out.orders = r.rows.map((o) => ({ reference: o.reference, what: o.what, phone: o.phone, priceGHS: Number(o.price_ghs), status: o.status, at: o.created_at }));
  } else out.orders = [];
  return out;
}

/** A deleted agent: their chat with Abrants and their customers' chats with their shop go too. */
async function dropForAgent(agentId) {
  const id = Number(agentId);
  const gone = [...threads.values()].filter((t) => t.shopId === id || (t.agentId === id && !t.shopId));
  await pool.query('DELETE FROM chat_threads WHERE shop_id = $1 OR (agent_id = $1 AND shop_id IS NULL)', [id]);
  gone.forEach(unindex);
  return gone.length;
}

/** Deletes chats with no message for longer than the setting (run once a day). */
async function cleanup() {
  const { keepDays } = await chatSettings();
  const cutoff = Date.now() - keepDays * 864e5;
  const old = [...threads.values()].filter((t) => new Date(t.lastAt).getTime() < cutoff);
  if (!old.length) return 0;
  await pool.query('DELETE FROM chat_threads WHERE id = ANY($1)', [old.map((t) => t.id)]);
  old.forEach(unindex);
  return old.length;
}

module.exports = {
  initChatDb, loadThreads, chatSettings, saveChatSettings, userSend, userHello, userOpen, userPoll, userSeen,
  list, unreadCount, open, reply, markSeen, setStatus, remove, about, dropForAgent, cleanup, online, KEEP, MAX_TEXT,
};
