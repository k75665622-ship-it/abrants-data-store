/* The agent's customers: chats from "Chat with us" inside their shop (agent page → Inbox → Customers).
   Their customers' chats are theirs; Abrants does not see them. The list and the open chat refresh every few seconds
   while on screen; otherwise only the unread count is checked (the server answers from memory). */
(function () {
  'use strict';
  var Ag = window.Ag;
  var $ = Ag.$, esc = Ag.esc, api = Ag.api, toast = Ag.toast, money = Ag.money;
  function linkify(text) {
    return esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener nofollow">' + u + '</a>'; });
  }
  var clock = function (t) { return new Date(t).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', ''); };
  function ago(t) {
    var s = (Date.now() - new Date(t).getTime()) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    var d = new Date(t);
    if (d.toDateString() === new Date().toDateString()) return clock(t);
    return d.toLocaleDateString('en-GB', s < 6 * 86400 ? { weekday: 'short' } : { day: 'numeric', month: 'short' });
  }
  function dayOf(t) {
    var d = new Date(t), now = new Date();
    var start = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((start(now) - start(d)) / 864e5);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  var ORDER = { paid: 'Paid', processing: 'On its way', fulfilled: 'Delivered', delivery_failed: 'Failed', delivery_review: 'Being checked',
    refunding: 'Refunding', refunded: 'Refunded', completed: 'Done', submitted: 'Submitted', approved: 'Approved', rejected: 'Not approved', failed: 'Failed', sending: 'Sending' };
  var QUICK = [
    'Please send me the phone number you used for the order.',
    'Thank you. I am checking it now.',
    'Your bundle has been delivered. Please restart your phone or check your data balance.',
    'If it cannot be delivered, your money comes back to you automatically.',
  ];

  var st = { seg: 'customers', list: [], openId: null, msgs: [], lastId: 0, thread: null, about: null, unread: 0,
    listTimer: null, threadTimer: null, badgeTimer: null, active: false };
  var onScreen = function () { return st.active && st.seg === 'customers' && !$('pane-inbox').hidden && !$('dashView').hidden; };

  function setUnread(n) {
    st.unread = n;
    $('chatCount').hidden = !n;
    $('chatCount').textContent = n > 9 ? '9+' : String(n || '');
    if (window.AgDash && window.AgDash.chatBadge) window.AgDash.chatBadge(n);
  }

  /* ------------------------------------------------------------ list */
  function renderList() {
    if (st.openId) return;
    $('acList').innerHTML = st.list.length ? st.list.map(function (t) {
      return '<button type="button" class="ac-item' + (t.unread ? ' unread' : '') + (t.status === 'done' ? ' done' : '') + '" data-ac-open="' + t.id + '">' +
        '<span class="ac-av" aria-hidden="true">' + esc(t.kind === 'visitor' ? t.code.slice(0, 2) : String(t.name).charAt(0).toUpperCase()) + '</span>' +
        '<span class="ac-main"><span class="ac-top"><strong>' + esc(t.name) + '</strong><time>' + esc(ago(t.lastAt)) + '</time></span>' +
        '<span class="ac-prev">' + (t.lastFromAdmin ? 'You: ' : '') + esc(t.lastText) + '</span></span>' +
        (t.unread ? '<i class="ac-unread">' + t.unread + '</i>' : '') + '</button>';
    }).join('') : '<div class="empty-card"><strong>No chats yet</strong>When a customer taps "Chat with us" in your shop, their messages arrive here. Only you see them.</div>';
  }
  function loadList() {
    return api('/api/agent/chats').then(function (d) { st.list = d.threads; setUnread(d.unread); renderList(); })
      .catch(function (err) { if (!st.openId) $('acList').innerHTML = '<p class="ck-error">' + esc(err.message) + '</p>'; });
  }

  /* ------------------------------------------------------------ one chat */
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
  function renderMsgs() {
    var t = st.thread, box = $('acMsgs');
    if (!t || !box) return;
    var mineLast = null;
    st.msgs.forEach(function (m) { if (m.fromAdmin) mineLast = m; });
    var html = '', lastDay = '';
    st.msgs.forEach(function (m, i) {
      var day = dayOf(m.at);
      if (day !== lastDay) { html += '<p class="ac-day">' + esc(day) + '</p>'; lastDay = day; }
      var next = st.msgs[i + 1];
      var tail = !next || next.fromAdmin !== m.fromAdmin || new Date(next.at) - new Date(m.at) > 5 * 60000;
      html += '<div class="ac-msg ' + (m.fromAdmin ? 'mine' : 'theirs') + '"><p>' + linkify(m.text) + '</p>' +
        (tail ? '<span>' + esc(clock(m.at)) + (m === mineLast && t.userReadId >= m.id ? ', seen' : '') + '</span>' : '') + '</div>';
    });
    var atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = html;
    if (atEnd || box.dataset.first !== '0') { box.scrollTop = box.scrollHeight; box.dataset.first = '0'; }
  }
  function aboutHtml(a) {
    if (!a) return '<div class="skeleton" style="min-height:60px"></div>';
    var rows = [];
    if (a.phone) rows.push(['Phone', '<a href="tel:' + esc(a.phone) + '">' + esc(a.phone) + '</a>']);
    rows.push(['Chat ID', esc(a.code)]);
    var orders = (a.orders || []).map(function (o) {
      return '<li><b>' + esc(o.what) + '</b> for ' + esc(o.phone) + ', ' + money(o.priceGHS) + '<br><span class="chip ' + esc(o.status === 'fulfilled' || o.status === 'completed' || o.status === 'approved' ? 'delivered' : /fail|refund|reject/.test(o.status) ? 'failed' : 'on_the_way') + '">' +
        esc(ORDER[o.status] || o.status) + '</span> <small>' + esc(o.reference) + '</small></li>';
    }).join('');
    return '<dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>' +
      (orders ? '<h4>Their orders in your shop</h4><ul class="ac-orders">' + orders + '</ul>'
        : '<p>' + (a.phone ? 'No orders from ' + esc(a.phone) + ' in your shop.' : 'Ask for the phone number they used to see their order here.') + '</p>');
  }
  /* An open chat fills a phone's screen (and hides "Chat with us", which is the agent's own chat with Abrants). */
  function reading() {
    var on = !!(st.active && st.seg === 'customers' && st.openId);
    document.documentElement.classList.toggle('ac-reading', on);
    return on;
  }
  function openThread(id) {
    st.openId = Number(id);
    st.msgs = []; st.lastId = 0; st.about = null;
    var t = st.list.filter(function (x) { return x.id === st.openId; })[0] || null;
    st.thread = t;
    $('acList').hidden = true;
    var box = $('acThread');
    box.hidden = false;
    box.innerHTML =
      '<header class="ac-head"><button type="button" class="ac-back" data-ac-back aria-label="Back to all chats">‹</button>' +
        '<div class="ac-head-txt"><strong>' + esc(t ? t.name : '') + '</strong><small>' + esc(t && t.sub ? t.sub : (t ? 'Chat ID ' + t.code : '')) + '</small></div></header>' +
      '<div class="ac-actions"><button type="button" class="ag-flag" data-ac-about aria-expanded="false">About</button>' +
        '<button type="button" class="ag-flag" data-ac-done>' + (t && t.status === 'done' ? 'Reopen' : 'Mark done') + '</button>' +
        '<button type="button" class="ag-flag" data-ac-delete>Delete</button></div>' +
      '<div class="ac-about" id="acAbout" hidden></div>' +
      '<div class="ac-msgs" id="acMsgs" data-first="1"><div class="skeleton" style="min-height:80px"></div></div>' +
      '<div class="ac-quick">' + QUICK.map(function (q, i) { return '<button type="button" class="ag-flag" data-ac-quick="' + i + '">' + esc(q) + '</button>'; }).join('') + '</div>' +
      '<form class="ac-reply" id="acReply"><textarea id="acText" rows="1" maxlength="1000" placeholder="Write a reply" aria-label="Your reply"></textarea>' +
        '<button type="submit" class="ac-send" id="acSend" aria-label="Send"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13"/><path d="m12 5 7 7-7 7"/></svg></button></form>';
    api('/api/agent/chats/' + st.openId).then(function (d) { st.thread = d.thread; take(d.messages); renderMsgs(); seen(); })
      .catch(function (err) { $('acMsgs').innerHTML = '<p class="ck-error">' + esc(err.message) + '</p>'; });
    api('/api/agent/chats/' + st.openId + '/about').then(function (a) { st.about = a; if (!$('acAbout').hidden) $('acAbout').innerHTML = aboutHtml(a); })
      .catch(function () { /* optional */ });
    pollThread(4000);
    if (reading() && matchMedia('(min-width:900px)').matches) $('pane-inbox').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function closeThread() {
    st.openId = null; clearTimeout(st.threadTimer);
    $('acThread').hidden = true; $('acThread').innerHTML = '';
    $('acList').hidden = false;
    reading();
    loadList();
  }
  function seen() {
    var t = st.list.filter(function (x) { return x.id === st.openId; })[0];
    if (!t || !t.unread) return;
    t.unread = 0;
    api('/api/agent/chats/' + st.openId + '/seen', 'POST').then(function () { return api('/api/agent/chats/unread'); })
      .then(function (d) { setUnread(d.unread); }).catch(function () { /* later */ });
  }
  function pollThread(ms) {
    clearTimeout(st.threadTimer);
    if (!st.openId) return;
    st.threadTimer = setTimeout(function () {
      if (document.hidden || !onScreen()) return pollThread(4000);
      api('/api/agent/chats/' + st.openId + '?after=' + st.lastId).then(function (d) {
        var changed = take(d.messages) || (st.thread && d.thread.userReadId !== st.thread.userReadId);
        st.thread = d.thread;
        if (changed) { renderMsgs(); seen(); }
      }).catch(function () { /* next time */ }).then(function () { pollThread(4000); });
    }, ms);
  }
  function grow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 130) + 'px'; }
  function reply() {
    var box = $('acText'), text = box.value.trim(), btn = $('acSend');
    if (!text) return;
    btn.disabled = true;
    api('/api/agent/chats/' + st.openId + '/reply', 'POST', { text: text }).then(function (d) {
      box.value = ''; grow(box); take([d.message]); renderMsgs();
    }).catch(function (err) { toast(err.message, 'error'); }).then(function () { btn.disabled = false; });
  }

  /* ------------------------------------------------------------ events */
  document.addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-inbox]'))) { segment(t.getAttribute('data-inbox')); return; }
    if (!e.target.closest('#inboxCustomers')) return;
    if ((t = e.target.closest('[data-ac-open]'))) { openThread(t.getAttribute('data-ac-open')); return; }
    if (e.target.closest('[data-ac-back]')) { closeThread(); return; }
    if ((t = e.target.closest('[data-ac-about]'))) {
      var ab = $('acAbout'); ab.hidden = !ab.hidden; t.setAttribute('aria-expanded', String(!ab.hidden));
      if (!ab.hidden) ab.innerHTML = aboutHtml(st.about);
      return;
    }
    if ((t = e.target.closest('[data-ac-quick]'))) {
      var box = $('acText'); box.value = (box.value ? box.value.trim() + ' ' : '') + QUICK[Number(t.getAttribute('data-ac-quick'))]; grow(box); box.focus(); return;
    }
    if ((t = e.target.closest('[data-ac-done]'))) {
      var to = st.thread && st.thread.status === 'done' ? 'open' : 'done';
      api('/api/agent/chats/' + st.openId + '/status', 'POST', { status: to }).then(function (d) {
        st.thread = d.thread; t.textContent = to === 'done' ? 'Reopen' : 'Mark done';
        toast(to === 'done' ? 'Marked done. It opens again if they write.' : 'Reopened.', 'success');
      }).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    if (e.target.closest('[data-ac-delete]')) {
      if (!confirm('Delete this chat and all its messages?')) return;
      api('/api/agent/chats/' + st.openId, 'DELETE').then(function () { toast('Chat deleted.', 'success'); closeThread(); })
        .catch(function (err) { toast(err.message, 'error'); });
    }
  });
  document.addEventListener('submit', function (e) { if (e.target.id === 'acReply') { e.preventDefault(); reply(); } });
  document.addEventListener('input', function (e) { if (e.target.id === 'acText') grow(e.target); });
  document.addEventListener('keydown', function (e) {
    if (e.target.id === 'acText' && e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer:coarse)').matches) { e.preventDefault(); reply(); }
    else if (e.key === 'Escape' && st.openId && reading() && !document.querySelector('.ag-modal:not([hidden])')) closeThread();
  });

  /* ------------------------------------------------------------ the Inbox tab: Customers or From Abrants */
  function segment(which) {
    st.seg = which;
    Array.prototype.forEach.call(document.querySelectorAll('[data-inbox]'), function (b) {
      var on = b.getAttribute('data-inbox') === which;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('inboxCustomers').hidden = which !== 'customers';
    $('inboxStore').hidden = which !== 'store';
    if (which === 'store' && window.AgDash) window.AgDash.loadInbox();
    if (which === 'customers') { if (st.openId) pollThread(0); else loadList(); pollList(); }
    reading();
  }
  /** The Inbox tab was opened: customers first, unless only the store has written. */
  function show(storeUnread) {
    st.active = true;
    segment(storeUnread && !st.unread ? 'store' : st.seg);
  }
  function hide() { st.active = false; reading(); }
  function pollList() {
    clearTimeout(st.listTimer);
    st.listTimer = setTimeout(function () {
      if (onScreen() && !st.openId && !document.hidden) loadList().then(pollList); else if (onScreen()) pollList();
    }, 6000);
  }
  function pollBadge() {
    clearTimeout(st.badgeTimer);
    st.badgeTimer = setTimeout(function () {
      if (document.hidden || $('dashView').hidden || onScreen()) return pollBadge();
      api('/api/agent/chats/unread').then(function (d) { setUnread(d.unread); }).catch(function () { /* later */ }).then(pollBadge);
    }, 30000);
  }
  pollBadge();
  window.AgChats = { show: show, hide: hide, setUnread: setUnread };
})();
