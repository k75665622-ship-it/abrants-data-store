/*
 * Admin sign-in (README 21).
 *
 *  - Password: ADMIN_PASSWORD in Render, compared in constant time. 8 wrong tries from one address lock it for 15 minutes;
 *    after 40 wrong tries in 15 minutes from anywhere, sign-in pauses for everyone for 15 minutes, and the owner gets a
 *    dashboard message when someone keeps guessing.
 *  - Two-step sign-in (optional, set up in Admin → Settings → Sign-in security): after the password, a 6-digit code
 *    from an authenticator app (services/totp.js). A code works once. ADMIN_TWO_STEP=off in Render switches it off,
 *    for when the phone with the app is lost.
 *  - Session: a signed cookie (ADMIN_SECRET), 8 hours. "Sign out other devices" (and switching two-step on) ends every
 *    other session at once.
 *
 * The two-step key and the "sessions since" time live in their own store_settings row ('admin_security'), never in the
 * store settings that Admin pages read. They are loaded once at start and kept in memory: checking a session never
 * reads the database.
 */
const crypto = require('crypto');
const qrcode = require('qrcode-generator');
const totp = require('./totp');

const COOKIE_NAME = 'abrants_admin';
const MAX_AGE_SECONDS = 8 * 60 * 60;
const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_MAX = 8;
const GLOBAL_MAX = 40; // wrong passwords in 15 minutes, from all addresses together
const ALERT_AFTER = 20; // wrong passwords in an hour before the owner is told
const CODE_ALERT_AFTER = 3; // right password, wrong code, in an hour
const ISSUER = 'Abrants Admin';

const lazy = (name) => require('./' + name);
const loginAttempts = new Map(); // ip -> { count, resetAt }
let wrongPasswords = []; // times, last hour
let wrongCodes = []; // times, last hour
let security = { twoStep: null, sessionsAfter: 0, lastStep: -1 }; // twoStep: { secret, since }
let pending = null; // { secret, at }: a two-step key shown on screen, waiting for its first code

/* --------------------------------------------------------------- storage */

async function initAdminSecurity() {
  const { pool } = lazy('orderStore');
  const r = await pool.query("SELECT value FROM store_settings WHERE key = 'admin_security'");
  const v = (r.rows[0] && r.rows[0].value) || {};
  security = {
    twoStep: v.twoStep && v.twoStep.secret ? { secret: String(v.twoStep.secret), since: v.twoStep.since || null } : null,
    sessionsAfter: Number(v.sessionsAfter) || 0,
    lastStep: Number.isFinite(Number(v.lastStep)) ? Number(v.lastStep) : -1,
  };
}
async function saveSecurity() {
  const { pool } = lazy('orderStore');
  await pool.query(`INSERT INTO store_settings (key, value, updated_at) VALUES ('admin_security', $1::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(security)]);
}

const forcedOff = () => String(process.env.ADMIN_TWO_STEP || '').trim().toLowerCase() === 'off';
const twoStepOn = () => Boolean(security.twoStep) && !forcedOff();

/* --------------------------------------------------------------- tokens */

function sign(payload) {
  return crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(payload).digest('hex');
}

function createToken() {
  const payload = `${Date.now()}:${crypto.randomBytes(12).toString('hex')}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function validToken(token) {
  if (!token || !process.env.ADMIN_SECRET) return false;
  const [encoded, signature] = token.split('.');
  if (!encoded || !/^[a-f0-9]{64}$/.test(signature || '') || token.split('.').length !== 2) return false;
  let payload;
  try { payload = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { return false; }
  const expected = sign(payload);
  if (signature.length !== expected.length) return false;
  const issued = Number(payload.split(':')[0]);
  const age = Date.now() - issued;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) && age >= 0 && age < MAX_AGE_SECONDS * 1000
    && issued >= security.sessionsAfter;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* a broken cookie is ignored */ }
  }
  return out;
}

