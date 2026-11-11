/*
 * Keeps the store awake on Render's free plan.
 *
 * A free Render web service is put to sleep after 15 minutes without a visitor. The next visitor then waits
 * about a minute on Render's loading screen, and while the store sleeps it cannot answer DataHustle's
 * delivery updates (they are lost: see pollProviderOrders in services/fulfillment.js).
 *
 * So every 10 minutes the store asks for one tiny page of its own (/api/ping) through its public address.
 * Render sees a visit and does not put it to sleep. The page is answered from memory: it never touches the
 * database, so the database can still sleep (README 19).
 *
 * It cannot wake a store that is already asleep (nothing runs then). The first visitor does that, and from
 * then on the store stays awake. On a paid plan it changes nothing. Switch it off with KEEP_AWAKE=false.
 */
const axios = require('axios');
const { siteOrigin } = require('./siteUrl');

const EVERY_MS = 10 * 60 * 1000;

// Render gives every web service RENDER_EXTERNAL_URL (https://name.onrender.com). KEEP_AWAKE_URL overrides it.
function pingUrl() {
  if (String(process.env.KEEP_AWAKE || '').trim().toLowerCase() === 'false') return null;
  const raw = String(process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL || siteOrigin() || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? u.origin + '/api/ping' : null;
  } catch { return null; }
}

let failures = 0;
async function ping(url) {
  try {
    const res = await axios.get(url, { timeout: 15000, maxRedirects: 0, validateStatus: () => true, headers: { 'User-Agent': 'abrants-keep-awake' } });
    if (res.status !== 200) throw new Error('status ' + res.status);
    failures = 0;
    return true;
  } catch (err) {
    failures += 1;
    // One warning when it starts failing, then one a day: never a line in the logs every 10 minutes.
    if (failures === 1 || failures % 144 === 0) console.warn('Keep-awake ping failed (' + (err.message || err) + '). The store may go to sleep on the free plan.');
    return false;
  }
}

function startKeepAwake(everyMs = EVERY_MS, retryMs = 60 * 1000) {
  const url = pingUrl();
  if (!url) return null;
  // Render sleeps a store after 15 quiet minutes, so one missed request must not cost the whole gap: a failed
  // one is tried again a minute later.
  const timer = setInterval(() => {
    ping(url).then((ok) => { if (!ok) setTimeout(() => { ping(url); }, retryMs).unref(); });
  }, everyMs);
  timer.unref();
  console.log('Keep-awake is on: one small request every ' + Math.round(everyMs / 60000) + ' minutes to ' + url);
  return timer;
}

module.exports = { startKeepAwake, pingUrl, ping };
