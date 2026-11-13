/*
 * Looking after agents (Admin → Agents): the agent's inbox, strikes, pausing a shop for a set time, and deleting a
 * shop for good. Each step lands in the agent's inbox (agent page → Inbox) and goes out by SMS (services/notify.js).
 *
 *  - A strike is a written warning with a reason. The admin decides what happens after the third one.
 *  - A pause lasts 1 week to 6 months, or until the admin reopens the shop. A check every few minutes reopens it
 *    when the time is up (from memory: the database is only touched when a shop is due).
 *  - Deleting closes the shop at once. Once the agent has been paid everything they earned (or straight away when the
 *    admin deletes without paying, for fraud), their personal details are erased: name, phone, password, MoMo,
 *    logo, about line and messages. Sales and payout records stay for the store's accounts. The shop link stays
 *    reserved, so nobody else can take it over and pretend to be them.
 *  - A deleted agent's phone and MoMo numbers can be blocked from signing up again (stored only as hashes).
 */
const crypto = require('crypto');
const { pool } = require('./orderStore');
const { round2 } = require('./fees');

const lazy = (name) => require('./' + name);
const A = () => lazy('agents');
const notify = () => lazy('notify');

const PAUSE_DAYS = [7, 14, 30, 90, 180]; // 0 = until the store reopens it
const NET = { MTN: 'MTN MoMo', Telecel: 'Telecel Cash', AirtelTigo: 'AirtelTigo Money' };
const ghs = (v) => 'GH₵' + Number(v || 0).toFixed(2);
const day = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Accra' });

// Text from the admin: tags removed, line breaks kept.
function cleanBody(v, max) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f<>]/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/* ------------------------------------------------------------------ blocked numbers */

const bans = new Set();
const banHash = (number) => crypto.createHash('sha256').update('abrants-agent-ban|' + String(number || '').replace(/\D/g, '')).digest('hex');
async function loadBans() {
  const r = await pool.query('SELECT hash FROM agent_bans');
  bans.clear();
  for (const x of r.rows) bans.add(x.hash);
}
const banned = (number) => Boolean(String(number || '').replace(/\D/g, '')) && bans.has(banHash(number));
async function ban(numbers) {
  for (const n of numbers) {
    if (!/^0\d{9}$/.test(String(n || ''))) continue;
    const h = banHash(n);
    await pool.query('INSERT INTO agent_bans (hash) VALUES ($1) ON CONFLICT DO NOTHING', [h]);
    bans.add(h);
  }
}

/* ------------------------------------------------------------------ inbox */

function mapMessage(r) {
  return { id: Number(r.id), kind: r.kind, title: r.title, body: r.body || '', strike: Boolean(r.strike), removed: Boolean(r.removed_at),
    createdAt: r.created_at, read: Boolean(r.read_at) };
}