const secureFlag = () => (process.env.NODE_ENV === 'production' ? '; Secure' : '');
function setSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(createToken())}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${MAX_AGE_SECONDS}${secureFlag()}`);
}

function requireAdmin(req, res, next) {
  if (!validToken(parseCookies(req.headers.cookie)[COOKIE_NAME])) return res.status(401).json({ error: 'Admin authentication required.' });
  next();
}

/* --------------------------------------------------------------- sign-in */

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
function passwordOk(given) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real || typeof given !== 'string' || !given) return false;
  return crypto.timingSafeEqual(digest(given), digest(real));
}

const recent = (list, ms) => { const now = Date.now(); return list.filter((t) => now - t < ms); };
function alert(level, text) {
  try { lazy('fulfillment').addAlert(level, text).catch(() => {}); } catch { /* alerts are best effort */ }
}
function failed(ip, kind) {
  const now = Date.now();
  const item = loginAttempts.get(ip);
  const next = item && now < item.resetAt ? item : { count: 0, resetAt: now + WINDOW_MS };
  next.count += 1;
  loginAttempts.set(ip, next);
  if (loginAttempts.size > 5000) for (const [k, v] of loginAttempts) if (v.resetAt <= now) loginAttempts.delete(k);
  if (kind === 'password') {
    wrongPasswords = recent(wrongPasswords, 60 * 60 * 1000); wrongPasswords.push(now);
    if (wrongPasswords.length === ALERT_AFTER) {
      alert('warn', twoStepOn()
        ? `Someone has typed a wrong Admin password ${ALERT_AFTER} times in the last hour. Two-step sign-in is on, so the password alone cannot open Admin. If this keeps happening, change ADMIN_PASSWORD in Render.`
        : `Someone has typed a wrong Admin password ${ALERT_AFTER} times in the last hour. If it was not you, make ADMIN_PASSWORD in Render longer and switch on two-step sign-in in Settings.`);
    }
  } else {
    wrongCodes = recent(wrongCodes, 60 * 60 * 1000); wrongCodes.push(now);
    if (wrongCodes.length === CODE_ALERT_AFTER) {
      alert('error', `Someone typed the right Admin password but a wrong two-step code ${CODE_ALERT_AFTER} times in the last hour. If it was not you, change ADMIN_PASSWORD in Render now.`);
    }
  }
}

async function login(req, res) {
  if (!process.env.ADMIN_SECRET || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD and ADMIN_SECRET on the server.' });
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const item = loginAttempts.get(ip);
  if (item && now < item.resetAt && item.count >= PER_IP_MAX) return res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes.' });
  if (recent(wrongPasswords, WINDOW_MS).length >= GLOBAL_MAX) {
    return res.status(429).json({ error: 'Admin sign-in is paused for 15 minutes because of many wrong passwords.' });
  }
  if (!passwordOk(req.body && req.body.password)) {
    failed(ip, 'password');
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  if (twoStepOn()) {
    const code = String((req.body && req.body.code) || '').replace(/\s/g, '');
    if (!code) return res.json({ codeNeeded: true });
    const step = totp.verify(security.twoStep.secret, code, { after: security.lastStep });
    if (step == null) {
      failed(ip, 'code');
      return res.status(401).json({ error: 'That code is not right. Type the newest code from your authenticator app.', codeNeeded: true });
    }
    security.lastStep = step;
    saveSecurity().catch((e) => console.warn('Could not save the two-step state:', e.message));
  }
  loginAttempts.delete(ip);
  setSessionCookie(res);
  lazy('orderStore').logAdminAction('admin.login', { twoStep: twoStepOn() }, ip).catch(() => {});
  res.json({ ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secureFlag()}`);
  res.json({ ok: true });
}

function session(req, res) {
  res.json({ authenticated: validToken(parseCookies(req.headers.cookie)[COOKIE_NAME]) });
}

/* --------------------------------------------------- Settings → Sign-in security */

/** What the Settings panel shows: two-step state and the server settings that matter for safety. */
function securityInfo() {
  const pw = String(process.env.ADMIN_PASSWORD || '');
  const secret = String(process.env.ADMIN_SECRET || '');
  return {
    twoStep: { on: twoStepOn(), saved: Boolean(security.twoStep), since: security.twoStep ? security.twoStep.since : null, forcedOff: forcedOff() },
    sessionsSince: security.sessionsAfter ? new Date(security.sessionsAfter).toISOString() : null,
    checks: [
      { key: 'password', ok: pw.length >= 16 },
      { key: 'secret', ok: secret.length >= 32 && secret !== pw },
      { key: 'proxy', ok: process.env.TRUST_PROXY === 'true' },
      { key: 'https', ok: process.env.NODE_ENV === 'production' },
    ],
  };
}

function qrDataUrl(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const quiet = 3;
  let d = '';
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (q.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const size = n + quiet * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Step 1 of switching two-step on: a new key, as a QR code and as text. Nothing is saved yet. */
function startTwoStep(req) {
  const secret = totp.newSecret();
  pending = { secret, at: Date.now() };
  const host = String((req && req.get && req.get('host')) || 'abrants').replace(/:\d+$/, '');
  return { key: secret.replace(/(.{4})/g, '$1 ').trim(), qr: qrDataUrl(totp.uri(secret, host, ISSUER)) };
}

/** Step 2: the first code from the app proves it was set up. Switches two-step on and signs out other devices. */
async function confirmTwoStep(res, code) {
  if (!pending || Date.now() - pending.at > 15 * 60 * 1000) return { error: 'That set-up has expired. Start again.', status: 400 };
  const step = totp.verify(pending.secret, code);
  if (step == null) return { error: 'That code is not right. Type the 6-digit code the app shows now.', status: 400 };
  security = { twoStep: { secret: pending.secret, since: new Date().toISOString() }, sessionsAfter: Date.now(), lastStep: step };
  pending = null;
  await saveSecurity();
  setSessionCookie(res); // this device stays signed in
  return { ok: true };
}

/** Switching two-step off needs the password and a current code (or only the password when Render has ADMIN_TWO_STEP=off). */
async function stopTwoStep(password, code) {
  if (!security.twoStep) return { ok: true };
  if (!passwordOk(password)) return { error: 'That password is not right.', status: 400, field: 'password' };
  if (!forcedOff()) {
    const step = totp.verify(security.twoStep.secret, code, { after: security.lastStep });
    if (step == null) return { error: 'That code is not right. Type the newest code from your authenticator app.', status: 400, field: 'code' };
  }
  security = { ...security, twoStep: null, lastStep: -1 };
  await saveSecurity();
  return { ok: true };
}

/** Ends every Admin session except this one. */
async function signOutOthers(res) {
  security = { ...security, sessionsAfter: Date.now() };
  await saveSecurity();
  setSessionCookie(res);
  return { ok: true };
}

module.exports = {
  requireAdmin, login, logout, session, initAdminSecurity,
  securityInfo, startTwoStep, confirmTwoStep, stopTwoStep, signOutOthers,
};
