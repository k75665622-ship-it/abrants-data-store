/*
 * Chat with the store (services/chat.js).
 *   /api/chat/*         the website's "Chat with us" (no login needed). ?shop=<slug> (or "shop" in the body): inside an
 *                       agent's shop the chat is with that shop's agent.
 *   /api/admin/chat/*   Admin → Inbox (mounted after requireAdmin): chats with Abrants only
 *   The agent's side (their customers' chats) is in routes/agents.js: /api/agent/chats/*
 */
const express = require('express');
const chat = require('../services/chat');

const fail = (res, out) => res.status(out.status || 400).json({ error: out.error, field: out.field || undefined });
const wrap = (fn, msg) => async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { await fn(req, res); } catch (err) { console.error('Chat:', err.message); res.status(500).json({ error: msg }); }
};

/* ------------------------------------------------------------------ the website */
const pub = express.Router();

// On every page: is chat on, is someone there, anything unread? From memory.
pub.get('/hello', wrap(async (req, res) => { res.json(await chat.userHello(req, req.query.shop)); }, 'Could not load the chat.'));
pub.get('/open', wrap(async (req, res) => { res.json(await chat.userOpen(req, res, req.query.shop)); }, 'Could not open the chat.'));
pub.get('/poll', wrap(async (req, res) => { res.json(await chat.userPoll(req, req.query.after, req.query.shop)); }, 'Could not check for messages.'));
pub.post('/send', wrap(async (req, res) => {
  const out = await chat.userSend(req, res, req.body || {});
  if (out.error) return fail(res, out);
  res.json(out);
}, 'Could not send your message. Please try again.'));
pub.post('/seen', wrap(async (req, res) => { res.json(await chat.userSeen(req, (req.body && req.body.shop) || req.query.shop)); }, 'Could not save.'));

/* ------------------------------------------------------------------ Admin → Inbox */
function admin(audit) {
  const r = express.Router();
  r.get('/', wrap(async (req, res) => { res.json(chat.list(0)); }, 'Could not load the inbox.'));
  r.get('/unread', wrap(async (req, res) => { res.json({ unread: chat.unreadCount(0) }); }, 'Could not load.'));
  r.get('/settings', wrap(async (req, res) => { res.json(await chat.chatSettings()); }, 'Could not load.'));
  r.put('/settings', wrap(async (req, res) => {
    const out = await chat.saveChatSettings(req.body || {});
    if (out.error) return fail(res, out);
    const { changesOf } = require('../services/orderStore');
    await audit(req, 'chat.settings', { changes: changesOf({ chatEnabled: out.before.enabled, keepDays: out.before.keepDays }, { chatEnabled: out.settings.enabled, keepDays: out.settings.keepDays }) });
    res.json(out.settings);
  }, 'Could not save.'));
  r.get('/:id', wrap(async (req, res) => {
    const out = await chat.open(0, req.params.id, req.query.after);
    if (!out) return res.status(404).json({ error: 'Chat not found.' });
    res.json(out);
  }, 'Could not open the chat.'));
  r.get('/:id/about', wrap(async (req, res) => {
    const out = await chat.about(0, req.params.id);
    if (!out) return res.status(404).json({ error: 'Chat not found.' });
    res.json(out);
  }, 'Could not load the details.'));
  r.post('/:id/reply', wrap(async (req, res) => {
    const out = await chat.reply(0, req.params.id, req.body && req.body.text);
    if (out.error) return fail(res, out);
    res.json(out);
  }, 'Could not send the reply.'));
  r.post('/:id/seen', wrap(async (req, res) => {
    const out = await chat.markSeen(0, req.params.id);
    if (out.error) return fail(res, out);
    res.json(out);
  }, 'Could not save.'));
  r.post('/:id/status', wrap(async (req, res) => {
    const out = await chat.setStatus(0, req.params.id, req.body && req.body.status);
    if (out.error) return fail(res, out);
    res.json(out);
  }, 'Could not save.'));
  r.delete('/:id', wrap(async (req, res) => {
    const out = await chat.remove(0, req.params.id);
    if (out.error) return fail(res, out);
    await audit(req, 'chat.delete', { who: out.who });
    res.json({ ok: true });
  }, 'Could not delete the chat.'));
  return r;
}

/* ------------------------------------------------------------------ an agent's customers (mounted in routes/agents.js) */
function shopSide(router, requireAgent) {
  const me = (req) => req.agent.id;
  router.get('/chats', requireAgent, wrap(async (req, res) => { res.json(chat.list(me(req))); }, 'Could not load your chats.'));
  router.get('/chats/unread', requireAgent, wrap(async (req, res) => { res.json({ unread: chat.unreadCount(me(req)) }); }, 'Could not load.'));
  router.get('/chats/:id', requireAgent, wrap(async (req, res) => {
    const out = await chat.open(me(req), req.params.id, req.query.after);
    if (!out) return res.status(404).json({ error: 'Chat not found.' });
    res.json(out);
  }, 'Could not open the chat.'));
  router.get('/chats/:id/about', requireAgent, wrap(async (req, res) => {
    const out = await chat.about(me(req), req.params.id);
    if (!out) return res.status(404).json({ error: 'Chat not found.' });
    res.json(out);
  }, 'Could not load the details.'));
  const act = (path, fn, msg) => router.post(path, requireAgent, wrap(async (req, res) => {
    const out = await fn(req);
    if (out.error) return fail(res, out);
    res.json(out);
  }, msg));
  act('/chats/:id/reply', (req) => chat.reply(me(req), req.params.id, req.body && req.body.text), 'Could not send the reply.');
  act('/chats/:id/seen', (req) => chat.markSeen(me(req), req.params.id), 'Could not save.');
  act('/chats/:id/status', (req) => chat.setStatus(me(req), req.params.id, req.body && req.body.status), 'Could not save.');
  router.delete('/chats/:id', requireAgent, wrap(async (req, res) => {
    const out = await chat.remove(me(req), req.params.id);
    if (out.error) return fail(res, out);
    res.json({ ok: true });
  }, 'Could not delete the chat.'));
}

module.exports = { pub, admin, shopSide };