async function addMessage(agentId, { kind, title, body = '', strike = false }) {
  const r = await pool.query('INSERT INTO agent_messages (agent_id, kind, title, body, strike) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [agentId, kind, String(title).slice(0, 120), String(body || '').slice(0, 2000), strike]);
  const x = A().extraOf(agentId);
  x.unread += 1;
  if (strike) x.strikes += 1;
  return mapMessage(r.rows[0]);
}

async function messages(agentId, { limit = 50 } = {}) {
  const r = await pool.query('SELECT * FROM agent_messages WHERE agent_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [agentId, Math.min(Number(limit) || 50, 200)]);
  return r.rows.map(mapMessage);
}

/** The agent opened their inbox. No database work when nothing is unread. */
async function markRead(agentId) {
  const x = A().extraOf(agentId);
  if (!x.unread) return;
  await pool.query('UPDATE agent_messages SET read_at = NOW() WHERE agent_id = $1 AND read_at IS NULL', [agentId]);
  x.unread = 0;
}

function live(agentId) {
  const a = A().getAgent(agentId);
  return a && a.status !== 'deleted' && !a.deleteRequestedAt ? a : null;
}

/** Admin → one agent. */
async function sendMessage(agentId, { text, sms = true } = {}) {
  const a = live(agentId);
  if (!a) return { error: 'Agent not found.', status: 404 };
  const body = cleanBody(text, 1000);
  if (body.length < 2) return { error: 'Write the message first.', field: 'text' };
  const message = await addMessage(a.id, { kind: 'message', title: 'Message from Abrants', body });
  if (sms) notify().agentMessage(a, body);
  return { message };
}

/** Admin → every agent who can still log in (waiting, active or paused). */
async function messageAll({ text, sms = false } = {}) {
  const body = cleanBody(text, 1000);
  if (body.length < 2) return { error: 'Write the message first.', field: 'text' };
  const list = [...A().byId.values()].filter((a) => ['pending', 'active', 'suspended'].includes(a.status) && !a.deleteRequestedAt);
  for (const a of list) {
    await addMessage(a.id, { kind: 'message', title: 'Message from Abrants', body });
    if (sms) notify().agentMessage(a, body);
  }
  return { sent: list.length };
}

/* ------------------------------------------------------------------ strikes */

async function strike(agentId, { reason, sms = true } = {}) {
  const a = live(agentId);
  if (!a) return { error: 'Agent not found.', status: 404 };
  const why = cleanBody(reason, 400);
  if (why.length < 3) return { error: 'Say what the agent did wrong.', field: 'reason' };
  const n = A().extraOf(a.id).strikes + 1;
  const next = n >= 3
    ? `This is strike ${n}. If it happens again, your shop can be paused or deleted.`
    : 'Please don\'t do this again. If you are not sure what is allowed, read the agent terms or ask us.';
  const message = await addMessage(a.id, { kind: 'strike', title: `Strike ${n}`, body: `${why}\n\n${next}`, strike: true });
  if (sms) notify().agentStrike(a, n, why);
  return { message, strikes: n };
}

/** A strike given by mistake. It stays in the inbox, marked as removed. */
async function removeStrike(agentId, messageId) {
  const r = await pool.query(`UPDATE agent_messages SET removed_at = NOW() WHERE id = $1 AND agent_id = $2 AND strike AND removed_at IS NULL
    RETURNING id`, [Number(messageId), Number(agentId)]);
  if (!r.rowCount) return { error: 'Strike not found.', status: 404 };
  const x = A().extraOf(agentId);
  x.strikes = Math.max(0, x.strikes - 1);
  return { strikes: x.strikes };
}

/* ------------------------------------------------------------------ pausing */

/** Pause for 7, 14, 30, 90 or 180 days (it reopens by itself), or 0 = until the store reopens it. */
async function pause(agentId, { reason, days, sms = true } = {}) {
  const a = live(agentId);
  if (!a) return { error: 'Agent not found.', status: 404 };
  if (!['active', 'suspended'].includes(a.status)) return { error: 'Only an open or paused shop can be paused.', status: 409 };
  const why = cleanBody(reason, 300);
  if (why.length < 3) return { error: 'Say why the shop is paused.', field: 'reason' };
  const d = Number(days);
  if (d !== 0 && !PAUSE_DAYS.includes(d)) return { error: 'Choose how long.', field: 'days' };
  const until = d ? new Date(Date.now() + d * 864e5) : null;
  const after = await A().setStatus(a.id, 'suspended', { reason: why, until, quiet: true });
  await addMessage(a.id, { kind: 'paused', title: 'Your shop is paused',
    body: `Reason: ${why}\n\n${until ? `Your shop opens again by itself on ${day(until)}.` : 'It stays paused until the store reopens it.'} The money you earned stays in your account.` });
  if (sms) notify().agentPaused(after, until, why);
  return { agent: after };
}

/** Inbox lines for the plain status changes (approve, reopen, pause without a reason). Called by agents.setStatus. */
async function statusMessage(a, before) {
  if (a.status === 'active' && before === 'pending') {
    await addMessage(a.id, { kind: 'approved', title: 'Your shop is open',
      body: 'Welcome! Your shop link is live. Share it with your customers on WhatsApp, set your prices in Prices, and make the shop yours in My shop: your logo, colour and a few words about you.' });
  } else if (a.status === 'active') {
    await addMessage(a.id, { kind: 'reopened', title: 'Your shop is open again', body: 'Customers can buy from your shop link again.' });
  } else if (a.status === 'suspended') {
    await addMessage(a.id, { kind: 'paused', title: 'Your shop is paused',
      body: (a.statusReason ? `Reason: ${a.statusReason}\n\n` : '') + 'It stays paused until the store reopens it. The money you earned stays in your account. Contact the store if you have questions.' });
  }
}

async function paidMessage(a, p) {
  if (!a || a.status === 'deleted' || !p) return;
  await addMessage(a.id, { kind: 'paid', title: `We sent ${ghs(p.sentGHS)} to your MoMo`,
    body: `To ${NET[p.momoNetwork] || p.momoNetwork} ${p.momoNumber}` + (p.feeGHS > 0 ? ` (${ghs(p.amountGHS)} earned, less the ${ghs(p.feeGHS)} transfer fee)` : '') + '.' });
}

/* ------------------------------------------------------------------ deleting */

/**
 * Closes the shop now and deletes it once nothing is owed.
 *   by: 'agent' (from their Settings) or 'admin'
 *   pay: false = the agent forfeits what they have not been paid yet (fraud). Only the admin can choose this.
 *   block: their phone and MoMo numbers cannot open a shop again.
 * -> { deleted: true } or { deleted: false, owedGHS } (deleted after the last payout).
 */
async function remove(agentId, { by = 'admin', reason = '', pay = true, block = false, sms = true } = {}) {
  const a = A().getAgent(agentId);
  if (!a || a.status === 'deleted') return { error: 'Agent not found.', status: 404 };
  const why = cleanBody(reason, 300) || (by === 'agent' ? 'Deleted by the agent' : '');
  if (by === 'admin' && why.length < 3) return { error: 'Say why the shop is deleted.', field: 'reason' };
  if (block) await ban([a.phone, a.momoNumber]);
  if (by === 'admin' && pay === false && !a.forfeitedAt) {
    await pool.query(`UPDATE agent_earnings SET status = 'cancelled' WHERE agent_id = $1 AND status = 'available' AND payout_id IS NULL`, [a.id]);
    await pool.query('UPDATE agents SET forfeited_at = NOW() WHERE id = $1', [a.id]);
  }
  await pool.query(`UPDATE agents SET status = 'rejected', delete_requested_at = COALESCE(delete_requested_at, NOW()), status_reason = $2,
    suspended_until = NULL WHERE id = $1`, [a.id, why]);
  await A().reload(a.id);
  const out = await finishDelete(a.id);
  if (sms) notify().agentDeleted(a, { by, reason: why, waiting: !out.deleted, owedGHS: out.owedGHS || 0, pay: pay !== false });
  return out;
}

/** Deletes a closing shop if nothing is owed any more. Runs after each payout and every few hours. */
async function finishDelete(agentId) {
  const a = A().getAgent(agentId);
  if (!a || a.status === 'deleted') return { deleted: true };
  if (!a.deleteRequestedAt) return { deleted: false, owedGHS: 0 };
  const agents = A();
  await agents.reconcile(a.id);
  const b = (await agents.balances([a.id])).get(a.id) || {};
  const fee = Number((await agents.settingsNow()).payoutFee) || 0;
  const coming = round2((b.heldGHS || 0) + (b.onTheWayGHS || 0) + (b.sendingGHS || 0));
  const ready = round2(b.readyGHS || 0);
  // Still owed: anything on hold, on the way or being sent, or more than the transfer fee ready to send.
  // (A last amount at or below the fee cannot be sent.)
  if (b.sendingGHS > 0 || (!a.forfeitedAt && (coming > 0 || ready > fee))) return { deleted: false, owedGHS: round2(coming + ready) };
  await scrub(a);
  return { deleted: true };
}

async function scrub(a) {
  await pool.query(`UPDATE agents SET status = 'deleted', deleted_at = NOW(), name = 'Deleted agent', phone = 'deleted-' || id::text,
      password_hash = '', whatsapp = NULL, momo_number = '', momo_network = '', momo_name = '', recipient_code = NULL, recipient_for = NULL,
      prices = '{}'::jsonb, bio = NULL, announcement = NULL, hidden = '[]'::jsonb, featured = '[]'::jsonb, logo_v = 0,
      must_change_password = false, suspended_until = NULL WHERE id = $1`, [a.id]);
  await pool.query('DELETE FROM agent_logos WHERE agent_id = $1', [a.id]);
  await pool.query('DELETE FROM agent_messages WHERE agent_id = $1', [a.id]);
  const x = A().extraOf(a.id);
  x.unread = 0; x.strikes = 0;
  lazy('agentShop').forgetLogo(a.id);
  await A().reload(a.id);
}

/** The agent deletes their own shop (Settings), with their password. */
async function selfDelete(agentId, password) {
  const a = A().getAgent(agentId);
  if (!a || a.status === 'deleted') return { error: 'Not found.', status: 404 };
  if (!(await lazy('customers').verifyPassword(String(password || ''), a.passwordHash))) return { error: 'Your password is not correct.', field: 'password' };
  return remove(a.id, { by: 'agent', pay: true });
}

/* ------------------------------------------------------------------ the regular check */

let lastDeleteCheck = 0;
/** Every few minutes: reopens shops whose pause is over (memory only until one is due); every 6 hours, closing shops. */
async function tick() {
  const now = Date.now();
  for (const a of [...A().byId.values()]) {
    if (a.status === 'suspended' && a.suspendedUntil && !a.deleteRequestedAt && new Date(a.suspendedUntil).getTime() <= now) {
      try { await A().setStatus(a.id, 'active'); } catch (e) { console.warn('Reopening a paused shop failed:', e.message); }
    }
  }
  if (now - lastDeleteCheck < 6 * 3600 * 1000) return;
  lastDeleteCheck = now;
  for (const a of [...A().byId.values()]) {
    if (a.deleteRequestedAt && a.status !== 'deleted') {
      try { await finishDelete(a.id); } catch (e) { console.warn('Deleting a closed shop failed:', e.message); }
    }
  }
}

module.exports = {
  PAUSE_DAYS, loadBans, banned, messages, markRead, addMessage, sendMessage, messageAll, strike, removeStrike, pause,
  statusMessage, paidMessage, remove, finishDelete, selfDelete, tick, cleanBody,
};
