/* Abrants Admin — agents: on/off, approvals, agent prices, payouts. */
(function () {
  'use strict';
  var $ = function (sel) { return document.querySelector(sel); };
  var money = function (v) { var n = Number(v || 0); return (n < 0 ? '−GH₵' : 'GH₵') + Math.abs(n).toFixed(2); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var NET = { MTN: 'MTN', Telecel: 'Telecel', AirtelTigo: 'AirtelTigo' };
  var STATUS = { pending: 'Waiting', active: 'Active', suspended: 'Paused', rejected: 'Closed', deleted: 'Deleted', deleting: 'Deleting' };
  var PAUSE = [[7, '1 week'], [14, '2 weeks'], [30, '1 month'], [90, '3 months'], [180, '6 months'], [0, 'Until I reopen it']];
  var KIND = { strike: 'Strike', paused: 'Paused', approved: 'Approved', reopened: 'Reopened', paid: 'Paid', message: 'Message' };
  var stateOf = function (a) { return a.deleteRequestedAt && a.status !== 'deleted' ? 'deleting' : a.status; };
  var day = function (v) { try { return new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } };
  var PSTATE = { paid: 'Paid', sending: 'Sending', otp: 'Needs code', failed: 'Failed' };
  var st = { data: null, filter: 'all', method: 'manual', openId: null, detail: null };

  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div>';
    $('#toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }
  function api(url, method, body) {
    return fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        if (res.status === 401) { location.reload(); throw new Error('Session expired.'); }
        return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok) { var e = new Error(d.error || 'Request failed.'); e.key = d.key; throw e; } return d; });
      });
  }
  function busy(btn, on, text) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(text); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function when(v) { try { return new Date(v).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); } finally { ta.remove(); }
    });
  }
  var find = function (id) { return ((st.data && st.data.agents) || []).filter(function (a) { return a.id === Number(id); })[0]; };

  /* ---------------------------------------------------------------- render */

  function renderHead(d) {
    $('#agEnabled').checked = !!d.settings.enabled;
    $('#agAuto').checked = !!d.settings.autoApprove;
    $('#agJoinUrl').textContent = d.siteUrl + '/agent';
    $('#section-agents').classList.toggle('ag-off', !d.settings.enabled);
    var badge = $('#agBadge');
    if (badge) { badge.textContent = d.counts.pending; badge.classList.toggle('hidden', !d.counts.pending); }
    $('#agStats').innerHTML =
      '<article class="stat-card"><span>Active agents</span><strong>' + d.counts.active + '</strong><small>' + (d.counts.pending ? d.counts.pending + ' waiting' : '&nbsp;') + '</small></article>' +
      '<article class="stat-card"><span>Agent sales this month</span><strong>' + money(d.month.salesGHS) + '</strong><small>' + d.month.orders + ' orders</small></article>' +
      '<article class="stat-card"><span>Agents earned</span><strong>' + money(d.month.agentEarningsGHS) + '</strong><small>this month</small></article>' +
      '<article class="stat-card' + (d.owed.readyGHS > 0 ? ' featured' : '') + '"><span>Ready to pay</span><strong>' + money(d.owed.readyGHS) + '</strong><small>' + money(d.owed.heldGHS + d.owed.onTheWayGHS) + ' more coming</small></article>';
  }

  function agentRow(a) {
    var due = a.readyGHS > 0;
    var s = stateOf(a);
    var flags = (a.strikes ? '<span class="ag-strike-chip">' + a.strikes + ' strike' + (a.strikes > 1 ? 's' : '') + '</span>' : '') +
      (a.status === 'suspended' && a.suspendedUntil ? '<span class="ag-until">until ' + esc(day(a.suspendedUntil)) + '</span>' : '');
    return '<div class="lk-card ag-card" data-ag-open="' + a.id + '">' +
      '<div class="lk-top"><div><strong>' + esc(a.shopName) + '</strong><small>' + (a.status === 'deleted' ? 'Deleted ' + esc(day(a.deletedAt)) : esc(a.name) + ' · ' + esc(a.phone)) + '</small>' +
      (flags ? '<div class="ag-flags">' + flags + '</div>' : '') + '</div>' +
      '<span class="ag-pill ' + esc(s) + '">' + esc(STATUS[s] || s) + '</span></div>' +
      '<div class="lk-nums ag-nums">' +
      '<div><b>' + a.sales + '</b><span>sales</span></div>' +
      '<div><b' + (due ? ' class="pos"' : '') + '>' + money(a.readyGHS) + '</b><span>ready to pay</span></div>' +
      '<div><b>' + money(a.heldGHS + a.onTheWayGHS) + '</b><span>coming</span></div>' +
      '<div><b>' + money(a.paidGHS) + '</b><span>paid</span></div>' +
      '</div>' +
      (a.status === 'pending' ? '<div class="lk-actions"><button class="btn btn-primary btn-sm" type="button" data-ag-status="active" data-id="' + a.id + '">Approve</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-ag-status="rejected" data-id="' + a.id + '">Decline</button></div>' : '') +
      '</div>';
  }

  function renderList() {
    var list = (st.data.agents || []).filter(function (a) { return st.filter === 'all' ? a.status !== 'rejected' && a.status !== 'deleted' : a.status === st.filter; });
    Array.prototype.forEach.call(document.querySelectorAll('#agFilter .chip'), function (c) { c.classList.toggle('active', c.getAttribute('data-ag-filter') === st.filter); });
    $('#agList').innerHTML = list.length ? list.map(agentRow).join('') : '<p class="muted" style="margin:6px 0">' + (st.data.agents.length ? 'None here.' : 'No agents yet. Share the sign-up link.') + '</p>';
  }

  function payoutRow(p) {
    var a = find(p.agentId);
    var actions = '';
    if (p.status === 'otp') {
      actions = '<div class="ag-otp"><input inputmode="numeric" maxlength="8" placeholder="Code from Paystack" data-otp-input="' + p.id + '" />' +
        '<button class="btn btn-primary btn-sm" type="button" data-otp="' + p.id + '">Send</button></div>';
    }
    if (p.status === 'sending' || p.status === 'otp') {
      actions += '<div class="lk-actions"><button class="btn btn-ghost btn-sm" type="button" data-check="' + p.id + '">Check</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-mark="paid" data-id="' + p.id + '">It arrived</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-mark="failed" data-id="' + p.id + '">It failed</button></div>';
    }
    return '<div class="lk-card ag-payout">' +
      '<div class="lk-top"><div><strong>' + money(p.sentGHS) + ' → ' + esc(a ? a.shopName : 'Agent ' + p.agentId) + '</strong>' +
      '<small>' + esc(NET[p.momoNetwork] || p.momoNetwork) + ' ' + esc(p.momoNumber) + ' · ' + esc(p.momoName) + ' · ' + esc(when(p.createdAt)) +
      (p.method === 'manual' ? ' · by hand' : '') + (p.trigger === 'auto' ? ' · weekly' : '') + '</small>' +
      (p.note ? '<small class="ag-note">' + esc(p.note) + '</small>' : '') + '</div>' +
      '<span class="ag-pill ' + esc(p.status) + '">' + esc(PSTATE[p.status] || p.status) + '</span></div>' + actions + '</div>';
  }

  // Paying by hand or through Paystack: the buttons and options follow the choice straight away (Save keeps it).
  function methodView() {
    var ps = st.method === 'paystack';
    $('#agAutoRow').classList.toggle('hidden', !ps);
    $('#agBalance').classList.toggle('hidden', !ps);
    $('#agPayAll').textContent = ps ? 'Pay everyone due' : 'Mark everyone due as paid';
    var saved = st.data && st.data.settings && st.data.settings.payoutMethod;
    $('#agPaySave').classList.toggle('btn-primary', saved !== st.method);
    $('#agPaySave').classList.toggle('btn-ghost', saved === st.method);
  }

  function renderPayouts(d) {
    var s = d.settings;
    st.method = s.payoutMethod;
    Array.prototype.forEach.call(document.querySelectorAll('#agMethod .chip'), function (c) { c.classList.toggle('active', c.getAttribute('data-ag-method') === st.method); });
    var f = $('#agPayForm');
    f.minPayout.value = Number(s.minPayout).toFixed(2);
    f.payoutFee.value = Number(s.payoutFee).toFixed(2);
    f.holdHours.value = s.holdHours;
    f.autoPayout.checked = !!s.autoPayout;
    f.payoutDay.value = String(s.payoutDay);
    methodView();
    $('#agPayouts').innerHTML = (d.payouts || []).length ? d.payouts.map(payoutRow).join('') : '';
  }

  function priceRow(p) {
    var low = p.cost != null && p.agentPriceSet && p.agentPrice < p.cost;
    return '<div class="ag-price' + (low ? ' warn' : '') + '" data-key="' + esc(p.key) + '" data-store="' + p.storePrice + '" data-cost="' + (p.cost == null ? '' : p.cost) + '">' +
      '<div class="ag-price-name"><strong>' + esc(p.name) + '</strong><small>Store ' + money(p.storePrice) + (p.cost != null ? ' · cost ' + money(p.cost) : '') + '</small></div>' +
      '<input inputmode="decimal" placeholder="' + p.storePrice.toFixed(2) + '" value="' + (p.agentPriceSet ? p.agentPrice.toFixed(2) : '') + '" aria-label="Agent price for ' + esc(p.name) + '" />' +
      '<span class="ag-price-gap"></span></div>';
  }
  function gapFor(row) {
    var input = row.querySelector('input');
    var store = Number(row.dataset.store), cost = row.dataset.cost === '' ? null : Number(row.dataset.cost);
    var v = input.value.trim() === '' ? store : Number(input.value);
    var gap = row.querySelector('.ag-price-gap');
    if (!isFinite(v) || v <= 0) { gap.textContent = ''; return; }
    var below = cost != null && v < cost;
    row.classList.toggle('warn', below);
    gap.textContent = below ? 'below cost' : (store - v > 0.004 ? money(store - v) + ' for agents' : 'no discount');
  }
  function renderPrices(d) {
    $('#agPrices').innerHTML = (d.products || []).map(priceRow).join('') || '<p class="muted">Nothing on sale.</p>';
    Array.prototype.forEach.call(document.querySelectorAll('.ag-price'), gapFor);
  }

  function render(d) {
    st.data = d;
    renderHead(d);
    renderList();
    renderPayouts(d);
    renderPrices(d);
  }

  function load() {
    if (!st.data) $('#agList').innerHTML = '<div class="skeleton-row"></div>';
    return api('/api/admin/agents').then(render).catch(function (err) { $('#agList').innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; });
  }

  /* ---------------------------------------------------------------- agent drawer */

  function closeDrawer() { $('#agDrawer').classList.add('hidden'); st.openId = null; }
  function openAgent(id) {
    st.openId = Number(id);
    var box = $('#agDrawerContent');
    box.innerHTML = '<div class="skeleton-row" style="height:22px"></div><div class="skeleton-row"></div>';
    $('#agDrawer').classList.remove('hidden');
    api('/api/admin/agents/' + id).then(function (d) {
      var a = d.agent;
      st.detail = d;
      if (a.status === 'deleted') {
        box.innerHTML = '<div class="drawer-head"><div><span class="ag-pill deleted">Deleted</span><h2>' + esc(a.shopName) + '</h2>' +
          '<small class="muted">Deleted ' + esc(when(a.deletedAt)) + (a.statusReason ? '. Reason: ' + esc(a.statusReason) : '') + (a.forfeitedAt ? '. Unpaid earnings were not paid.' : '') + '</small></div></div>' +
          '<p class="muted">Personal details have been erased. The shop link stays closed and cannot be taken by anyone else.</p>' +
          '<h3 class="ag-sub">Sales</h3>' + (d.sales.length ? d.sales.map(saleLine).join('') : '<p class="muted">No sales.</p>') +
          '<h3 class="ag-sub">Payouts</h3>' + (d.payouts.length ? d.payouts.map(payoutRow).join('') : '<p class="muted">No payouts.</p>');
        return;
      }
      var leaving = Boolean(a.deleteRequestedAt);
      var recentMomo = a.momoChangedAt && (Date.now() - new Date(a.momoChangedAt).getTime() < 24 * 3600 * 1000);
      var statusBtns = leaving ? '' : a.status === 'active'
        ? ''
        : '<button class="btn btn-primary btn-sm" type="button" data-ag-status="active" data-id="' + a.id + '">' + (a.status === 'pending' ? 'Approve' : 'Reopen shop') + '</button>';
      var canPay = a.readyGHS > st.data.settings.payoutFee;
      box.innerHTML =
        '<div class="drawer-head"><div><span class="ag-pill ' + esc(stateOf(a)) + '">' + esc(STATUS[stateOf(a)] || a.status) + '</span>' +
        (a.strikes ? ' <span class="ag-strike-chip">' + a.strikes + ' strike' + (a.strikes > 1 ? 's' : '') + '</span>' : '') +
        '<h2>' + esc(a.shopName) + '</h2><small class="muted">' + esc(a.name) + ' · ' + esc(a.phone) + '</small></div>' +
        (a.logo ? '<img class="ag-drawer-logo" src="' + esc(a.logo) + '" alt="Shop logo" />' : '') + '</div>' +
        (leaving ? '<div class="alert-strip warn"><span class="ico">!</span><div>Being deleted' + (a.statusReason ? ' (' + esc(a.statusReason) + ')' : '') +
          '. It is deleted for good once they have been paid what they are owed.</div></div>' : '') +
        (a.status === 'suspended' ? '<div class="alert-strip warn"><span class="ico">!</span><div>Paused ' + (a.suspendedUntil ? 'until ' + esc(day(a.suspendedUntil)) + ' (it reopens by itself)' : 'until you reopen it') +
          (a.statusReason ? '. Reason: ' + esc(a.statusReason) : '') + '</div></div>' : '') +
        '<div class="lk-url">' + esc(d.shopUrl) + '</div>' +
        (a.bio || a.announcement ? '<div class="ag-said">' + (a.bio ? '<p><b>About:</b> ' + esc(a.bio) + '</p>' : '') + (a.announcement ? '<p><b>Announcement:</b> ' + esc(a.announcement) + '</p>' : '') + '</div>' : '') +
        '<div class="detail-grid">' +
        '<div class="detail-box"><span>Ready to pay</span><strong class="' + (canPay ? 'pos' : '') + '">' + money(a.readyGHS) + '</strong></div>' +
        '<div class="detail-box"><span>On hold / on the way</span><strong>' + money(a.heldGHS) + ' / ' + money(a.onTheWayGHS) + '</strong></div>' +
        '<div class="detail-box"><span>Paid out</span><strong>' + money(a.paidGHS) + (a.sendingGHS ? ' (+' + money(a.sendingGHS) + ' sending)' : '') + '</strong></div>' +
        '<div class="detail-box"><span>Sales</span><strong>' + a.sales + '</strong></div>' +
        (a.termsAcceptedAt ? '<div class="detail-box" style="grid-column:1/-1"><span>Terms</span><strong>Accepted ' + esc(when(a.termsAcceptedAt)) + ' (version ' + esc(a.termsVersion) + ')</strong></div>' : '') +
        '<div class="detail-box" style="grid-column:1/-1"><span>MoMo</span><strong>' + esc(NET[a.momoNetwork] || a.momoNetwork) + ' ' + esc(a.momoNumber) + ' · ' + esc(a.momoName) +
          (recentMomo ? ' <em class="neg">changed ' + esc(when(a.momoChangedAt)) + '</em>' : '') + '</strong></div>' +
        '</div>' +
        '<div class="drawer-actions">' +
        (canPay && st.method === 'paystack' ? '<button class="btn btn-primary btn-sm" type="button" data-pay="paystack" data-id="' + a.id + '">Send ' + money(a.readyGHS - st.data.settings.payoutFee) + ' by Paystack</button>' : '') +
        (canPay ? '<button class="btn ' + (st.method === 'paystack' ? 'btn-ghost' : 'btn-primary') + ' btn-sm" type="button" data-pay="manual" data-id="' + a.id + '">I paid ' + money(a.readyGHS - st.data.settings.payoutFee) + ' by MoMo</button>' : '') +
        statusBtns +
        (leaving ? '' : '<button class="btn btn-ghost btn-sm" type="button" data-reset="' + a.id + '">New password</button>') +
        (a.logo ? '<button class="btn btn-ghost btn-sm" type="button" data-remove-logo="' + a.id + '">Remove logo</button>' : '') +
        '</div>' +
        (leaving ? '' :
          '<h3 class="ag-sub">Messages and strikes</h3>' +
          '<div class="chip-row ag-actions">' +
            '<button class="chip" type="button" data-ag-act="message">Send a message</button>' +
            '<button class="chip" type="button" data-ag-act="strike">Give strike ' + (a.strikes + 1) + '</button>' +
            (['active', 'suspended'].indexOf(a.status) !== -1 ? '<button class="chip" type="button" data-ag-act="pause">' + (a.status === 'suspended' ? 'Change the pause' : 'Pause the shop') + '</button>' : '') +
            '<button class="chip chip-danger" type="button" data-ag-act="delete">Delete the shop</button>' +
          '</div>' +
          '<form class="ag-act-form hidden" id="agActForm" data-id="' + a.id + '" autocomplete="off"></form>') +
        (d.messages && d.messages.length ? '<div class="ag-history">' + d.messages.map(function (m) {
          return '<div class="event ag-hist ' + esc(m.kind) + (m.removed ? ' removed' : '') + '"><small>' + esc(when(m.createdAt)) + ' · ' + esc(KIND[m.kind] || m.kind) + (m.read ? ' · read' : '') + '</small>' +
            '<strong>' + esc(m.title) + (m.removed ? ' (removed)' : '') + '</strong>' + (m.body ? '<p>' + esc(m.body) + '</p>' : '') +
            (m.strike && !m.removed ? '<button class="btn btn-ghost btn-sm" type="button" data-unstrike="' + m.id + '" data-id="' + a.id + '">Remove this strike</button>' : '') + '</div>';
        }).join('') + '</div>' : '') +
        '<label class="field"><span>Note</span><input id="agNote" maxlength="300" value="' + esc(a.adminNote) + '" /></label>' +
        '<div class="drawer-actions"><button class="btn btn-ghost btn-sm" type="button" data-note="' + a.id + '">Save note</button></div>' +
        '<h3 class="ag-sub">Sales</h3>' +
        (d.sales.length ? d.sales.map(saleLine).join('') : '<p class="muted">No sales yet.</p>') +
        '<h3 class="ag-sub">Payouts</h3>' +
        (d.payouts.length ? d.payouts.map(payoutRow).join('') : '<p class="muted">No payouts yet.</p>');
    }).catch(function (err) { box.innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; });
  }
  function saleLine(s) {
    return '<div class="event"><small>' + esc(when(s.createdAt)) + ' · ' + esc(s.reference) + '</small><strong>' + esc(s.what) + ' · ' + esc(s.phone) + ' · ' + money(s.priceGHS) +
      ' · <span class="' + (s.state === 'delivered' ? 'pos' : (s.state === 'on_the_way' ? '' : 'neg')) + '">+' + money(s.earningGHS) + ' ' + esc(s.state.replace(/_/g, ' ')) + '</span></strong></div>';
  }

  // The form under "Messages and strikes": one at a time.
  function actForm(kind) {
    var f = $('#agActForm');
    if (!f) return;
    var a = st.detail.agent;
    var owed = (a.readyGHS || 0) + (a.heldGHS || 0) + (a.onTheWayGHS || 0) + (a.sendingGHS || 0);
    var sms = '<label class="switch"><input type="checkbox" name="sms" checked /><span class="track"></span><span>Also send by SMS</span></label>';
    var html = {
      message: '<label class="field"><span>Message to ' + esc(a.shopName) + '</span><textarea name="text" maxlength="1000" rows="3"></textarea></label>' + sms +
        '<div class="drawer-actions"><button class="btn btn-primary btn-sm" type="submit">Send message</button>',
      strike: '<label class="field"><span>What did they do wrong? They see this.</span><textarea name="reason" maxlength="400" rows="3" placeholder="You told customers on WhatsApp that bundles are free this week."></textarea></label>' + sms +
        (a.strikes >= 2 ? '<p class="muted">This is strike ' + (a.strikes + 1) + '. Their message says the shop can be paused or deleted next time.</p>' : '') +
        '<div class="drawer-actions"><button class="btn btn-primary btn-sm" type="submit">Give strike ' + (a.strikes + 1) + '</button>',
      pause: '<label class="field"><span>Why? They see this.</span><textarea name="reason" maxlength="300" rows="2"></textarea></label>' +
        '<label class="field"><span>For how long</span><select name="days">' + PAUSE.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === 30 ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></label>' + sms +
        '<div class="drawer-actions"><button class="btn btn-primary btn-sm" type="submit">Pause the shop</button>',
      delete: '<label class="field"><span>Why? They get this by SMS.</span><textarea name="reason" maxlength="300" rows="2"></textarea></label>' +
        '<label class="switch"><input type="checkbox" name="pay" checked /><span class="track"></span><span>Pay what they have earned first' + (owed > 0 ? ' (' + money(owed) + ')' : '') + '</span></label>' +
        '<label class="switch"><input type="checkbox" name="block" checked /><span class="track"></span><span>Don\'t let this phone or MoMo number open a shop again</span></label>' +
        '<p class="muted">The shop closes now. Their name, phone, MoMo, logo and messages are erased' + (owed > 0 ? ' once they are paid (or now, if you do not pay them)' : '') + '. Sales and payout records stay.</p>' +
        '<div class="drawer-actions"><button class="btn btn-danger btn-sm" type="submit">Delete the shop</button>',
    }[kind];
    f.dataset.kind = kind;
    f.innerHTML = html + '<button class="btn btn-ghost btn-sm" type="button" data-act-cancel>Cancel</button></div>';
    f.classList.remove('hidden');
    Array.prototype.forEach.call(document.querySelectorAll('[data-ag-act]'), function (c) { c.classList.toggle('active', c.getAttribute('data-ag-act') === kind); });
    var first = f.querySelector('textarea'); if (first) first.focus();
  }
  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'agActForm') return;
    e.preventDefault();
    var f = e.target, kind = f.dataset.kind, id = f.dataset.id, a = st.detail.agent;
    var smsOn = f.sms ? f.sms.checked : true;
    var call = {
      message: ['message', { text: f.text && f.text.value, sms: smsOn }, 'Message sent.'],
      strike: ['strike', { reason: f.reason && f.reason.value, sms: smsOn }, 'Strike given.'],
      pause: ['pause', { reason: f.reason && f.reason.value, days: f.days && Number(f.days.value), sms: smsOn }, 'Shop paused.'],
      delete: ['delete', { reason: f.reason && f.reason.value, pay: f.pay ? f.pay.checked : true, block: f.block ? f.block.checked : false }, ''],
    }[kind];
    if (kind === 'delete' && !confirm('Delete ' + a.shopName + ' for good? This cannot be undone.' + (f.pay && !f.pay.checked ? '\n\nThey will NOT be paid what they have not been paid yet.' : ''))) return;
    var btn = f.querySelector('button[type="submit"]');
    busy(btn, true, '…');
    api('/api/admin/agents/' + id + '/' + call[0], 'POST', call[1]).then(function (out) {
      toast(kind === 'delete' ? (out.deleted ? 'Deleted.' : 'Closed. It is deleted once they are paid ' + money(out.owedGHS) + '.') : call[2], 'success');
      return refresh();
    }).catch(function (err) { toast(err.message, 'error'); busy(btn, false); });
  });

  $('#agMsgAll').addEventListener('click', function () { $('#agMsgAllForm').classList.toggle('hidden'); var t = $('#agMsgAllForm textarea'); if (t) t.focus(); });
  $('#agMsgAllCancel').addEventListener('click', function () { $('#agMsgAllForm').classList.add('hidden'); });
  $('#agMsgAllForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, btn = f.querySelector('button[type="submit"]');
    busy(btn, true, 'Sending…');
    api('/api/admin/agents/message-all', 'POST', { text: f.text.value, sms: f.sms.checked }).then(function (out) {
      toast('Sent to ' + out.sent + ' agent' + (out.sent === 1 ? '' : 's') + '.', 'success');
      f.reset(); f.classList.add('hidden');
    }).catch(function (err) { toast(err.message, 'error'); }).then(function () { busy(btn, false); });
  });

  $('#agDrawerClose').addEventListener('click', closeDrawer);
  $('#agDrawer').addEventListener('click', function (e) { if (e.target.id === 'agDrawer') closeDrawer(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && st.openId) closeDrawer(); });

  function refresh() { return load().then(function () { if (st.openId) openAgent(st.openId); }); }

  /* ---------------------------------------------------------------- actions */

  function saveSettings(body, okText) {
    return api('/api/admin/agents/settings', 'PUT', body).then(function () { if (okText) toast(okText, 'success'); return load(); })
      .catch(function (err) { toast(err.message, 'error'); return load(); });
  }
  $('#agEnabled').addEventListener('change', function () {
    var on = this.checked;
    if (!on && !confirm('Switch the agent programme off?\n\nShop links will show your normal store, and nobody can sign up. Agents keep what they have earned.')) { this.checked = true; return; }
    saveSettings({ enabled: on }, on ? 'Agent programme is on.' : 'Agent programme is off.');
  });
  $('#agAuto').addEventListener('change', function () { saveSettings({ autoApprove: this.checked }, 'Saved.'); });
  $('#agCopyJoin').addEventListener('click', function () {
    copy($('#agJoinUrl').textContent).then(function () { toast('Sign-up link copied.', 'success'); }, function () { toast('Could not copy.', 'error'); });
  });

  $('#agPayForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, btn = $('#agPaySave');
    busy(btn, true, 'Saving…');
    saveSettings({ payoutMethod: st.method, minPayout: f.minPayout.value, payoutFee: f.payoutFee.value, holdHours: f.holdHours.value,
      autoPayout: f.autoPayout.checked, payoutDay: Number(f.payoutDay.value) }, 'Payout settings saved.').then(function () { busy(btn, false); });
  });

  $('#agPrices').addEventListener('input', function (e) { var row = e.target.closest('.ag-price'); if (row) gapFor(row); });
  $('#agFill').addEventListener('click', function () {
    var pct = Number($('#agFillPct').value || $('#agFillPct').placeholder);
    if (!(pct >= 0 && pct < 90)) { toast('Enter a percent between 0 and 90.', 'error'); return; }
    Array.prototype.forEach.call(document.querySelectorAll('.ag-price'), function (row) {
      var v = Math.round(Number(row.dataset.store) * (1 - pct / 100) * 100) / 100;
      row.querySelector('input').value = v.toFixed(2);
      gapFor(row);
    });
  });
  $('#agPricesSave').addEventListener('click', function () {
    var btn = this, prices = {}, below = [];
    Array.prototype.forEach.call(document.querySelectorAll('.ag-price'), function (row) {
      prices[row.dataset.key] = row.querySelector('input').value.trim();
      if (row.classList.contains('warn')) below.push(row.querySelector('strong').textContent);
    });
    if (below.length && !confirm('These agent prices are below your cost, so you lose money on each sale:\n' + below.join('\n') + '\n\nSave anyway?')) return;
    busy(btn, true, 'Saving…');
    api('/api/admin/agents/prices', 'PUT', { prices: prices }).then(function () { toast('Agent prices saved.', 'success'); return load(); })
      .catch(function (err) {
        toast(err.message, 'error');
        var row = err.key && document.querySelector('.ag-price[data-key="' + err.key + '"] input');
        if (row) row.focus();
      }).then(function () { busy(btn, false); });
  });

  $('#agPayAll').addEventListener('click', function () {
    var btn = this, d = st.data, s = d.settings;
    var due = d.agents.filter(function (a) { return a.status === 'active' && a.readyGHS >= s.minPayout && a.readyGHS > s.payoutFee; });
    if (!due.length) { toast('Nobody is due yet (minimum ' + money(s.minPayout) + ').', 'info'); return; }
    var total = due.reduce(function (t, a) { return t + a.readyGHS - s.payoutFee; }, 0);
    var msg = st.method === 'paystack'
      ? 'Send ' + money(total) + ' to ' + due.length + ' agent(s) from your Paystack balance now?'
      : 'Have you sent ' + money(total) + ' to ' + due.length + ' agent(s) by MoMo?\n\n' + due.map(function (a) { return a.shopName + ': ' + money(a.readyGHS - s.payoutFee) + ' to ' + a.momoNumber; }).join('\n');
    if (!confirm(msg)) return;
    busy(btn, true, st.method === 'paystack' ? 'Sending…' : 'Saving…');
    api('/api/admin/agents/payouts/run', 'POST', { method: st.method }).then(function (r) {
      var sent = r.results.filter(function (x) { return x.payout && x.payout.status !== 'failed'; }).length;
      var skipped = r.results.filter(function (x) { return !x.payout || x.payout.status === 'failed'; });
      toast(sent + ' paid' + (skipped.length ? ', ' + skipped.length + ' not: ' + skipped.map(function (x) { return x.shopName + ' (' + (x.skipped || (x.payout && x.payout.note) || 'failed') + ')'; }).join('; ') : '.'), skipped.length ? 'error' : 'success');
      return load();
    }).catch(function (err) { toast(err.message, 'error'); }).then(function () { busy(btn, false); });
  });

  $('#agBalance').addEventListener('click', function () {
    var btn = this; busy(btn, true, 'Checking…');
    api('/api/admin/agents/balance').then(function (r) {
      var g = (r.balances || []).filter(function (b) { return b.currency === 'GHS'; })[0];
      toast('Paystack balance: ' + (g ? money(g.balance) : 'not available'), 'info');
    }).catch(function (err) { toast(err.message, 'error'); }).then(function () { busy(btn, false); });
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('#section-agents, #agDrawer')) return;
    var t;
    if ((t = e.target.closest('[data-ag-filter]'))) { st.filter = t.getAttribute('data-ag-filter'); renderList(); return; }
    if ((t = e.target.closest('[data-ag-method]'))) {
      st.method = t.getAttribute('data-ag-method');
      Array.prototype.forEach.call(document.querySelectorAll('#agMethod .chip'), function (c) { c.classList.toggle('active', c === t); });
      methodView();
      return;
    }
    if ((t = e.target.closest('[data-ag-status]'))) {
      e.stopPropagation();
      var status = t.getAttribute('data-ag-status'), a = find(t.getAttribute('data-id'));
      var ask = { rejected: (a && a.status === 'pending') ? 'Decline ' + a.shopName + '?' : 'Close ' + (a ? a.shopName : 'this agent') + '\'s account? Their shop link stops and they are logged out. Money they already earned stays payable.',
        suspended: 'Pause ' + (a ? a.shopName : 'this shop') + '? Their link shows your normal store until you reopen it.' }[status];
      // Before approving: check by hand that the MoMo number really belongs to this person (start a MoMo transfer to it,
      // look at the name the network shows, then cancel).
      if (status === 'active' && a && a.status === 'pending') {
        ask = 'Check the MoMo name first:\n\nStart sending money on MoMo to ' + a.momoNumber + ' (' + a.momoNetwork + ').\nThe name shown should be: ' + a.momoName +
          (a.momoName.toLowerCase() !== a.name.toLowerCase() ? '\n(they signed up as ' + a.name + ')' : '') + '\nThen cancel the transfer.\n\nDoes it match? Approve ' + a.shopName + '?';
      }
      if (ask && !confirm(ask)) return;
      busy(t, true, '…');
      api('/api/admin/agents/' + t.getAttribute('data-id') + '/status', 'POST', { status: status })
        .then(function () { toast(status === 'active' ? 'Shop is open.' : 'Saved.', 'success'); return refresh(); })
        .catch(function (err) { toast(err.message, 'error'); busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-pay]'))) {
      var how = t.getAttribute('data-pay'), ag = find(t.getAttribute('data-id'));
      var amount = money(ag.readyGHS - st.data.settings.payoutFee);
      if (!confirm(how === 'paystack' ? 'Send ' + amount + ' to ' + ag.momoNumber + ' (' + ag.momoName + ') from your Paystack balance?' : 'Record that you sent ' + amount + ' to ' + ag.momoNumber + ' (' + ag.momoName + ') by MoMo?')) return;
      busy(t, true, 'Paying…');
      api('/api/admin/agents/' + ag.id + '/payout', 'POST', { method: how }).then(function (p) {
        toast(p.status === 'paid' ? 'Paid.' : p.status === 'otp' ? 'Enter the code Paystack sent you.' : p.status === 'failed' ? 'Not sent: ' + p.note : 'Sending…', p.status === 'failed' ? 'error' : 'success');
        return refresh();
      }).catch(function (err) { toast(err.message, 'error'); busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-otp]'))) {
      var id = t.getAttribute('data-otp');
      var input = document.querySelector('[data-otp-input="' + id + '"]');
      busy(t, true, '…');
      api('/api/admin/agents/payouts/' + id + '/otp', 'POST', { otp: input ? input.value : '' })
        .then(function (p) { toast(p.status === 'paid' ? 'Paid.' : 'Sent to Paystack.', 'success'); return refresh(); })
        .catch(function (err) { toast(err.message, 'error'); busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-check]'))) {
      busy(t, true, '…');
      api('/api/admin/agents/payouts/' + t.getAttribute('data-check') + '/check', 'POST').then(function (p) {
        toast({ paid: 'Paystack says it was paid.', failed: 'Paystack says it failed. The money is back in the agent\'s balance.' }[p.status] || 'Still sending.', p.status === 'failed' ? 'error' : 'success');
        return refresh();
      }).catch(function (err) { toast(err.message, 'error'); busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-mark]'))) {
      var mark = t.getAttribute('data-mark');
      if (!confirm(mark === 'paid' ? 'Mark this payout as received by the agent?' : 'Mark this payout as failed? The money goes back to the agent\'s balance to be paid again.')) return;
      busy(t, true, '…');
      api('/api/admin/agents/payouts/' + t.getAttribute('data-id') + '/mark', 'POST', { status: mark })
        .then(function () { toast('Saved.', 'success'); return refresh(); })
        .catch(function (err) { toast(err.message, 'error'); busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-reset]'))) {
      if (!confirm('Give this agent a new temporary password? Their current password stops working.')) return;
      api('/api/admin/agents/' + t.getAttribute('data-reset') + '/reset-password', 'POST').then(function (r) {
        prompt('Temporary password. Send it to the agent; they must change it when they log in:', r.password);
      }).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    if ((t = e.target.closest('[data-ag-act]'))) { actForm(t.getAttribute('data-ag-act')); return; }
    if ((t = e.target.closest('[data-act-cancel]'))) {
      $('#agActForm').classList.add('hidden');
      Array.prototype.forEach.call(document.querySelectorAll('[data-ag-act]'), function (c) { c.classList.remove('active'); });
      return;
    }
    if ((t = e.target.closest('[data-unstrike]'))) {
      if (!confirm('Remove this strike? It stays in their inbox, marked as removed.')) return;
      busy(t, true, '…');
      api('/api/admin/agents/' + t.getAttribute('data-id') + '/strikes/' + t.getAttribute('data-unstrike') + '/remove', 'POST')
        .then(function () { toast('Strike removed.', 'success'); return refresh(); }).catch(function (err) { toast(err.message, 'error'); busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-remove-logo]'))) {
      if (!confirm('Remove this shop\'s logo? Their shop shows their initials instead.')) return;
      api('/api/admin/agents/' + t.getAttribute('data-remove-logo') + '/remove-logo', 'POST')
        .then(function () { toast('Logo removed.', 'success'); return refresh(); }).catch(function (err) { toast(err.message, 'error'); });
      return;
    }
    if ((t = e.target.closest('[data-note]'))) {
      busy(t, true, 'Saving…');
      api('/api/admin/agents/' + t.getAttribute('data-note') + '/note', 'POST', { note: ($('#agNote') || {}).value || '' })
        .then(function () { toast('Note saved.', 'success'); }).catch(function (err) { toast(err.message, 'error'); })
        .then(function () { busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-ag-open]')) && !e.target.closest('button')) openAgent(t.getAttribute('data-ag-open'));
  });

  window.AbrantsAgents = { load: load };
})();
