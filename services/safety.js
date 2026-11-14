/*
 * Keeps one bad request from taking the store down (README 21).
 *
 *  - Express 4 does not catch errors thrown inside async route handlers: the promise rejects, nobody handles it, and
 *    Node stops the whole server. asyncErrors() makes those errors go to Express like any other error, so the visitor
 *    gets an error answer and everyone else carries on.
 *  - noNullBytes(): the database refuses text with a "\0" character in it. Requests that contain one (in the address
 *    or in a JSON body) are turned away before any route sees them.
 *  - errorHandler(): the last stop for an error. API calls get a short JSON answer, never the error's details.
 *  - keepRunning(): an error nobody caught in background work is logged instead of stopping the server.
 */
const Layer = require('express/lib/router/layer');

let patched = false;
function asyncErrors() {
  if (patched) return;
  patched = true;
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // an error handler: not for normal requests
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.then(null, (err) => next(err || new Error('Request failed')));
    } catch (err) {
      next(err);
    }
  };
}

function hasNull(v, depth = 0) {
  if (typeof v === 'string') return v.includes('\u0000');
  if (!v || typeof v !== 'object' || depth > 20) return false;
  if (Buffer.isBuffer(v)) return false; // webhook bodies are checked by their signatures
  for (const k of Object.keys(v)) if (k.includes('\u0000') || hasNull(v[k], depth + 1)) return true;
  return false;
}

/** Turns away requests with a "\0" in the address or the JSON body. Runs after the body is parsed. */
function noNullBytes() {
  return (req, res, next) => {
    let url = req.originalUrl || req.url || '';
    if (/%00/.test(url) || url.includes('\u0000')) return refuse(req, res);
    if (req.body && !Buffer.isBuffer(req.body) && hasNull(req.body)) return refuse(req, res);
    next();
  };
}
function refuse(req, res) {
  if (String(req.originalUrl || '').startsWith('/api/')) return res.status(400).json({ error: 'That contains a character we cannot accept.' });
  res.status(400).type('text/plain').send('Bad request');
}

/** The last error handler: a short answer, never the details. */
function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = Number(err && (err.status || err.statusCode));
    const known = status >= 400 && status < 500;
    if (!known) console.error('Request error:', req.method, req.path, err && (err.stack || err.message || err));
    if (res.headersSent) return res.end();
    const code = known ? status : 500;
    if (String(req.originalUrl || '').startsWith('/api/')) {
      const error = code === 413 ? 'That is too much to send at once.'
        : code === 400 ? 'Something in that request was not right. Please try again.'
          : known ? 'That request was refused.' : 'Something went wrong. Please try again.';
      return res.status(code).json({ error });
    }
    res.status(code).type('text/plain').send(known ? 'Bad request' : 'Something went wrong. Please try again.');
  };
}

let watching = false;
function keepRunning() {
  if (watching) return;
  watching = true;
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled error (the store keeps running):', err && (err.stack || err.message || err));
  });
}

module.exports = { asyncErrors, noNullBytes, errorHandler, keepRunning, hasNull };
