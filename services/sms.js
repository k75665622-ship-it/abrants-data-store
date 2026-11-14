/*
 * Text messages (SMS) through mNotify (https://bms.africa, MNOTIFY_API_KEY) or Arkesel (https://arkesel.com,
 * ARKESEL_API_KEY). Off until one of the keys is set in Render. With both set, mNotify is used (SMS_PROVIDER=arkesel
 * picks Arkesel instead).
 *
 *  - Messages are sent in the background: an order, a webhook or a payout never waits for the SMS company, and an
 *    SMS problem never stops an order. A message that fails for a network reason is tried once more a minute later.
 *  - Text is kept to plain GSM characters ("GHS", not "₵"; no emoji). One odd character would make the SMS company
 *    bill the whole message as Unicode, at 70 characters per SMS instead of 160.
 *  - Nothing is written to the database (Neon can sleep): the last messages are kept in memory for Admin to see.
 *    mNotify says how much credit is left with every message, so running low is noticed without asking it again.
 */
const axios = require('axios');

// MNOTIFY_API_URL / ARKESEL_API_URL exist only so the tests can point at stand-ins.
const PROVIDERS = {
  mnotify: { name: 'mNotify', keyVar: 'MNOTIFY_API_KEY', http: axios.create({ baseURL: process.env.MNOTIFY_API_URL || 'https://api.mnotify.com', timeout: 15000 }) },
  arkesel: { name: 'Arkesel', keyVar: 'ARKESEL_API_KEY', http: axios.create({ baseURL: process.env.ARKESEL_API_URL || 'https://sms.arkesel.com', timeout: 15000 }) },
};

/** 'mnotify', 'arkesel' or null (SMS off). */
function provider() {
  const want = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (PROVIDERS[want] && process.env[PROVIDERS[want].keyVar]) return want;
  if (process.env.MNOTIFY_API_KEY) return 'mnotify';
  if (process.env.ARKESEL_API_KEY) return 'arkesel';
  return null;
}
function configured() { return Boolean(provider()); }
const providerName = () => (provider() ? PROVIDERS[provider()].name : null);

// The name people see as the sender. It must be approved by the SMS company first (letters and digits, 11 at most).
const cleanSender = (v) => String(v || '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 11);
function sender() { return cleanSender(process.env.SMS_SENDER) || 'ABRANTS'; }
// One-time codes (agent sign-up, MoMo numbers) can need a sender name approved for codes ("OTP sender ID" at
// mNotify), e.g. SMS_CODE_SENDER=ABRANTSCODE. Without it, codes go from the usual sender.
function codeSender() { return cleanSender(process.env.SMS_CODE_SENDER) || sender(); }
const CODE_KINDS = new Set(['agent.code']);

/** 0241234567 / 233241234567 / +233 24 123 4567 -> 233241234567, or null. */
function intl(phone) {
  const p = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (/^0\d{9}$/.test(p)) return '233' + p.slice(1);
  if (/^233\d{9}$/.test(p)) return p;
  return null;
}

// The GSM 03.38 basic set (plus the two-byte extension characters), so a message stays at 160 characters per SMS.
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€';
function plain(text) {
  const s = String(text == null ? '' : text)
    .replace(/GH₵\s?/g, 'GHS ').replace(/₵/g, 'GHS ')
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/•/g, '-')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let out = '';
  for (const ch of s) out += GSM.includes(ch) ? ch : (/\s/.test(ch) ? ' ' : '');
  return out.replace(/ {2,}/g, ' ').trim();
}
/** How many SMS a plain message costs (153 characters per part once it is split). */
function parts(text) {
  const n = [...String(text)].reduce((t, ch) => t + ('^{}\\[~]|€'.includes(ch) ? 2 : 1), 0);
  return n <= 160 ? 1 : Math.ceil(n / 153);
}

const recent = []; // last messages, newest first (for Admin): { at, to, kind, text, ok, error }
const counts = { sent: 0, failed: 0, since: new Date().toISOString() };
function note(entry) { recent.unshift(entry); if (recent.length > 30) recent.length = 30; }
const mask = (p) => (p && p.length === 12 ? '0' + p.slice(3, 5) + '•••••' + p.slice(-3) : p); // 233241234567 -> 024•••••567

/*
 * Credit left (mNotify reports it with every message). Low credit leaves a notice on the Admin dashboard: without
 * credit, customers get no texts and nobody can sign up as an agent (the sign-up code is a text).
 */
const LOW_CREDIT = () => Math.max(0, Number(process.env.SMS_LOW_CREDIT || 50));
const credit = { left: null, at: null };
const warned = { low: 0, empty: 0 }; // when each notice was last left (at most one of each every 6 hours)
function noteCredit(left) {
  if (!Number.isFinite(left)) return;
  credit.left = left; credit.at = new Date().toISOString();
  if (left >= LOW_CREDIT()) { warned.low = warned.empty = 0; return; }
  const level = left <= 0 ? 'empty' : 'low';
  if (Date.now() - warned[level] < 6 * 3600 * 1000) return;
  warned[level] = Date.now();
  warn(left <= 0
    ? `Text messages have stopped: no SMS credit left on ${providerName()}. Top up now. Until then customers get no texts and nobody can sign up as an agent.`
    : `Fewer than ${LOW_CREDIT()} text messages left on ${providerName()}. Top up soon: without credit, customers get no texts and nobody can sign up as an agent.`);
}
function warn(text) {
  try { Promise.resolve(require('./fulfillment').addAlert('warn', text)).catch(() => {}); } catch { /* the notice is a convenience */ }
}
const rejected = (message, fallback) => { const e = new Error(String(message || fallback).slice(0, 160)); e.code = 'rejected'; return e; };
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(String(v).replace(/[^\d.-]/g, ''))) ? null : Number(String(v).replace(/[^\d.-]/g, '')));

