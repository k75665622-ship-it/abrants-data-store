/*
 * "Is this MTN number verified?" check, using FastDealsGH API v2 (POST /numbers/verify).
 * Results: 'verified' | 'unverified' | 'unknown' (not set up, slow, or the service said no).
 * A verified number stays verified, so positives are remembered in the database. Negatives are
 * remembered for a few minutes only, because a queued number can become verified at any time.
 */
const axios = require('axios');
const { pool } = require('./orderStore');

const NEGATIVE_MS = 5 * 60 * 1000;
const negative = new Map(); // phone -> expires at

function baseUrl() { return process.env.FASTDEALS_V2_BASE_URL || 'https://fastdealsgh.com/api/v2'; }
function available() { return Boolean(process.env.FASTDEALS_API_KEY); }

async function cachedVerified(phone) {
  const r = await pool.query('SELECT 1 FROM verified_numbers WHERE phone = $1', [phone]);
  return r.rowCount > 0;
}
async function remember(phone) {
  await pool.query('INSERT INTO verified_numbers (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING', [phone]);
}

// opts.fresh skips the remembered answers (used by the admin "check a number" tool).
async function checkNumber(phone, opts = {}) {
  if (!available()) return { status: 'unknown', reason: 'not_configured' };
  if (!opts.fresh) {
    if (await cachedVerified(phone).catch(() => false)) return { status: 'verified', cached: true };
    if ((negative.get(phone) || 0) > Date.now()) return { status: 'unverified', cached: true };
  }
  try {
    const res = await axios.post(baseUrl() + '/numbers/verify', { phone }, {
      headers: { Authorization: `Bearer ${process.env.FASTDEALS_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: Number(process.env.NUMBER_CHECK_TIMEOUT_MS || 4000),
    });
    const d = res.data && res.data.data;
    if (!res.data || res.data.success !== true || !d) return { status: 'unknown', reason: 'bad_response' };
    if (String(d.status || '').toLowerCase() === 'verified') {
      await remember(phone).catch(() => {});
      negative.delete(phone);
      return { status: 'verified', message: d.message || '' };
    }
    negative.set(phone, Date.now() + NEGATIVE_MS);
    return { status: 'unverified', message: d.message || '', detail: d.status || '' };
  } catch (err) {
    const code = err.response?.data?.error?.code || err.code || err.message;
    console.warn('Number check failed:', String(code).slice(0, 80));
    return { status: 'unknown', reason: String(code).slice(0, 60) };
  }
}

module.exports = { checkNumber, available };
