/*
 * Text messages (SMS) through Arkesel (https://arkesel.com). Off until ARKESEL_API_KEY is set in Render.
 *
 *  - Messages are sent in the background: an order, a webhook or a payout never waits for the SMS company, and an
 *    SMS problem never stops an order. A message that fails for a network reason is tried once more a minute later.
 *  - Text is kept to plain GSM characters ("GHS", not "₵"; no emoji). One odd character would make Arkesel bill the
 *    whole message as Unicode, at 70 characters per SMS instead of 160.
 *  - Nothing is written to the database (Neon can sleep): the last messages are kept in memory for Admin to see.
 */
const axios = require('axios');

const client = axios.create({
  // Always Arkesel. ARKESEL_API_URL exists only so the tests can point at a stand-in.
  baseURL: process.env.ARKESEL_API_URL || 'https://sms.arkesel.com',
  timeout: 15000,
});

function configured() { return Boolean(process.env.ARKESEL_API_KEY); }

// The name people see as the sender. It must be registered with Arkesel first (letters and digits, 11 at most).
function sender() {
  const s = String(process.env.SMS_SENDER || 'ABRANTS').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 11);
  return s || 'ABRANTS';
}

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

// One request to Arkesel. -> { ok: true, id, parts } ; throws on failure.
async function deliver(phone, text) {
  if (!configured()) { const e = new Error('SMS is not set up (ARKESEL_API_KEY).'); e.code = 'not_configured'; throw e; }
  const to = intl(phone);
  if (!to) { const e = new Error('Not a Ghana phone number.'); e.code = 'bad_number'; throw e; }
  const message = plain(text);
  if (!message) { const e = new Error('Empty message.'); e.code = 'empty'; throw e; }
  const res = await client.post('/api/v2/sms/send', { sender: sender(), message, recipients: [to] }, {
    headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
  });
  const d = res.data || {};
  if (String(d.status || '').toLowerCase() !== 'success') {
    const e = new Error(String(d.message || 'Arkesel did not accept the message.').slice(0, 160)); e.code = 'rejected'; throw e;
  }
  const item = Array.isArray(d.data) ? d.data.find((x) => String(x.recipient || '').replace(/\D/g, '') === to) || d.data[0] : null;
  return { ok: true, id: item && item.id ? String(item.id) : null, parts: parts(message) };
}

function logged(phone, text, kind) {
  // A sign-up code is never shown in Admin.
  return { at: new Date().toISOString(), to: mask(intl(phone)), kind, text: kind === 'agent.code' ? plain(text).replace(/\d{6}/, '******') : plain(text) };
}
const reason = (err) => String(err.response?.data?.message || err.message || 'failed').slice(0, 160);

/** Sends now and waits for Arkesel's answer (the admin test, the sign-up code). Throws on failure. */
async function sendNow(phone, text, kind = 'message') {
  try {
    const r = await deliver(phone, text);
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
  const attempt = (n) => deliver(phone, text)
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

/** Arkesel's balance (SMS credit and/or main balance), or null when it cannot be read. */
async function balance() {
  if (!configured()) return null;
  try {
    const res = await client.get('/api/v2/clients/balance-details', { headers: { 'api-key': process.env.ARKESEL_API_KEY } });
    const d = (res.data && (res.data.data || res.data)) || {};
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(String(v).replace(/[^\d.]/g, ''))) ? null : Number(String(v).replace(/[^\d.]/g, '')));
    const smsBalance = num(d.sms_balance ?? d.smsBalance ?? d.balance);
    const mainBalance = num(d.main_balance ?? d.mainBalance);
    return smsBalance == null && mainBalance == null ? null : { sms: smsBalance, main: mainBalance };
  } catch (err) {
    return null;
  }
}

module.exports = { configured, sender, intl, plain, parts, send, sendNow, balance, recent, counts };
