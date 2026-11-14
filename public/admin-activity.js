/* Abrants Admin — Activity log in plain words: "Refunded order DB-… (GH₵5.00)" instead of "order › refund {…}".
   Grouped by day, with a filter by kind and a search. */
(function () {
  'use strict';
  var $ = function (sel) { return document.querySelector(sel); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var money = function (v) { return 'GH₵' + Number(v || 0).toFixed(2); };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var ORDER = { pending: 'waiting for payment', paid: 'paid', processing: 'on its way', fulfilled: 'delivered', delivery_failed: 'failed',
    delivery_review: 'to be checked', refunding: 'being refunded', refunded: 'refunded' };
  var PROVIDER = { datahustle: 'DataHustle', fastdeals: 'FastDealsGH' };
  var PAUSE = { 7: '1 week', 14: '2 weeks', 30: '1 month', 90: '3 months', 180: '6 months', 0: 'until reopened' };
  var KINDS = { orders: ['Orders', '#'], money: ['Money', '₵'], agents: ['Agents', '⚇'], prices: ['Prices', '%'], customers: ['Customers', '☺'],
    settings: ['Settings', '⚙'], chat: ['Chat', '✎'] };

  // What each setting is called, and how its value reads.
  var LABEL = {
    storeName: 'Store name', announcement: 'Announcement text', announcementEnabled: 'Announcement', supportWhatsapp: 'Support WhatsApp number',
    supportPhone: 'Support phone number', channelLink: 'WhatsApp channel link', providers: 'Delivery provider', pausedNetworks: 'Paused networks',
    pauseMessage: 'Message when a network is paused', numberCheckEnabled: 'Checking MTN numbers before payment', unverifiedNotice: 'Message for unchecked numbers',
    firstTimeNoticeEnabled: 'First-time MTN warning', firstTimeNotice: 'First-time MTN warning text', customerPaysFee: 'Customers pay the Paystack fee',
    maintenanceMode: 'Maintenance mode (store closed)', maintenanceMessage: 'Maintenance message', lowWalletThreshold: 'Low wallet warning',
    enabled: 'Agent programme', autoApprove: 'Approve new agents automatically', holdHours: 'Hold after delivery', minPayout: 'Minimum payout',
    payoutFee: 'Fee per payout', payoutMethod: 'How agents are paid', autoPayout: 'Weekly automatic payouts', payoutDay: 'Payout day',
    offReason: 'Reason given to agents', offReturn: 'Coming back', offUntil: 'Back on',
    customers: 'Text messages to customers', agents: 'Text messages to agents', keepDays: 'Keep chats for', chatEnabled: 'Chat on the website',
  };
  var SKIP = { autoPaused: 1, lastAutoPayout: 1, offAt: 1 };
  function value(key, v) {
    if (v === null || v === undefined || v === '') return 'nothing';
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    if (key === 'payoutMethod') return v === 'paystack' ? 'Paystack sends it' : 'paid by hand on MoMo';
    if (key === 'payoutDay') return DAYS[Number(v)] || v;
    if (key === 'holdHours') return v + ' hours';
    if (key === 'keepDays') return v + ' days';
    if (key === 'offReturn') return { soon: 'yes, soon', date: 'yes, on a date', never: 'no' }[v] || v;
    if (key === 'offUntil') return longDate(v);
    if (/minPayout|payoutFee|lowWalletThreshold/.test(key)) return money(v);
    if (key === 'providers') return Object.keys(v).map(function (n) { return n + ': ' + (PROVIDER[v[n]] || v[n]); }).join(', ');
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
    if (typeof v === 'object') {
      if ('price' in v) return money(v.price) + (v.enabled === false ? ', not on sale' : ', on sale');
      return JSON.stringify(v);
    }
    var t = String(v);
    return t.length > 70 ? '"' + t.slice(0, 67) + '…"' : (/^\d/.test(t) ? t : '"' + t + '"');
  }
  function longDate(iso) {
    try { return new Date(String(iso).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return iso; }
  }
  function changeLines(changes, nameOf) {
    return Object.keys(changes || {}).filter(function (k) { return !SKIP[k]; }).map(function (k) {
      var c = changes[k], name = nameOf ? nameOf(k) : (LABEL[k] || k);
      if (typeof c.to === 'boolean') return name + ': switched ' + (c.to ? 'on' : 'off');
      if (c.from === null || c.from === undefined) return name + ': ' + value(k, c.to);
      return name + ': ' + value(k, c.from) + ' → ' + value(k, c.to);
    });
  }

  function shop(d) { return d.shop ? d.shop : 'agent #' + d.id; }

  /** -> { kind, title, lines[] } */
  function describe(action, d) {
    d = d || {};
    var ref = d.reference || '';
    switch (action) {
      case 'order.retry': return { kind: 'orders', title: 'Tried to deliver order ' + ref + ' again',
        lines: [{ accepted: 'The provider accepted it.', rejected: 'The provider refused it.', error: 'It did not go through.' }[d.result] || ''] };
      case 'order.status': return { kind: 'orders', title: 'Changed order ' + ref + ' from ' + (ORDER[d.from] || d.from) + ' to ' + (ORDER[d.to] || d.to) };
      case 'order.note': return { kind: 'orders', title: 'Wrote a note on order ' + ref };
      case 'order.refund': return { kind: 'money', title: 'Refunded order ' + ref + (d.amount != null ? ' (' + money(d.amount) + ')' : '') };
      case 'orders.export': return { kind: 'orders', title: 'Downloaded ' + d.rows + ' order' + (d.rows === 1 ? '' : 's') + (d.status && d.status !== 'all' ? ' (' + (ORDER[d.status] || d.status) + ')' : '') };
      case 'orders.cleanup': return { kind: 'orders', title: 'Cleared ' + d.deleted + ' orders older than ' + d.months + ' months' };
      case 'orders.mark_stuck_delivered': return { kind: 'orders', title: 'Marked ' + d.count + ' stuck order' + (d.count === 1 ? '' : 's') + ' as delivered' };
      case 'services.retry': return { kind: 'orders', title: 'Tried checker/AFA order ' + ref + ' again' };
      case 'services.refund': return { kind: 'money', title: 'Refunded checker/AFA order ' + ref };
      case 'services.prices': return { kind: 'prices', title: 'Changed result checker and AFA prices',
        lines: d.changes ? changeLines(d.changes, function (k) { return k === 'AFA' ? 'AFA registration' : k + ' checker'; }) : [] };
      case 'plan.create': return { kind: 'prices', title: 'Added the bundle ' + (d.label || d.planId) + (d.price != null ? ' at ' + money(d.price) : '') };
      case 'plan.up2u_sync': return { kind: 'prices', title: 'Loaded MTN UP2U packages from FastDealsGH',
        lines: [d.offered + ' offered', d.added + ' new (hidden until priced)', d.costChanged + ' new costs', d.hidden + ' hidden'].filter(function (x) { return !/^0 /.test(x) || /offered/.test(x); }) };
      case 'plan.update': return { kind: 'prices', title: 'Changed the bundle ' + d.planId, lines: planLines(d.changes) };
      case 'plan.cost': return { kind: 'prices', title: 'Updated what bundle ' + d.planId + ' costs us', lines: [money(d.providerCostGHS)] };
      case 'plan.delete': return { kind: 'prices', title: 'Deleted the bundle ' + d.planId };
      case 'offer.create': return { kind: 'customers', title: 'Gave the offer "' + (d.title || 'Special price') + '" to ' + d.customers + ' customer' + (d.customers === 1 ? '' : 's') };
      case 'offer.cancel': return { kind: 'customers', title: 'Cancelled the offer "' + (d.title || '') + '"' };
      case 'notice.send': return { kind: 'customers', title: 'Sent "' + (d.title || 'a notice') + '" to ' + d.customers + ' customer' + (d.customers === 1 ? '' : 's') };
      case 'customer.reset_password': return { kind: 'customers', title: 'Gave customer ' + (d.phone || '#' + d.customerId) + ' a new password' };
      case 'customer.status': return { kind: 'customers', title: (d.status === 'disabled' ? 'Switched off' : 'Switched back on') + ' customer account #' + d.customerId };
      case 'customer.note': return { kind: 'customers', title: 'Wrote a note on customer #' + d.customerId };
      case 'number.block': return { kind: 'customers', title: 'Blocked ' + d.phone + ' from buying', lines: [d.reason ? 'Reason: ' + d.reason : ''] };
      case 'number.unblock': return { kind: 'customers', title: 'Unblocked ' + d.phone };
      case 'number.verify': return { kind: 'customers', title: 'Checked the MTN number ' + d.phone, lines: [d.status ? 'Result: ' + d.status : ''] };
      case 'link.create': return { kind: 'settings', title: 'Made the tracking link "' + (d.name || d.code) + '"' };
      case 'link.update': return { kind: 'settings', title: 'Changed the tracking link "' + (d.name || d.code) + '"' };
      case 'link.delete': return { kind: 'settings', title: 'Deleted the tracking link ' + d.code };
      case 'settings.update': return settingsEntry('Changed the store settings', d);
      case 'sms.settings': return settingsEntry('Changed text message settings', d);
      case 'sms.test': return { kind: 'settings', title: 'Sent a test SMS to ' + d.phone };
      case 'datahustle.webhook_enable': return { kind: 'settings', title: 'Switched on delivery updates from DataHustle' };
      case 'agents.settings': {
        var c = d.changes || {};
        if (c.enabled && Object.keys(c).filter(function (k) { return !SKIP[k] && !/^off/.test(k); }).length === 1) {
          return { kind: 'agents', title: c.enabled.to ? 'Switched the agent programme on' : 'Switched the agent programme off',
            lines: c.enabled.to ? [] : [c.offReason ? 'Reason given: ' + c.offReason.to : '', c.offReturn ? 'Coming back: ' + value('offReturn', c.offReturn.to) + (c.offUntil && c.offUntil.to ? ', ' + longDate(c.offUntil.to) : '') : ''] };
        }
        return settingsEntry('Changed the agent settings', d, 'agents');
      }
      case 'agents.prices': return { kind: 'prices', title: 'Changed the prices agents pay' };
      case 'agents.pay_all': return { kind: 'money', title: 'Paid every agent who was due (' + d.count + ')', lines: [d.method === 'paystack' ? 'Sent through Paystack' : d.method === 'manual' ? 'Recorded as paid by MoMo' : ''] };
      case 'agents.payout': return { kind: 'money', title: 'Paid ' + shop(d) + (d.sent != null ? ' ' + money(d.sent) : ''), lines: [d.method === 'paystack' ? 'Sent through Paystack' : 'Recorded as paid by MoMo'] };
      case 'agents.payout_otp': return { kind: 'money', title: 'Entered the Paystack code for agent payout #' + d.id };
      case 'agents.payout_mark': return { kind: 'money', title: 'Marked agent payout #' + d.id + ' as ' + (d.status === 'paid' ? 'received' : 'failed') };
      case 'agents.status': {
        var verb = { active: d.from === 'pending' ? 'Approved' : 'Reopened', suspended: 'Paused', rejected: d.from === 'pending' ? 'Declined' : 'Closed' }[d.status] || 'Changed';
        return { kind: 'agents', title: verb + ' ' + shop(d) };
      }
      case 'agents.message_all': return { kind: 'agents', title: 'Sent a message to all ' + d.sent + ' agents', lines: [d.sms ? 'Also by SMS' : ''] };
      case 'agents.message': return { kind: 'agents', title: 'Sent a message to ' + shop(d) };
      case 'agents.strike': return { kind: 'agents', title: 'Gave ' + shop(d) + ' a strike' + (d.strikes ? ' (strike ' + d.strikes + ')' : '') };
      case 'agents.strike_removed': return { kind: 'agents', title: 'Removed a strike from ' + shop(d) };
      case 'agents.pause': return { kind: 'agents', title: 'Paused ' + shop(d) + ' ' + (d.days ? 'for ' + (PAUSE[d.days] || d.days + ' days') : 'until reopened') };
      case 'agents.delete': return { kind: 'agents', title: 'Deleted ' + shop(d), lines: [d.pay === false ? 'Without paying what they had not been paid' : '', d.block ? 'Their number cannot open a shop again' : ''] };
      case 'agents.remove_logo': return { kind: 'agents', title: 'Removed the logo of ' + shop(d) };
      case 'agents.note': return { kind: 'agents', title: 'Wrote a note on ' + shop(d) };
      case 'agents.reset_password': return { kind: 'agents', title: 'Gave ' + shop(d) + ' a new password' };
      case 'chat.delete': return { kind: 'chat', title: 'Deleted the chat with ' + (d.who || 'someone') };
      case 'chat.settings': return settingsEntry('Changed the chat settings', d, 'chat');
      default: return { kind: 'settings', title: String(action).replace(/[._]/g, ' ') };
    }
  }
  function planLines(changes) {
    if (!changes || typeof changes !== 'object') return [];
    return Object.keys(changes).map(function (k) {
      var v = changes[k];
      if (k === 'priceGHS') return 'Price: ' + money(v);
      if (k === 'providerCostGHS') return 'Our cost: ' + money(v);
      if (k === 'active' || k === 'enabled') return v ? 'On sale' : 'Not on sale';
      return k + ': ' + value(k, v);
    });
  }
  function settingsEntry(title, d, kind) {
    var lines = d.changes ? changeLines(d.changes) : [];
    if (!d.changes) lines = ['(Saved before the log showed what changed)'];
    if (d.changes && !lines.length) lines = ['Nothing changed'];
    return { kind: kind || 'settings', title: title, lines: lines };
  }

  /* ------------------------------------------------------------ page */
  var st = { rows: [], kind: 'all', q: '' };
  function dayName(t) {
    var d = new Date(t), now = new Date();
    var start = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((start(now) - start(d)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function clock(t) { return new Date(t).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', ''); }

  function render() {
    var box = $('#auditList');
    var q = st.q.toLowerCase();
    var items = st.rows.map(function (r) { var x = describe(r.action, r.details); x.at = r.createdAt; x.ip = r.ip; return x; })
      .filter(function (x) {
        if (st.kind !== 'all' && x.kind !== st.kind) return false;
        return !q || (x.title + ' ' + (x.lines || []).join(' ')).toLowerCase().indexOf(q) !== -1;
      });
    if (!items.length) {
      box.innerHTML = '<div class="empty"><div>⌁</div><strong>' + (st.rows.length ? 'Nothing matches' : 'Nothing done yet') + '</strong><p>' +
        (st.rows.length ? 'Try another filter or search.' : 'What you do in Admin shows up here.') + '</p></div>';
      return;
    }
    var html = '', last = '';
    items.forEach(function (x) {
      var day = dayName(x.at);
      if (day !== last) { html += (last ? '</div>' : '') + '<h3 class="act-day">' + esc(day) + '</h3><div class="act-list">'; last = day; }
      var lines = (x.lines || []).filter(Boolean);
      html += '<article class="act-row"><span class="act-ico act-' + x.kind + '" aria-hidden="true">' + esc(KINDS[x.kind][1]) + '</span>' +
        '<div class="act-main"><strong>' + esc(x.title) + '</strong>' +
        (lines.length ? '<ul>' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' : '') + '</div>' +
        '<time datetime="' + esc(x.at) + '"' + (x.ip ? ' title="From ' + esc(x.ip) + '"' : '') + '>' + esc(clock(x.at)) + '</time></article>';
    });
    box.innerHTML = html + '</div>';
  }

  function load() {
    var box = $('#auditList');
    if (!st.rows.length) box.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row" style="width:70%"></div>';
    return fetch('/api/admin/audit?limit=300', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('Session expired.'); }
      return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not load.'); return d; });
    }).then(function (rows) { st.rows = rows; render(); })
      .catch(function (err) { box.innerHTML = '<p class="notice bad">' + esc(err.message) + '</p>'; });
  }

  $('#actFilter').innerHTML = '<button class="chip active" data-act-kind="all">All</button>' + Object.keys(KINDS).map(function (k) {
    return '<button class="chip" data-act-kind="' + k + '">' + KINDS[k][0] + '</button>';
  }).join('');
  $('#actFilter').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act-kind]');
    if (!b) return;
    st.kind = b.getAttribute('data-act-kind');
    Array.prototype.forEach.call(document.querySelectorAll('[data-act-kind]'), function (c) { c.classList.toggle('active', c === b); });
    render();
  });
  $('#actSearch').addEventListener('input', function () { st.q = this.value.trim(); render(); });

  window.AbrantsActivity = { load: load, describe: describe };
})();