// One request to the SMS company. -> { ok: true, id, parts } ; throws on failure.
async function deliver(phone, text, kind) {
  const from = CODE_KINDS.has(kind) ? codeSender() : sender();
  const which = provider();
  if (!which) { const e = new Error('SMS is not set up (MNOTIFY_API_KEY).'); e.code = 'not_configured'; throw e; }
  const to = intl(phone);
  if (!to) { const e = new Error('Not a Ghana phone number.'); e.code = 'bad_number'; throw e; }
  const message = plain(text);
  if (!message) { const e = new Error('Empty message.'); e.code = 'empty'; throw e; }
  const { http, keyVar } = PROVIDERS[which];
  const key = process.env[keyVar];

  if (which === 'mnotify') {
    const res = await http.post('/api/sms/quick', { recipient: [to], sender: from, message, is_schedule: false, schedule_date: '' },
      { params: { key }, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    const d = res.data || {};
    const sum = d.summary || {};
    if (String(d.status || '').toLowerCase() !== 'success' && String(d.code) !== '2000') {
      const e = rejected(d.message, 'mNotify did not accept the message.');
      if (/insufficient|balance|credit/i.test(e.message)) noteCredit(0);
      throw e;
    }
    if (num(sum.total_rejected) > 0 && !num(sum.total_sent)) throw rejected(null, 'mNotify did not accept this number.');
    noteCredit(num(sum.credit_left));
    return { ok: true, id: sum._id || sum.message_id ? String(sum._id || sum.message_id) : null, parts: parts(message) };
  }

  const res = await http.post('/api/v2/sms/send', { sender: from, message, recipients: [to] }, {
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
  });
  const d = res.data || {};
  if (String(d.status || '').toLowerCase() !== 'success') throw rejected(d.message, 'Arkesel did not accept the message.');
  const item = Array.isArray(d.data) ? d.data.find((x) => String(x.recipient || '').replace(/\D/g, '') === to) || d.data[0] : null;
  return { ok: true, id: item && item.id ? String(item.id) : null, parts: parts(message) };
}

function logged(phone, text, kind) {
  // A sign-up code is never shown in Admin.
  return { at: new Date().toISOString(), to: mask(intl(phone)), kind, text: kind === 'agent.code' ? plain(text).replace(/\d{6}/, '******') : plain(text) };
}
const reason = (err) => String(err.response?.data?.message || err.message || 'failed').slice(0, 160);

/** Sends now and waits for the SMS company's answer (the admin test, the sign-up codes). Throws on failure. */
async function sendNow(phone, text, kind = 'message') {
  try {
    const r = await deliver(phone, text, kind);
    counts.sent += 1; note({ ...logged(phone, text, kind), ok: true, parts: r.parts });
    return r;
  } catch (err) {
    if (configured() && intl(phone)) { counts.failed += 1; note({ ...logged(phone, text, kind), ok: false, error: reason(err) }); }
    throw err;
  }
}

/**
 * Sends in the background. Returns straight away: true if it was queued, false if SMS is off or the number is not a
 * Ghana number. `kind` is a short label for the Admin log ("order.delivered", "agent.code", ...).
 */
function send(phone, text, kind = 'message') {
  if (!configured() || !intl(phone)) return false;
  const attempt = (n) => deliver(phone, text, kind)
    .then((r) => { counts.sent += 1; note({ ...logged(phone, text, kind), ok: true, parts: r.parts }); })
    .catch((err) => {
      const network = !err.response && !['not_configured', 'bad_number', 'empty', 'rejected'].includes(err.code);
      if (network && n === 1) { setTimeout(() => attempt(2), Number(process.env.SMS_RETRY_MS || 60 * 1000)).unref(); return; }
      counts.failed += 1;
      const why = reason(err);
      note({ ...logged(phone, text, kind), ok: false, error: why });
      console.warn(`SMS (${kind}) to ${mask(intl(phone))} failed: ${why}`);
    });
  setImmediate(() => attempt(1));
  return true;
}

/** The credit left: { sms, main } (main = money, Arkesel only), or null when it cannot be read. */
async function balance() {
  const which = provider();
  if (!which) return null;
  const { http, keyVar } = PROVIDERS[which];
  try {
    if (which === 'mnotify') {
      const res = await http.get('/api/balance/sms', { params: { key: process.env[keyVar] }, headers: { Accept: 'application/json' } });
      const d = (res.data && (res.data.data || res.data)) || {};
      const main = num(d.balance ?? d.sms_balance), bonus = num(d.bonus);
      const sms = main == null && bonus == null ? null : (main || 0) + (bonus || 0);
      if (sms != null) noteCredit(sms);
      return sms == null ? fromSends() : { sms, main: null };
    }
    const res = await http.get('/api/v2/clients/balance-details', { headers: { 'api-key': process.env[keyVar] } });
    const d = (res.data && (res.data.data || res.data)) || {};
    const smsBalance = num(d.sms_balance ?? d.smsBalance ?? d.balance);
    const mainBalance = num(d.main_balance ?? d.mainBalance);
    return smsBalance == null && mainBalance == null ? null : { sms: smsBalance, main: mainBalance };
  } catch (err) {
    return fromSends();
  }
}
// What the last message said was left, when the SMS company cannot be asked.
const fromSends = () => (credit.left == null ? null : { sms: credit.left, main: null, at: credit.at });
const low = () => credit.left != null && credit.left < LOW_CREDIT();

module.exports = { configured, provider, providerName, sender, codeSender, intl, plain, parts, send, sendNow, balance, low, LOW_CREDIT, recent, counts };
