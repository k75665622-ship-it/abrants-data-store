/* Abrants Admin — Inbox: chats from the website's "Chat with us". The list and the open chat refresh every few
   seconds while the Inbox is on screen; elsewhere in Admin only the unread count is checked (from memory). */
(function () {
  'use strict';
  var $ = function (sel) { return document.querySelector(sel); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var money = function (v) { return 'GH₵' + Number(v || 0).toFixed(2); };
  function linkify(text) {
    return esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener nofollow">' + u + '</a>'; });
  }
  function api(url, method, body) {
    return fetch(url, { method: method || 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        if (res.status === 401) { location.reload(); throw new Error('Session expired.'); }
        return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok) throw new Error(d.error || 'Request failed.'); return d; });
      });
  }
  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div>';
    $('#toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }
  var clock = function (t) { return new Date(t).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', ''); };
  function ago(t) {
    var s = (Date.now() - new Date(t).getTime()) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    var d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return clock(t);
    if (s < 6 * 86400) return d.toLocaleDateString('en-GB', { weekday: 'short' });
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function dayOf(t) {
    var d = new Date(t), now = new Date();
    var start = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((start(now) - start(d)) / 864e5);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  var KIND = { agent: 'Agent', customer: 'Customer', visitor: 'Visitor' };
  var ORDER = { paid: 'Paid', processing: 'On its way', fulfilled: 'Delivered', delivery_failed: 'Failed', delivery_review: 'To check',
    refunding: 'Refunding', refunded: 'Refunded', completed: 'Done', submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected', failed: 'Failed', sending: 'Sending' };
  var QUICK = [
    'Please send me the phone number you used for the order.',
    'Thank you. Let me check your order now.',
    'Your bundle has been delivered. Please restart your phone or check your data balance.',
    'We have refunded you. It can take a few days to reach your MoMo or card.',
    'Is there anything else we can help with?',
  ];
  function initials(name) { return String(name || '').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?'; }
  function avatar(t) {
    return '<span class="ib-av ib-av-' + esc(t.kind) + '" aria-hidden="true">' + (t.logo ? '<img src="' + esc(t.logo) + '" alt="" />' : esc(t.kind === 'visitor' ? t.code.slice(0, 2) : initials(t.name))) + '</span>';
  }

  var st = { list: [], filter: 'all', q: '', openId: null, msgs: [], lastId: 0, thread: null, about: null, visible: false, listTimer: null, threadTimer: null, badgeTimer: null };

  /* ------------------------------------------------------------ list */
  function renderList() {
    var q = st.q.toLowerCase();
    var items = st.list.filter(function (t) {
      if (st.filter === 'done') { if (t.status !== 'done') return false; }
      else if (t.status === 'done' && st.filter !== 'all') return false;
      if (st.filter === 'unread' && !t.unread) return false;
      if (['agent', 'customer', 'visitor'].indexOf(st.filter) !== -1 && t.kind !== st.filter) return false;
      return !q || (t.name + ' ' + t.sub + ' ' + t.code + ' ' + t.lastText).toLowerCase().indexOf(q) !== -1;
    });
    $('#ibList').innerHTML = items.length ? items.map(function (t) {
      return '<button type="button" class="ib-item' + (t.id === st.openId ? ' active' : '') + (t.unread ? ' unread' : '') + (t.status === 'done' ? ' done' : '') + '" data-ib-open="' + t.id + '">' +
        avatar(t) +
        '<span class="ib-item-main"><span class="ib-item-top"><strong>' + esc(t.name) + '</strong><time>' + esc(ago(t.lastAt)) + '</time></span>' +
        '<span class="ib-item-bottom"><span class="ib-kind ib-kind-' + esc(t.kind) + '">' + esc(KIND[t.kind]) + '</span><span class="ib-prev">' + (t.lastFromAdmin ? 'You: ' : '') + esc(t.lastText) + '</span>' +
        (t.unread ? '<i class="ib-unread">' + t.unread + '</i>' : '') + '</span></span></button>';
    }).join('') : '<div class="ib-none small"><strong>' + (st.list.length ? 'No chats here' : 'No chats yet') + '</strong><p>' +
      (st.list.length ? 'Try another filter.' : 'When someone writes from the website, it shows here.') + '</p></div>';
  }
  function loadList() {
    return api('/api/admin/chat').then(function (d) { st.list = d.threads; renderList(); badge(d.unread); })
      .catch(function (err) { $('#ibList').innerHTML = '<p class="notice bad">' + esc(err.message) + '</p>'; });
  }
  function badge(n) {
    ['#chatBadge', '#chatBadgeM'].forEach(function (s) { var b = $(s); if (b) { b.textContent = n; b.classList.toggle('hidden', !n); } });
    document.title = (n ? '(' + n + ') ' : '') + document.title.replace(/^\(\d+\) /, '');
  }

  /* ------------------------------------------------------------ one chat */
  function renderThread() {
    var t = st.thread;
    if (!t) return;
    var mineLast = null;
    st.msgs.forEach(function (m) { if (m.fromAdmin) mineLast = m; });
    var lastDay = '', html = '';
    st.msgs.forEach(function (m, i) {
      var day = dayOf(m.at);
      if (day !== lastDay) { html += '<p class="ib-day">' + esc(day) + '</p>'; lastDay = day; }
      var next = st.msgs[i + 1];
      var tail = !next || next.fromAdmin !== m.fromAdmin || new Date(next.at) - new Date(m.at) > 5 * 60000;
      html += '<div class="ib-msg ' + (m.fromAdmin ? 'mine' : 'theirs') + '"><p>' + linkify(m.text) + '</p>' +
        (tail ? '<span>' + esc(clock(m.at)) + (m === mineLast && t.userReadId >= m.id ? ', seen' : '') + '</span>' : '') + '</div>';
    });
    var box = $('#ibMsgs');
    var atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = html || '<p class="ib-day">No messages</p>';
    if (atEnd || box.dataset.first !== '0') { box.scrollTop = box.scrollHeight; box.dataset.first = '0'; }
  }
  function aboutHtml(a) {
    if (!a) return '<div class="skeleton-row"></div>';
    var rows = [];
    if (a.agent) {
      rows.push(['Shop', esc(a.agent.shopName) + ' <button type="button" class="btn btn-ghost btn-sm" data-ib-agent="' + a.agent.id + '">Open in Agents</button>']);
      rows.push(['Shop status', esc({ active: 'Open', pending: 'Waiting for approval', suspended: 'Paused', rejected: 'Closed', deleted: 'Deleted' }[a.agent.status] || a.agent.status) + (a.agent.strikes ? ', ' + a.agent.strikes + ' strike' + (a.agent.strikes > 1 ? 's' : '') : '')]);
    }
    if (a.phone) rows.push(['Phone', '<a href="tel:' + esc(a.phone) + '">' + esc(a.phone) + '</a>']);
    if (a.email) rows.push(['Email', '<a href="mailto:' + esc(a.email) + '">' + esc(a.email) + '</a>']);
    rows.push(['Chat ID', esc(a.code)]);
    var PAGES = { '/': 'the home page', '/index.html': 'the home page', '/services.html': 'the checkers and AFA page', '/order-status.html': 'the order page',
      '/account.html': 'their account page', '/agent.html': 'their agent page' };
    if (a.context && a.context.shop) rows.push(['Wrote from', 'the agent shop /s/' + esc(a.context.shop)]);
    else if (a.context && a.context.page) rows.push(['Wrote from', esc(PAGES[a.context.page] || a.context.page)]);
    if (a.context && a.context.lastOrder && !(a.orders || []).some(function (o) { return o.reference === a.context.lastOrder; })) rows.push(['Last order', esc(a.context.lastOrder)]);
    var orders = (a.orders || []).map(function (o) {
      return '<li><b>' + esc(o.what) + '</b> for ' + esc(o.phone) + ', ' + money(o.priceGHS) + '<br><span class="ib-ostate ' + esc(o.status) + '">' + esc(ORDER[o.status] || o.status) + '</span> ' +
        '<small>' + esc(o.reference) + ' · ' + esc(new Date(o.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })) + '</small></li>';
    }).join('');
    return '<dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>' +
      '<h4>' + (orders ? 'Their latest orders' : 'No orders found') + '</h4>' + (orders ? '<ul class="ib-orders">' + orders + '</ul>' :
        '<p class="muted">' + (a.phone ? 'None for ' + esc(a.phone) + '.' : 'Ask for the phone number they used; you can then search it in Orders.') + '</p>');
  }
  function openThread(id) {
    st.openId = Number(id);
    st.msgs = []; st.lastId = 0; st.about = null;
    var t = st.list.filter(function (x) { return x.id === st.openId; })[0];
    st.thread = t || null;
    $('#ib').classList.add('reading');
    $('#ibThread').innerHTML =
      '<header class="ib-head"><button type="button" class="ib-back" data-ib-back aria-label="Back to all chats">‹</button>' +
        (t ? avatar(t) : '') + '<div class="ib-head-txt"><strong>' + esc(t ? t.name : '') + '</strong><small>' + esc(t ? KIND[t.kind] + (t.sub ? ', ' + t.sub : '') : '') + '</small></div>' +
        '<div class="ib-head-actions"><button type="button" class="btn btn-ghost btn-sm" data-ib-about aria-expanded="false">About</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-ib-done>' + (t && t.status === 'done' ? 'Reopen' : 'Mark done') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-ib-delete aria-label="Delete this chat">Delete</button></div></header>' +
      '<div class="ib-about" id="ibAbout" hidden></div>' +
      '<div class="ib-msgs" id="ibMsgs" data-first="1"><div class="skeleton-row"></div></div>' +
      '<div class="ib-quick" id="ibQuick">' + QUICK.map(function (q, i) { return '<button type="button" class="chip" data-ib-quick="' + i + '">' + esc(q) + '</button>'; }).join('') + '</div>' +
      '<form class="ib-reply" id="ibReply"><textarea id="ibText" rows="1" maxlength="1000" placeholder="Write a reply" aria-label="Your reply"></textarea>' +
        '<button type="submit" class="btn btn-primary" id="ibSend">Send</button></form>';
    renderList();
    api('/api/admin/chat/' + st.openId).then(function (d) {
      st.thread = d.thread; take(d.messages); renderThread(); seen();
    }).catch(function (err) { $('#ibMsgs').innerHTML = '<p class="notice bad">' + esc(err.message) + '</p>'; });
    api('/api/admin/chat/' + st.openId + '/about').then(function (a) { st.about = a; if (!$('#ibAbout').hidden) $('#ibAbout').innerHTML = aboutHtml(a); })
      .catch(function () { /* optional */ });
    if (!matchMedia('(pointer:coarse)').matches) setTimeout(function () { var x = $('#ibText'); if (x) x.focus(); }, 50);
    pollThread(4000);
  }
  function take(list) {
    var added = false;
    (list || []).forEach(function (m) {
      if (st.msgs.some(function (x) { return x.id === m.id; })) return;
      st.msgs.push(m); added = true;
      if (m.id > st.lastId) st.lastId = m.id;
    });
    st.msgs.sort(function (a, b) { return a.id - b.id; });
    return added;
  }
  function seen() {
    var t = st.list.filter(function (x) { return x.id === st.openId; })[0];
    if (!t || !t.unread) return;
    t.unread = 0; renderList();
    api('/api/admin/chat/' + st.openId + '/seen', 'POST').then(loadList).catch(function () { /* later */ });
  }
  function pollThread(ms) {
    clearTimeout(st.threadTimer);
    if (!st.openId || !st.visible) return;
    st.threadTimer = setTimeout(function () {
      if (document.hidden) return pollThread(4000);
      api('/api/admin/chat/' + st.openId + '?after=' + st.lastId).then(function (d) {
        var changed = take(d.messages) || (st.thread && d.thread.userReadId !== st.thread.userReadId);
        st.thread = d.thread;
        if (changed) { renderThread(); seen(); }
      }).catch(function () { /* next time */ }).then(function () { pollThread(4000); });
    }, ms);
  }
  function reply() {
    var box = $('#ibText'), text = box.value.trim(), btn = $('#ibSend');
    if (!text) return;
    btn.disabled = true;
    api('/api/admin/chat/' + st.openId + '/reply', 'POST', { text: text }).then(function (d) {
      box.value = ''; grow(box);
      take([d.message]); renderThread();
      return loadList();
    }).catch(function (err) { toast(err.message, 'error'); }).then(function () { btn.disabled = false; box.focus(); });
  }
  function grow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }

  /* ------------------------------------------------------------ events */
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#section-inbox')) return;
    var t;
    if ((t = e.target.closest('[data-ib-open]'))) { openThread(t.getAttribute('data-ib-open')); return; }
    if ((t = e.target.closest('[data-ib-filter]'))) {
      st.filter = t.getAttribute('data-ib-filter');
      Array.prototype.forEach.call(document.querySelectorAll('[data-ib-filter]'), function (c) { c.classList.toggle('active', c === t); });
      renderList(); return;
    }
    if (e.target.closest('[data-ib-back]')) { $('#ib').classList.remove('reading'); st.openId = null; clearTimeout(st.threadTimer); renderList(); return; }
    if ((t = e.target.closest('[data-ib-about]'))) {
      var ab = $('#ibAbout'); ab.hidden = !ab.hidden; t.setAttribute('aria-expanded', String(!ab.hidden));
      if (!ab.hidden) ab.innerHTML = aboutHtml(st.about);
      return;
    }
    if ((t = e.target.closest('[data-ib-quick]'))) {
      var box = $('#ibText'); box.value = (box.value ? box.value.trim() + ' ' : '') + QUICK[Number(t.getAttribute('data-ib-quick'))]; grow(box); box.focus(); return;
    }
    if ((t = e.target.closest('[data-ib-done]'))) {
      var to = st.thread && st.thread.status === 'done' ? 'open' : 'done';
      api('/api/admin/chat/' + st.openId + '/status', 'POST', { status: to }).then(function (d) {
        st.thread = d.thread; t.textContent = to === 'done' ? 'Reopen' : 'Mark done';
        toast(to === 'done' ? 'Marked done. It opens again if they write.' : 'Reopened.', 'success'); return loadList();
      }).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    if (e.target.closest('[data-ib-delete]')) {
      if (!confirm('Delete this chat and all its messages? This cannot be undone.')) return;
      api('/api/admin/chat/' + st.openId, 'DELETE').then(function () {
        toast('Chat deleted.', 'success'); st.openId = null; $('#ib').classList.remove('reading');
        $('#ibThread').innerHTML = '<div class="ib-none"><div>✉</div><strong>Choose a chat</strong></div>'; return loadList();
      }).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    if ((t = e.target.closest('[data-ib-agent]'))) {
      var id = t.getAttribute('data-ib-agent');
      var nav = document.querySelector('.side-link[data-section="agents"]') || document.querySelector('[data-section="agents"]');
      if (nav) nav.click();
      if (window.AbrantsAgents && window.AbrantsAgents.open) window.AbrantsAgents.open(id);
    }
  });
  document.addEventListener('submit', function (e) { if (e.target.id === 'ibReply') { e.preventDefault(); reply(); } });
  document.addEventListener('input', function (e) { if (e.target.id === 'ibText') grow(e.target); });
  document.addEventListener('keydown', function (e) {
    if (e.target.id === 'ibText' && e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); reply(); }
  });
  $('#ibSearch').addEventListener('input', function () { st.q = this.value.trim(); renderList(); });

  // Chat settings
  function loadSettings() {
    api('/api/admin/chat/settings').then(function (s) { $('#ibEnabled').checked = !!s.enabled; $('#ibKeep').value = String(s.keepDays); }).catch(function () { /* later */ });
  }
  function saveSettings(body) {
    api('/api/admin/chat/settings', 'PUT', body).then(function () { toast('Saved.', 'success'); }).catch(function (err) { toast(err.message, 'error'); loadSettings(); });
  }
  $('#ibEnabled').addEventListener('change', function () { saveSettings({ enabled: this.checked }); });
  $('#ibKeep').addEventListener('change', function () { saveSettings({ keepDays: Number(this.value) }); });

  /* ------------------------------------------------------------ refreshing */
  function pollList() {
    clearTimeout(st.listTimer);
    if (!st.visible) return;
    st.listTimer = setTimeout(function () { (document.hidden ? Promise.resolve() : loadList()).then(pollList); }, 6000);
  }
  // The unread count in the menu (quietly: before logging in the answer is simply "not logged in").
  function unreadNow() {
    return fetch('/api/admin/chat/unread', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) badge(d.unread); }).catch(function () { /* later */ });
  }
  function pollBadge() {
    clearTimeout(st.badgeTimer);
    st.badgeTimer = setTimeout(function () {
      if (st.visible || document.hidden) return pollBadge();
      unreadNow().then(pollBadge);
    }, 20000);
  }
  function visible(on) {
    st.visible = on;
    if (on) { loadList(); loadSettings(); pollList(); if (st.openId) pollThread(0); }
    else { clearTimeout(st.listTimer); clearTimeout(st.threadTimer); }
  }
  var started = false;
  function start() { if (started) return; started = true; unreadNow().then(pollBadge); }
  window.AbrantsInbox = { visible: visible, load: loadList, start: start };
})();
