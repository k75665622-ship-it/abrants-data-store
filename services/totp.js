/*
 * Six-digit codes from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, ...): the standard
 * "TOTP" codes of RFC 6238 (HMAC-SHA1, 30 seconds, 6 digits), used for the Admin two-step sign-in (services/adminAuth.js).
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not a base32 key');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new random key (160 bits), as the app expects it: 32 letters and digits. */
const newSecret = () => base32Encode(crypto.randomBytes(20));

const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

function codeFor(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step % 2 ** 32, 4);
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

/**
 * Checks a code, allowing one step either side for a phone clock that is a little off.
 * -> the step it matched (pass it back as `after` next time, so a code cannot be used twice), or null.
 */
function verify(secret, code, { after = -1, now = Date.now() } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const here = stepAt(now);
  for (const step of [here - 1, here, here + 1]) {
    if (step <= after) continue;
    const want = Buffer.from(codeFor(secret, step));
    if (crypto.timingSafeEqual(want, Buffer.from(c))) return step;
  }
  return null;
}

/** The link the app reads from the QR code. */
function uri(secret, account, issuer) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

module.exports = { newSecret, codeFor, verify, uri, stepAt, base32Encode, base32Decode, STEP_SECONDS };
