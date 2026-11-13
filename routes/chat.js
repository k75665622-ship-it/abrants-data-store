/*
 * Chat with the store (services/chat.js).
 *   /api/chat/*         the website's "Chat with us" (no login needed)
 *   /api/admin/chat/*   Admin → Inbox (mounted after requireAdmin)
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
pub.get('/hello', wrap(async (req, res) => {
  const s = await chat.chatSettings();
  const p = await chat.userPoll(req, Number.MAX_SAFE_INTEGER);
  res.json({ enabled: s.enabled, online: p.online, unread: p.thread ? p.thread.unread : 0, hasChat: Boolean(p.thread) });
}, 'Could not load the chat.'));

pub.get('/open', wrap(async (req, res) => { res.json(await chat.userOpen(req, res)); }, 'Could not open the chat.'));
pub.get('/poll', wrap(async (req, res) => { res.json(await chat.userPoll(req, req.query.after)); }, 'Could not check for messages.'));
pub.post('/send', wrap(async (req, res) => {
  const out = await chat.userSend(req, res, req.body || {});
  if (out.error) return fail(res, out);
  res.json(out);
}, 'Could not send your message. Please try again.'));
pub.post('/seen', wrap(async (req, res) => { res.json(await chat.userSeen(req)); }, 'Could not save.'));

/* ------------------------------------------------------------------ Admin → Inbox */
function admin(audit) {
  const r = express.Router();
  r.get('/', wrap(async (req, res) => { res.json(chat.adminList()); }, 'Could not load the inbox.'));
  r.get('/unread', wrap(async (req, res) => { res.json({ unread: chat.adminUnread() }); }, 'Could not load.'));
  r.get('/settings', wrap(async (req, res) => { res.json(await chat.chatSettings()); }, 'Could not load.'));
  r.put('/settings', wrap(async (req, res) => {
    const out = await chat.saveChatSettings(req.body || {});
    if (out.error) return fail(res, out);
    const { changesOf } = require('../services/orderStore');
    await audit(req, 'chat.settings', { changes: changesOf({ chatEnabled: out.before.enabled, keepDays: out.before.keepDays }, { chatEnabled: out.settings.enabled, keepDays: out.settings.keepDays }) });
    res.json(out.settings);
  }, 'Could not save.'));
  r.get('/:id', wrap(async (req, res) => {
    const out = await chat.adminOpen(req.params.id, req.query.after);
    if (!out) return res.status(404).json({ error: 'Chat not found.' });
    res.json(out);
  }, 'Could not open the chat.'));
  r.get('/:id/about', wrap(async (req, res) => {
    const out = await chat.about(req.params.id);
    if (!out) return res.status(404).json({ error: 'Chat not found.' });
    res.json(out);
  }, 'Could not load the details.'));
  r.post('/:id/reply', wrap(async (req, res) => {
    const out = await chat.adminReply(req.params.id, req.body && req.body.text);
    if (out.error) return fail(res, out);
    res.json(out);
  }, 'Could not send the reply.'));
  r.post('/:id/seen', wrap(async (req, res) => {
    const out = await chat.adminSeen(req.params.id);
    if (out.error) return fail(res, out);
    res.json(out);
  }, 'Could not save.'));
  r.post('/:id/status', wrap(async (req, res) => {
    const out = await chat.setStatus(req.params.id, req.body && req.body.status);
    if (out.error) return fail(res, out);
    res.json(out);
  }, 'Could not save.'));
  r.delete('/:id', wrap(async (req, res) => {
    const out = await chat.remove(req.params.id);
    if (out.error) return fail(res, out);
    await audit(req, 'chat.delete', { who: out.who });
    res.json({ ok: true });
  }, 'Could not delete the chat.'));
  return r;
}

module.exports = { pub, admin };
