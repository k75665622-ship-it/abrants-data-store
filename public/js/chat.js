/* "Chat with us": a chat with the store on every page of the website, answered in Admin → Inbox.
   No login needed. A visitor gets a chat ID and keeps the chat in this browser; a logged-in customer or agent is
   shown to the store by name. The page checks for answers every few seconds while the chat is open, and now and then
   while it is closed; the server answers those checks from memory (services/chat.js). */
(function () {
  'use strict';
  if (window.__abrantsChat) return;
  window.__abrantsChat = true;

  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  function linkify(text) {
    return esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener nofollow">' + u + '</a>';
    });
  }
  function api(url, method, body) {
    return fetch(url, { method: method || 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.error || 'Something went wrong. Please try again.'); e.field = d.field; throw e; } return d; }); });
  }
  var clock = function (t) { return new Date(t).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', ''); };
  function dayOf(t) {
    var d = new Date(t), now = new Date();
    var start = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((start(now) - start(d)) / 864e5);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  var ICON_CHAT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 20.5l1.6-5.2A8.4 8.4 0 1 1 21 11.5z"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13"/><path d="m12 5 7 7-7 7"/></svg>';

  var st = { open: false, me: null, thread: null, msgs: [], lastId: 0, online: false, timer: null, sending: false, loaded: false };
  var el = {};

  function build() {
    var launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'cw-launch';
    launch.setAttribute('aria-haspopup', 'dialog');
    launch.setAttribute('aria-controls', 'cwPanel');
    launch.innerHTML = ICON_CHAT + '<span class="cw-launch-txt">Chat with us</span><i class="cw-dot" hidden></i>';
    var panel = document.createElement('section');
    panel.className = 'cw-panel';
    panel.id = 'cwPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'cwTitle');
    panel.innerHTML =
      '<header class="cw-head"><img class="cw-logo" src="/icon.svg" alt="" width="36" height="36" />' +
        '<div class="cw-head-txt"><strong id="cwTitle">Abrants support</strong><span class="cw-state" id="cwState"></span></div>' +
        '<button type="button" class="cw-x" id="cwClose" aria-label="Close the chat">×</button></header>' +
      '<p class="cw-who" id="cwWho" hidden></p>' +
      '<div class="cw-body" id="cwBody" aria-live="polite"></div>' +
      '<div class="cw-start" id="cwStart" hidden>' +
        '<div class="cw-chips" id="cwChips"></div>' +
        '<label class="cw-phone" id="cwPhoneRow" hidden><span>Phone number you used for the order (if it is about an order)</span>' +
          '<input id="cwPhone" type="tel" inputmode="numeric" maxlength="13" placeholder="0551234567" autocomplete="tel-national" /></label>' +
      '</div>' +
      '<p class="cw-err" id="cwErr" role="alert" hidden></p>' +
      '<form class="cw-form" id="cwForm" novalidate>' +
        '<label class="cw-sr" for="cwText">Your message</label>' +
        '<textarea id="cwText" rows="1" maxlength="1000" placeholder="Write a message" enterkeyhint="send"></textarea>' +
        '<button type="submit" class="cw-send" id="cwSend" aria-label="Send">' + ICON_SEND + '</button>' +
      '</form>';
    document.body.appendChild(launch);
    document.body.appendChild(panel);
    el = { launch: launch, panel: panel, dot: launch.querySelector('.cw-dot') };
    ['cwState', 'cwClose', 'cwWho', 'cwBody', 'cwStart', 'cwChips', 'cwPhoneRow', 'cwPhone', 'cwErr', 'cwForm', 'cwText', 'cwSend'].forEach(function (id) { el[id] = document.getElementById(id); });

    launch.addEventListener('click', open);
    el.cwClose.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && st.open) close(); });
    el.cwForm.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    el.cwText.addEventListener('input', grow);
    el.cwText.addEventListener('keydown', function (e) {
      // On a computer Enter sends (Shift+Enter for a new line); on a phone the keyboard's Enter makes a new line.
      if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); send(); }
    });
    el.cwChips.addEventListener('click', function (e) {
      var c = e.target.closest('.cw-chip');
      if (!c) return;
      el.cwText.value = c.dataset.say;
      grow(); el.cwText.focus();
      var end = el.cwText.value.length; el.cwText.setSelectionRange(end, end);
    });
    // Stay above the bars fixed to the bottom of some pages, and shrink to a round button while scrolling down.
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', function () {
      if (window.scrollY > 320) launch.classList.add('cw-mini'); else if (window.scrollY < 120) launch.classList.remove('cw-mini');
    }, { passive: true });
    setInterval(place, 1500);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(0); });
  }

  function place() {
    var lift = 0;
    ['.mobilebar', '.ag-nav', '.sp-owner'].forEach(function (sel) {
      var b = document.querySelector(sel);
      if (!b || b.hidden) return;
      var cs = getComputedStyle(b);
      if (cs.display === 'none' || cs.position !== 'fixed') return;
      var r = b.getBoundingClientRect();
      if (r.height && r.bottom >= window.innerHeight - 2) lift = Math.max(lift, window.innerHeight - r.top);
    });
    document.documentElement.style.setProperty('--cw-lift', lift + 'px');
  }
  function grow() {
    var t = el.cwText;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 120) + 'px';
  }

  /* ------------------------------------------------------------ drawing */
  function chips() {
    var agent = st.me && st.me.kind === 'agent';
    var list = agent
      ? ['A question about my shop', 'A question about my payout', 'A customer\'s order', 'Something else']
      : ['My data has not arrived', 'Help with a result checker', 'MTN AFA registration', 'Something else'];
    el.cwChips.innerHTML = list.map(function (t) {
      return '<button type="button" class="cw-chip" data-say="' + esc(t === 'Something else' ? '' : t + '. ') + '">' + esc(t) + '</button>';
    }).join('');
  }
  function state() {
    el.cwState.innerHTML = st.online ? '<i class="on"></i>Online now' : '<i></i>We reply here as soon as we can';
  }
  function who() {
    var m = st.me || {};
    var text = m.kind === 'agent' ? 'Chatting as your shop, ' + m.name
      : m.kind === 'customer' ? 'Chatting as ' + m.name
        : st.thread ? 'Your chat ID is ' + st.thread.code + '. This chat stays in this browser.' : '';
    el.cwWho.textContent = text;
    el.cwWho.hidden = !text;
  }
  function render() {
    var html = '', lastDay = '';
    var welcome = st.me && st.me.kind === 'agent'
      ? 'Hello! How can we help with your shop?'
      : 'Hello! How can we help? If it is about an order, tell us the phone number you used.';
    html += '<div class="cw-msg them cw-welcome"><p>' + esc(welcome) + '</p></div>';
    var mineLast = null;
    st.msgs.forEach(function (m) { if (!m.fromAdmin && !m.pending) mineLast = m; });
    st.msgs.forEach(function (m, i) {
      var day = m.at ? dayOf(m.at) : 'Today';
      if (day !== lastDay) { html += '<p class="cw-day">' + esc(day) + '</p>'; lastDay = day; }
      var next = st.msgs[i + 1];
      var tail = !next || next.fromAdmin !== m.fromAdmin || (next.at && m.at && new Date(next.at) - new Date(m.at) > 5 * 60000);
      var seen = m === mineLast && st.thread && st.thread.adminReadId >= m.id;
      html += '<div class="cw-msg ' + (m.fromAdmin ? 'them' : 'me') + (m.pending ? ' pending' : '') + (m.failed ? ' failed' : '') + '">' +
        '<p>' + linkify(m.text) + '</p>' +
        (tail ? '<span class="cw-time">' + (m.failed ? 'Not sent' : m.pending ? 'Sending…' : esc(clock(m.at)) + (seen ? ', seen' : '')) + '</span>' : '') +
        '</div>';
    });
    el.cwBody.innerHTML = html;
    el.cwBody.scrollTop = el.cwBody.scrollHeight;
    var first = !st.msgs.length;
    el.cwStart.hidden = !first;
    el.cwPhoneRow.hidden = !(first && (!st.me || st.me.kind === 'visitor'));
    who();
  }
  function badge(n) {
    el.dot.hidden = !n;
    el.dot.textContent = n > 9 ? '9+' : String(n || '');
    el.launch.setAttribute('aria-label', 'Chat with us' + (n ? ', ' + n + ' new message' + (n > 1 ? 's' : '') : ''));
  }

  /* ------------------------------------------------------------ talking to the server */
  function context() {
    var c = { page: location.pathname };
    try { var s = window.abrantsShop && window.abrantsShop(); if (s) c.shop = s; } catch (e) { /* none */ }
    try { var o = localStorage.getItem('abrants_last_order'); if (o) c.lastOrder = o; } catch (e) { /* private mode */ }
    return c;
  }
  function take(list) {
    var added = false;
    (list || []).forEach(function (m) {
      if (st.msgs.some(function (x) { return x.id === m.id; })) return;
      st.msgs.push(m); added = true;
      if (m.id > st.lastId) st.lastId = m.id;
    });
    st.msgs.sort(function (a, b) { return (a.pending ? 1e15 : a.id) - (b.pending ? 1e15 : b.id); });
    return added;
  }
  function seen() {
    if (st.thread && st.thread.unread) { st.thread.unread = 0; badge(0); api('/api/chat/seen', 'POST', {}).catch(function () { /* later */ }); }
  }

  function open() {
    st.open = true;
    el.panel.hidden = false;
    el.launch.hidden = true;
    document.documentElement.classList.add('cw-is-open');
    if (!st.loaded) el.cwBody.innerHTML = '<p class="cw-day">Loading…</p>';
    api('/api/chat/open').then(function (d) {
      st.loaded = true;
      st.me = d.me; st.thread = d.thread; st.online = d.online;
      st.msgs = []; st.lastId = 0; take(d.messages);
      chips(); state(); render(); seen();
    }).catch(function (err) { el.cwBody.innerHTML = '<p class="cw-day">' + esc(err.message) + '</p>'; });
    setTimeout(function () { el.cwText.focus(); }, 60);
    schedule(4000);
  }
  function close() {
    st.open = false;
    el.panel.hidden = true;
    el.launch.hidden = false;
    document.documentElement.classList.remove('cw-is-open');
    el.launch.focus();
    schedule(st.thread ? 45000 : 0);
  }

  function send() {
    var text = el.cwText.value.trim();
    if (!text || st.sending) return;
    el.cwErr.hidden = true;
    st.sending = true;
    var temp = { id: -Date.now(), fromAdmin: false, text: text, pending: true };
    st.msgs.push(temp); render();
    el.cwText.value = ''; grow();
    api('/api/chat/send', 'POST', { text: text, phone: el.cwPhone.value, context: context() }).then(function (d) {
      st.msgs = st.msgs.filter(function (m) { return m !== temp; });
      take([d.message]);
      st.thread = d.thread;
      el.cwPhone.value = '';
      render();
      schedule(4000);
    }).catch(function (err) {
      st.msgs = st.msgs.filter(function (m) { return m !== temp; });
      el.cwText.value = text; grow();
      el.cwErr.textContent = err.message; el.cwErr.hidden = false;
      if (err.field === 'phone') el.cwPhone.focus();
      render();
    }).then(function () { st.sending = false; });
  }

  function poll() {
    if (document.hidden) return schedule(st.open ? 4000 : 45000);
    if (!st.open) { // closed: only the number of new answers
      api('/api/chat/hello').then(function (h) { st.online = h.online; badge(h.unread); })
        .catch(function () { /* try again later */ }).then(function () { schedule(45000); });
      return;
    }
    api('/api/chat/poll?after=' + st.lastId).then(function (d) {
      st.online = d.online;
      if (d.thread) st.thread = d.thread;
      if (st.open) {
        state();
        if (take(d.messages)) render(); else if (d.thread) render();
        seen();
      }
    }).catch(function () { /* try again later */ }).then(function () { schedule(st.open ? 4000 : 45000); });
  }
  function schedule(ms) {
    clearTimeout(st.timer);
    if (!st.open && !st.thread) return; // nothing to check for yet
    st.timer = setTimeout(poll, ms);
  }

  function start() {
    api('/api/chat/hello').then(function (h) {
      if (!h.enabled) return;
      build();
      st.online = h.online;
      badge(h.unread);
      if (h.hasChat) { st.thread = { unread: h.unread, adminReadId: 0 }; schedule(45000); }
    }).catch(function () { /* the page works without chat */ });
  }
  window.abrantsOpenChat = function () { if (el.launch) open(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
