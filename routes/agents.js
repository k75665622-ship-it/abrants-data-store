/*
 * Agent programme API (see services/agents.js).
 *   /api/agent/*          the agent's own account: sign up, log in, prices, sales, payouts, MoMo details
 *   /api/shop/:slug       what a shop link shows (public, memory only); the page itself is /s/:slug (server.js)
 *   /api/admin/agents/*   Admin → Agents (mounted after requireAdmin)
 */
const express = require('express');
const agents = require('../services/agents');
const care = require('../services/agentCare');
const shop = require('../services/agentShop');
const { siteOrigin } = require('../services/siteUrl');

/* Small in-memory limiters (one server instance). */
const buckets = new Map();
function limit(key, windowMs, max) {
  return (req, res, next) => {
    const id = `${key}:${req.ip || 'x'}`; const now = Date.now();
    let b = buckets.get(id);
    if (!b || now >= b.reset) b = { n: 0, reset: now + windowMs };
    b.n += 1; buckets.set(id, b);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    if (b.n > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    next();
  };
}
// Failed logins per phone number too, so one number cannot be guessed at from many places.
const failures = new Map();
const lockedFor = (phone) => { const f = failures.get(phone); return f && f.n >= 6 && Date.now() < f.reset ? Math.ceil((f.reset - Date.now()) / 60000) : 0; };
function noteFailure(phone) {
  const now = Date.now(); let f = failures.get(phone);
  if (!f || now >= f.reset) f = { n: 0, reset: now + 15 * 60 * 1000 };
  f.n += 1; failures.set(phone, f);
  if (failures.size > 5000) for (const [k, v] of failures) if (v.reset <= now) failures.delete(k);
}

const shopUrl = (req, slug) => `${siteOrigin() || `${req.protocol}://${req.get('host')}`}/s/${slug}`;
const fail = (res, out) => res.status(out.status || 400).json({ error: out.error, field: out.field || undefined, key: out.key || undefined });

/* ================================================================ agent account */
const pub = express.Router();

function requireAgent(req, res, next) {
  req.agent = agents.agentFromRequest(req);
  if (!req.agent) return res.status(401).json({ error: 'Please log in.' });
  next();
}

pub.get('/programme', async (req, res) => {
  const s = await agents.settingsNow();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ open: s.enabled, autoApprove: s.autoApprove, networks: agents.NETWORKS, termsVersion: agents.TERMS_VERSION });
});

// Step 1: check the form and text a code to the phone (when SMS is set up).
pub.post('/register/code', limit('agent-code', 60 * 60 * 1000, 20), async (req, res) => {
  try {
    const out = await agents.startSignup(req.body);
    if (out.error) return fail(res, out);
    res.json(out);
  } catch (err) { console.error('Agent code error:', err.message); res.status(500).json({ error: 'Could not send the code. Please try again.' }); }
});

pub.post('/register', limit('agent-register', 60 * 60 * 1000, 20), async (req, res) => {
  try {
    const out = await agents.register(req.body);
    if (out.error) return fail(res, out);
    agents.setSession(res, out.agent);
    res.status(201).json({ agent: agents.publicAgent(out.agent) });
  } catch (err) { console.error('Agent register error:', err.message); res.status(500).json({ error: 'Could not create your agent account. Please try again.' }); }
});

pub.post('/login', limit('agent-login', 15 * 60 * 1000, 30), async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').replace(/\D/g, '').replace(/^233(\d{9})$/, '0$1');
    const wait = lockedFor(phone);
    if (wait) return res.status(429).json({ error: `Too many wrong passwords. Try again in ${wait} minute${wait === 1 ? '' : 's'}.` });
    const out = await agents.login(phone, req.body?.password);
    if (!out) { noteFailure(phone); return res.status(401).json({ error: 'Wrong phone number or password.' }); }
    if (out.blocked) return res.status(403).json({ error: 'This agent account is closed. Contact the store.' });
    failures.delete(phone);
    agents.setSession(res, out.agent);
    res.json({ agent: agents.publicAgent(out.agent) });
  } catch (err) { console.error('Agent login error:', err.message); res.status(500).json({ error: 'Could not log in. Please try again.' }); }
});

