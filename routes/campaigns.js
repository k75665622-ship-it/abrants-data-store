/*
 * Admin API for tracking links: /api/admin/links. Mounted after requireAdmin, so every route here is admin only.
 * The links themselves are built in the admin page (it knows the site's own address); this API
 * returns a relative path for each.
 */
const express = require('express');
const links = require('../services/campaigns');

function admin(audit) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    try { res.json(await links.stats(String(req.query.range || '30d'))); }
    catch (err) { console.error(err); res.status(500).json({ error: 'Could not load your links.' }); }
  });

  r.post('/', async (req, res) => {
    try {
      const b = req.body || {};
      const out = await links.createLink(b, b.code);
      if (out.error) return res.status(out.status || 400).json({ error: out.error });
      await audit(req, 'link.create', { code: out.link.code, name: out.link.name });
      res.status(201).json(out.link);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Could not make the link.' }); }
  });

  r.put('/:code', async (req, res) => {
    try {
      const out = await links.updateLink(req.params.code, req.body);
      if (out.error) return res.status(out.status || 400).json({ error: out.error });
      await audit(req, 'link.update', { code: out.link.code, name: out.link.name });
      res.json(out.link);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Could not save the link.' }); }
  });

  r.delete('/:code', async (req, res) => {
    try {
      if (!(await links.deleteLink(req.params.code))) return res.status(404).json({ error: 'That link no longer exists.' });
      await audit(req, 'link.delete', { code: req.params.code });
      res.json({ ok: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Could not delete the link.' }); }
  });

  return r;
}

module.exports = { admin };
