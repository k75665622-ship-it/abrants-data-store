const crypto = require('crypto');

const COOKIE_NAME = 'abrants_admin';
const MAX_AGE_SECONDS = 8 * 60 * 60;
const loginAttempts = new Map();

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
  const age = Date.now() - Number(payload.split(':')[0]);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) && age >= 0 && age < MAX_AGE_SECONDS * 1000;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').filter(Boolean).map(part => {
    const i = part.indexOf('=');
    return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }));
}

function requireAdmin(req, res, next) {
  if (!validToken(parseCookies(req.headers.cookie)[COOKIE_NAME])) return res.status(401).json({ error: 'Admin authentication required.' });
  next();
}

function login(req, res) {
    if (!process.env.ADMIN_SECRET || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD and ADMIN_SECRET on the server.' });
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const item = loginAttempts.get(ip);
  if (item && now < item.resetAt && item.count >= 8) return res.status(429).json({ error: 'Too many login attempts. Please wait 15 minutes.' });
  const password = req.body?.password;
  if (!process.env.ADMIN_PASSWORD || !password || password !== process.env.ADMIN_PASSWORD) {
    const next = item && now < item.resetAt ? item : { count: 0, resetAt: now + 15 * 60 * 1000 };
    next.count += 1; loginAttempts.set(ip, next);
    return res.status(401).json({ error: 'Invalid admin password.' });
  }
  loginAttempts.delete(ip);
  const token = createToken();
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${MAX_AGE_SECONDS}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
}

function session(req, res) {
  res.json({ authenticated: validToken(parseCookies(req.headers.cookie)[COOKIE_NAME]) });
}

module.exports = { requireAdmin, login, logout, session };