pub.post('/logout', (req, res) => { agents.clearSession(res); res.json({ ok: true }); });

pub.get('/me', requireAgent, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...(await agents.dashboard(req.agent)), shopUrl: shopUrl(req, req.agent.slug) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not load your shop.' }); }
});

pub.get('/sales', requireAgent, async (req, res) => {
  try { res.json(await agents.sales(req.agent.id, { limit: req.query.limit, offset: req.query.offset })); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not load your sales.' }); }
});

pub.put('/prices', requireAgent, limit('agent-prices', 60 * 1000, 30), async (req, res) => {
  try {
    const b = req.body || {};
    const show = b.hidden !== undefined || b.featured !== undefined ? { hidden: b.hidden, featured: b.featured } : null;
    const out = await agents.setAgentPrices(req.agent.id, b.prices, show);
    if (out.error) return fail(res, out);
    res.json({ products: await agents.agentProducts(out.agent) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save your prices.' }); }
});

pub.put('/profile', requireAgent, async (req, res) => {
  try {
    const out = await agents.updateProfile(req.agent.id, req.body || {});
    if (out.error) return fail(res, out);
    res.json({ agent: agents.publicAgent(out.agent) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save.' }); }
});

pub.post('/terms', requireAgent, async (req, res) => {
  try {
    const out = await agents.acceptTerms(req.agent.id);
    res.json({ agent: agents.publicAgent(out.agent) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save.' }); }
});

// Who is logged in, for the home page's "My shop" and the shop page. Memory only.
pub.get('/whoami', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const a = agents.agentFromRequest(req);
  if (!a) return res.status(401).json({ error: 'Please log in.' });
  const p = agents.publicAgent(a);
  res.json({ shopName: p.shopName, slug: p.slug, status: p.status, logo: p.logo, theme: p.theme, unread: p.unread, strikes: p.strikes,
    programmeOff: agents.offInfo(await agents.settingsNow()) });
});

// My shop: name, WhatsApp, about line, announcement, colour.
pub.put('/shop', requireAgent, limit('agent-shop', 60 * 1000, 30), async (req, res) => {
  try {
    const out = await shop.updateShop(req.agent.id, req.body || {});
    if (out.error) return fail(res, out);
    res.json({ agent: agents.publicAgent(out.agent) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save your shop.' }); }
});

// Logo or photo, as a data URL (the page shrinks it first). server.js lets this one request be bigger than the rest.
pub.post('/logo', requireAgent, limit('agent-logo', 60 * 60 * 1000, 30), async (req, res) => {
  try {
    const out = await shop.setLogo(req.agent.id, req.body && req.body.image);
    if (out.error) return fail(res, out);
    res.json({ agent: agents.publicAgent(out.agent) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save your picture.' }); }
});
pub.delete('/logo', requireAgent, async (req, res) => {
  try { res.json({ agent: agents.publicAgent((await shop.removeLogo(req.agent.id)).agent) }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not remove your picture.' }); }
});

pub.get('/messages', requireAgent, async (req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json(await care.messages(req.agent.id, { limit: 60 })); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not load your messages.' }); }
});
pub.post('/messages/read', requireAgent, async (req, res) => {
  try { await care.markRead(req.agent.id); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Could not save.' }); }
});

// Delete my shop (Settings). Closed at once; deleted when nothing is owed any more.
pub.post('/delete', requireAgent, limit('agent-delete', 15 * 60 * 1000, 10), async (req, res) => {
  try {
    const out = await care.selfDelete(req.agent.id, req.body && req.body.password);
    if (out.error) return fail(res, out);
    agents.clearSession(res);
    res.json(out);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not delete your shop.' }); }
});

pub.put('/momo', requireAgent, limit('agent-momo', 15 * 60 * 1000, 10), async (req, res) => {
  try {
    const out = await agents.updateMomo(req.agent.id, req.body || {});
    if (out.error) return fail(res, out);
    res.json({ agent: agents.publicAgent(out.agent) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save your MoMo details.' }); }
});

pub.put('/password', requireAgent, limit('agent-password', 15 * 60 * 1000, 10), async (req, res) => {
  try {
    const out = await agents.changePassword(req.agent.id, req.body?.current, req.body?.next);
    if (out.error) return res.status(400).json({ error: out.error });
    agents.setSession(res, out.agent); // the old session is tied to the old password
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not change your password.' }); }
});

/* ================================================================ shop link (public) */
async function shopInfo(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const { a, open, owner, off } = await shop.shopFor(req, req.params.slug);
  res.json(shop.view(a, { open, owner, off }));
}

/* ================================================================ admin */
function admin(audit) {
  const r = express.Router();
  const wrap = (fn, msg) => async (req, res) => { try { await fn(req, res); } catch (err) { console.error(err); res.status(500).json({ error: msg }); } };
  const base = (req) => siteOrigin() || `${req.protocol}://${req.get('host')}`;

  r.get('/', wrap(async (req, res) => { res.json({ ...(await agents.overview()), siteUrl: base(req) }); }, 'Could not load agents.'));

  r.put('/settings', wrap(async (req, res) => {
    const before = await agents.settingsNow();
    const out = await agents.saveProgramme(req.body);
    if (out.error) return fail(res, out);
    const { prices: a, ...was } = before; const { prices: b, ...now } = out.settings; // eslint-disable-line no-unused-vars
    await audit(req, 'agents.settings', { changes: require('../services/orderStore').changesOf(was, now) });
    res.json(out.settings);
  }, 'Could not save.'));

  r.put('/prices', wrap(async (req, res) => {
    const out = await agents.setBasePrices(req.body && req.body.prices);
    if (out.error) return fail(res, out);
    await audit(req, 'agents.prices', out.prices);
    res.json(out);
  }, 'Could not save agent prices.'));

  r.get('/payouts', wrap(async (req, res) => { res.json(await agents.payouts({ limit: 100 })); }, 'Could not load payouts.'));

  r.post('/payouts/run', wrap(async (req, res) => {
    const method = req.body && req.body.method;
    const results = await agents.payAllDue({ trigger: 'admin', method: ['manual', 'paystack'].includes(method) ? method : undefined });
    await audit(req, 'agents.pay_all', { method: method || 'default', count: results.filter((x) => x.payout).length });
    res.json({ results });
  }, 'Could not run payouts.'));

  r.post('/payouts/:id/otp', wrap(async (req, res) => {
    const out = await agents.submitOtp(req.params.id, req.body && req.body.otp);
    if (out.error) return fail(res, out);
    await audit(req, 'agents.payout_otp', { id: Number(req.params.id), status: out.payout && out.payout.status });
    res.json(out.payout);
  }, 'Could not send the code.'));

  r.post('/payouts/:id/check', wrap(async (req, res) => {
    const out = await agents.checkPayout(req.params.id);
    if (out.error) return fail(res, out);
    res.json(out.payout);
  }, 'Could not check the payout.'));

  r.post('/payouts/:id/mark', wrap(async (req, res) => {
    const out = await agents.markPayout(req.params.id, req.body && req.body.status, req.body && req.body.note);
    if (out.error) return fail(res, out);
    await audit(req, 'agents.payout_mark', { id: Number(req.params.id), status: out.payout.status });
    res.json(out.payout);
  }, 'Could not update the payout.'));

  r.get('/balance', wrap(async (req, res) => {
    try { res.json({ balances: await require('../services/paystack').getBalance() }); }
    catch (err) { res.status(502).json({ error: String(err.response?.data?.message || 'Could not reach Paystack.').slice(0, 160) }); }
  }, 'Could not check the balance.'));

  r.get('/:id', wrap(async (req, res) => {
    const d = await agents.agentDetail(req.params.id);
    if (!d) return res.status(404).json({ error: 'Agent not found.' });
    res.json({ ...d, shopUrl: `${base(req)}/s/${d.agent.slug}` });
  }, 'Could not load the agent.'));

  r.post('/:id/status', wrap(async (req, res) => {
    const status = String(req.body?.status || '');
    if (!['active', 'suspended', 'rejected'].includes(status)) return res.status(400).json({ error: 'Choose approve, suspend or close.' });
    const cur = agents.getAgent(req.params.id);
    if (cur && cur.deleteRequestedAt) return res.status(409).json({ error: 'This shop is being deleted.' });
    const a = await agents.setStatus(req.params.id, status);
    if (!a) return res.status(404).json({ error: 'Agent not found.' });
    await audit(req, 'agents.status', { id: a.id, shop: a.shopName, status, from: cur ? cur.status : null });
    res.json(agents.publicAgent(a));
  }, 'Could not change the agent.'));

  // The inbox, strikes, pausing for a set time and deleting (services/agentCare.js).
  const careRoute = (name, fn, msg) => r.post(name, wrap(async (req, res) => {
    const out = await fn(req);
    if (out.error) return fail(res, out);
    res.json(out);
  }, msg));
  careRoute('/message-all', async (req) => {
    const out = await care.messageAll({ text: req.body?.text, sms: req.body?.sms === true });
    if (!out.error) await audit(req, 'agents.message_all', { sent: out.sent, sms: req.body?.sms === true });
    return out;
  }, 'Could not send the message.');
  careRoute('/:id/message', async (req) => {
    const out = await care.sendMessage(req.params.id, { text: req.body?.text, sms: req.body?.sms !== false });
    if (!out.error) await audit(req, 'agents.message', { id: Number(req.params.id) });
    return out;
  }, 'Could not send the message.');
  careRoute('/:id/strike', async (req) => {
    const out = await care.strike(req.params.id, { reason: req.body?.reason, sms: req.body?.sms !== false });
    if (!out.error) await audit(req, 'agents.strike', { id: Number(req.params.id), strikes: out.strikes });
    return out;
  }, 'Could not give the strike.');
  careRoute('/:id/strikes/:mid/remove', async (req) => {
    const out = await care.removeStrike(req.params.id, req.params.mid);
    if (!out.error) await audit(req, 'agents.strike_removed', { id: Number(req.params.id), message: Number(req.params.mid) });
    return out;
  }, 'Could not remove the strike.');
  careRoute('/:id/pause', async (req) => {
    const out = await care.pause(req.params.id, { reason: req.body?.reason, days: req.body?.days, sms: req.body?.sms !== false });
    if (out.error) return out;
    await audit(req, 'agents.pause', { id: Number(req.params.id), days: Number(req.body?.days) });
    return { agent: agents.publicAgent(out.agent) };
  }, 'Could not pause the shop.');
  careRoute('/:id/delete', async (req) => {
    const out = await care.remove(req.params.id, { by: 'admin', reason: req.body?.reason, pay: req.body?.pay !== false, block: req.body?.block === true });
    if (!out.error) await audit(req, 'agents.delete', { id: Number(req.params.id), pay: req.body?.pay !== false, block: req.body?.block === true, deleted: out.deleted });
    return out;
  }, 'Could not delete the shop.');
  careRoute('/:id/remove-logo', async (req) => {
    if (!agents.getAgent(req.params.id)) return { error: 'Agent not found.', status: 404 };
    await shop.removeLogo(Number(req.params.id));
    await audit(req, 'agents.remove_logo', { id: Number(req.params.id) });
    return { ok: true };
  }, 'Could not remove the picture.');

  r.post('/:id/note', wrap(async (req, res) => {
    const a = await agents.setNote(req.params.id, req.body?.note);
    if (!a) return res.status(404).json({ error: 'Agent not found.' });
    await audit(req, 'agents.note', { id: a.id });
    res.json({ ok: true });
  }, 'Could not save the note.'));

  r.post('/:id/reset-password', wrap(async (req, res) => {
    const temp = await agents.resetPassword(req.params.id);
    if (!temp) return res.status(404).json({ error: 'Agent not found.' });
    await audit(req, 'agents.reset_password', { id: Number(req.params.id) });
    res.json({ password: temp });
  }, 'Could not reset the password.'));

  r.post('/:id/payout', wrap(async (req, res) => {
    const method = req.body && req.body.method;
    const out = await agents.createPayout(req.params.id, { method, note: req.body && req.body.note, trigger: 'admin', ignoreMinimum: true });
    if (out.error) return fail(res, out);
    await audit(req, 'agents.payout', { id: Number(req.params.id), payout: out.payout.id, method, status: out.payout.status, sent: out.payout.sentGHS });
    res.json(out.payout);
  }, 'Could not pay the agent.'));

  return r;
}

module.exports = { pub, shopInfo, admin };
