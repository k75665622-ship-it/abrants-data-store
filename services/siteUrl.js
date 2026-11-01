/*
 * The store's real public address, from the SITE_URL setting (for example https://abrantsdata.com).
 * Optional: when it is not set, nothing changes. Used so that links made in Admin always carry the real domain
 * and so that visitors who land on the Render address (abrants-data-store.onrender.com) are sent to it.
 */
function siteOrigin() {
  const raw = String(process.env.SITE_URL || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}

/**
 * Express middleware. A page visit (GET or HEAD, never /api, never a POST) that arrives on a *.onrender.com
 * address is sent to the real domain, keeping the path and the ?from= tag. Payment and delivery webhooks are POSTs
 * under /api, so they are never redirected. Render's own health check counts a redirect as healthy.
 */
function redirectToSite() {
  const origin = siteOrigin();
  if (!origin) {
    if (String(process.env.SITE_URL || '').trim()) console.warn('SITE_URL is set but is not a valid address (use https://yourdomain.com). Ignoring it.');
    return (req, res, next) => next();
  }
  const siteHost = new URL(origin).host.toLowerCase();
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/')) return next();
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== siteHost && /\.onrender\.com(:\d+)?$/.test(host)) return res.redirect(302, origin + req.originalUrl);
    next();
  };
}

module.exports = { siteOrigin, redirectToSite };
