/* Abrants Admin — customers, offers and notices */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var st = {
    search: '', sort: 'recent', minWeek: 0, page: 1, pages: 1, total: 0, pageSize: 25,
    rows: [], plans: [], selected: {}, offerTargets: [], noticeTargets: []
  };
  var timer = null;

  /* ------------------------------------------------------------ helpers */
  function money(v) { return 'GH₵' + Number(v || 0).toFixed(2); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function date(v) {
    try { return new Date(v).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return '—'; }
  }
  function day(v) {
    try { return new Date(v).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return '—'; }
  }
  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div><button class="toast-close" aria-label="Dismiss">×</button>';
    el.querySelector('.toast-close').addEventListener('click', function () { el.remove(); });
    $('#toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 5200);
  }
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(label || 'Working…'); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function api(url, method, body) {
    return fetch(url, {
      method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (res.status === 401) { location.reload(); throw new Error('Your session expired. Please sign in again.'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Request failed.');
        return data;
      });
    });
  }
  function selectedIds() { return Object.keys(st.selected).filter(function (k) { return st.selected[k]; }); }

  /* --------------------------------------------------------------- list */
  function load() {
    var body = $('#custBody');
    body.innerHTML = '<tr><td colspan="8"><div class="skeleton-row"></div><div class="skeleton-row" style="width:60%"></div></td></tr>';
    var q = new URLSearchParams({ search: st.search, sort: st.sort, minWeek: String(st.minWeek), page: String(st.page), pageSize: String(st.pageSize) });
    api('/api/admin/customers?' + q.toString()).then(function (data) {
      st.rows = data.rows || []; st.total = data.total || 0; st.pages = data.pages || 1; st.page = data.page || 1;
      var s = data.summary || {};
      $('#cs-total').textContent = s.total || 0;
      $('#cs-new').textContent = s.new7d || 0;
      $('#cs-buyers').textContent = s.buyers7d || 0;

      body.innerHTML = st.rows.map(function (c) {
        var checked = st.selected[c.id] ? ' checked' : '';
        var disabled = c.status !== 'active';
        return '<tr>' +
          '<td class="chk-col" data-label="Select"><label class="chk"><input type="checkbox" data-pick="' + c.id + '"' + checked + (disabled ? ' disabled' : '') + ' aria-label="Select ' + esc(c.name) + '" /><span></span></label></td>' +
          '<td data-label="Customer"><strong>' + esc(c.name) + '</strong><span class="sub">' + esc(c.phone) + (c.email ? ' · ' + esc(c.email) : '') + '</span></td>' +
          '<td data-label="This week"><strong>' + c.orders7d + ' order' + (c.orders7d === 1 ? '' : 's') + '</strong><span class="sub">' + money(c.spent7d) + '</span></td>' +
          '<td data-label="All time"><strong>' + c.ordersTotal + ' order' + (c.ordersTotal === 1 ? '' : 's') + '</strong><span class="sub">' + money(c.spentTotal) + '</span></td>' +
          '<td data-label="Offers">' + (c.activeOffers ? '<span class="badge paid">' + c.activeOffers + ' active</span>' : '<span class="sub">None</span>') + '</td>' +
          '<td data-label="Joined">' + day(c.createdAt) + '</td>' +
          '<td data-label="Status"><span class="badge ' + (disabled ? 'delivery_failed' : 'fulfilled') + '">' + (disabled ? 'disabled' : 'active') + '</span></td>' +
          '<td data-label=""><div class="cell-actions"><button class="btn btn-subtle btn-sm" data-open="' + c.id + '">View</button></div></td>' +
          '</tr>';
      }).join('');

      $('#custEmpty').classList.toggle('hidden', st.rows.length > 0);
      var from = st.total === 0 ? 0 : (st.page - 1) * st.pageSize + 1;
      var to = Math.min(st.page * st.pageSize, st.total);
      $('#custPagerInfo').textContent = st.total === 0 ? 'No customers' : 'Showing ' + from + '–' + to + ' of ' + st.total;
      $('#custPrev').disabled = st.page <= 1;
      $('#custNext').disabled = st.page >= st.pages;
      syncAll();
      renderSel();
    }).catch(function (err) {
      body.innerHTML = '';
      $('#custEmpty').classList.remove('hidden');
      toast(err.message, 'error');
    });
  }

  function syncAll() {
    var boxes = $$('#custBody [data-pick]:not(:disabled)');
    var all = $('#custAll');
    all.checked = boxes.length > 0 && boxes.every(function (b) { return b.checked; });
  }

  function renderSel() {
    var n = selectedIds().length;
    $('#selBar').classList.toggle('hidden', n === 0);
    $('#selCount').textContent = n + ' selected';
    document.body.classList.toggle('has-selbar', n > 0);
  }

  $('#custSearch').addEventListener('input', function (e) {
    st.search = e.target.value.trim(); st.page = 1;
    clearTimeout(timer); timer = setTimeout(load, 260);
  });
  $('#custSort').addEventListener('change', function (e) { st.sort = e.target.value; st.page = 1; load(); });
  $('#custChips').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip'); if (!chip) return;
    st.minWeek = Number(chip.dataset.min) || 0; st.page = 1;
    $$('#custChips .chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
    if (st.minWeek > 0) { st.sort = 'week'; $('#custSort').value = 'week'; }
    load();
  });
  $('#custPrev').addEventListener('click', function () { if (st.page > 1) { st.page--; load(); } });
  $('#custNext').addEventListener('click', function () { if (st.page < st.pages) { st.page++; load(); } });

  $('#custAll').addEventListener('change', function (e) {
    $$('#custBody [data-pick]:not(:disabled)').forEach(function (b) { b.checked = e.target.checked; st.selected[b.dataset.pick] = e.target.checked; });
    renderSel();
  });
  $('#custBody').addEventListener('change', function (e) {
    var b = e.target.closest('[data-pick]'); if (!b) return;
    st.selected[b.dataset.pick] = b.checked; syncAll(); renderSel();
  });
  $('#custBody').addEventListener('click', function (e) {
    var open = e.target.closest('[data-open]');
    if (open) openCustomer(open.dataset.open);
  });
  $('#selClear').addEventListener('click', function () { st.selected = {}; $$('#custBody [data-pick]').forEach(function (b) { b.checked = false; }); syncAll(); renderSel(); });
  $('#selOffer').addEventListener('click', function () { openOffer(selectedIds()); });
  $('#selNotice').addEventListener('click', function () { openNotice(selectedIds()); });

  /* ----------------------------------------------------------- plans */
  function ensurePlans() {
    if (st.plans.length) return Promise.resolve(st.plans);
    return api('/api/admin/plans').then(function (p) { st.plans = p; return p; });
  }

  /* ------------------------------------------------------- offer modal */
  function names(ids) {
    var known = {};
    st.rows.forEach(function (r) { known[String(r.id)] = r.name; });
    if (st.drawerCustomer) known[String(st.drawerCustomer.id)] = st.drawerCustomer.name;
    var list = ids.map(function (id) { return known[String(id)] || 'Customer'; });
    return list.length <= 3 ? list.join(', ') : list.slice(0, 3).join(', ') + ' and ' + (list.length - 3) + ' more';
  }

  function openOffer(ids) {
    if (!ids.length) { toast('Choose at least one customer first.', 'error'); return; }
    st.offerTargets = ids;
    ensurePlans().then(function (plans) {
      $('#offerWho').textContent = 'For ' + ids.length + ' customer' + (ids.length > 1 ? 's' : '') + ': ' + names(ids) + '. Nobody else will see this offer.';
      $('#offerForm').reset();
      $('#offerNotify').checked = true;
      fillPlans();
      updateOfferForm();
      $('#offerModal').classList.remove('hidden');
    }).catch(function (err) { toast(err.message, 'error'); });
  }
  function closeOffer() { $('#offerModal').classList.add('hidden'); }

  function fillPlans() {
    var kind = $('#offerKind').value;
    var opts = (kind === 'percent_off' ? '<option value="">All bundles</option>' : '') +
      st.plans.filter(function (p) { return p.active; }).map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.network) + ' ' + esc(p.label) + ' (now ' + money(p.priceGHS) + ')</option>';
      }).join('');
    var cur = $('#offerPlan').value;
    $('#offerPlan').innerHTML = opts;
    if (cur) $('#offerPlan').value = cur;
  }

  function updateOfferForm() {
    var kind = $('#offerKind').value;
    fillPlans();
    var free = kind === 'free_bundle';
    $('#offerQtyWrap').hidden = !free;
    $('#offerValueWrap').hidden = free;
    $('#offerUsesWrap').hidden = free;
    $('#offerValueLabel').textContent = kind === 'percent_off' ? 'Discount (%)' : 'Special price (GH₵)';
    var v = $('#offerValue');
    v.min = kind === 'percent_off' ? '1' : '0.5'; v.max = kind === 'percent_off' ? '90' : '10000';
    v.step = kind === 'percent_off' ? '1' : '0.01';
    v.placeholder = kind === 'percent_off' ? 'e.g. 10' : 'e.g. 3.50';
    $('#offerPlanLabel').textContent = kind === 'percent_off' ? 'Which bundle? (or all of them)' : 'Which bundle?';
    warnOffer();
  }

  // Tell the owner when an offer would sell below cost.
  function warnOffer() {
    var kind = $('#offerKind').value;
    var el = $('#offerWarn');
    el.textContent = ''; el.className = 'notice';
    var plan = st.plans.filter(function (p) { return p.id === $('#offerPlan').value; })[0];
    if (kind === 'free_bundle') {
      if (plan && plan.providerCostGHS != null) { el.textContent = 'Each free bundle costs you about ' + money(plan.providerCostGHS) + ' from your DataHustle wallet.'; el.className = 'notice ok'; }
      return;
    }
    var val = Number($('#offerValue').value);
    if (!plan || !Number.isFinite(val) || val <= 0) return;
    var price = kind === 'percent_off' ? plan.priceGHS * (1 - val / 100) : val;
    if (plan.providerCostGHS != null && price < plan.providerCostGHS) {
      el.textContent = 'Careful: ' + money(price) + ' is below your cost of ' + money(plan.providerCostGHS) + '. You would lose ' + money(plan.providerCostGHS - price) + ' on each bundle.';
      el.className = 'notice bad';
    } else if (plan.providerCostGHS != null) {
      el.textContent = 'Customer pays ' + money(price) + ' — you keep about ' + money(price - plan.providerCostGHS - price * 0.0195) + ' after the Paystack fee.';
      el.className = 'notice ok';
    }
  }

  $('#offerKind').addEventListener('change', updateOfferForm);
  $('#offerPlan').addEventListener('change', warnOffer);
  $('#offerValue').addEventListener('input', warnOffer);
  $('#closeOfferModal').addEventListener('click', closeOffer);
  $('#cancelOfferBtn').addEventListener('click', closeOffer);
  $('#offerModal').addEventListener('click', function (e) { if (e.target.id === 'offerModal') closeOffer(); });

  $('#offerForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var kind = $('#offerKind').value;
    var payload = {
      customerIds: st.offerTargets, kind: kind, planId: $('#offerPlan').value || null,
      title: $('#offerTitle').value.trim(), message: $('#offerMessage').value.trim(),
      expiresAt: $('#offerEnds').value || null, notify: $('#offerNotify').checked
    };
    if (kind === 'free_bundle') payload.quantity = $('#offerQty').value;
    else { payload.value = $('#offerValue').value; if ($('#offerUses').value) payload.maxUses = $('#offerUses').value; }
    var btn = $('#saveOfferBtn');
    setBusy(btn, true, 'Saving…');
    api('/api/admin/offers', 'POST', payload).then(function (r) {
      toast('Offer given to ' + r.created + ' customer' + (r.created > 1 ? 's' : '') + '.', 'success');
      closeOffer();
      st.selected = {};
      load();
      if (st.drawerCustomer && st.offerTargets.length === 1 && String(st.drawerCustomer.id) === String(st.offerTargets[0])) openCustomer(st.drawerCustomer.id);
    }).catch(function (err) { toast(err.message, 'error'); })
      .then(function () { setBusy(btn, false); });
  });

  /* ------------------------------------------------------ notice modal */
  function openNotice(ids) {
    if (!ids.length) { toast('Choose at least one customer first.', 'error'); return; }
    st.noticeTargets = ids;
    $('#noticeWho').textContent = 'To ' + ids.length + ' customer' + (ids.length > 1 ? 's' : '') + ': ' + names(ids) + '.';
    $('#noticeForm').reset();
    $('#noticeModal').classList.remove('hidden');
  }
  function closeNotice() { $('#noticeModal').classList.add('hidden'); }
  $('#closeNoticeModal').addEventListener('click', closeNotice);
  $('#cancelNoticeBtn').addEventListener('click', closeNotice);
  $('#noticeModal').addEventListener('click', function (e) { if (e.target.id === 'noticeModal') closeNotice(); });
  $('#noticeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('#sendNoticeBtn');
    setBusy(btn, true, 'Sending…');
    api('/api/admin/notices', 'POST', { customerIds: st.noticeTargets, title: $('#noticeTitle').value.trim(), body: $('#noticeBody').value.trim() })
      .then(function (r) { toast('Notice sent to ' + r.sent + ' customer' + (r.sent > 1 ? 's' : '') + '.', 'success'); closeNotice(); st.selected = {}; load(); })
      .catch(function (err) { toast(err.message, 'error'); })
      .then(function () { setBusy(btn, false); });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeOffer(); closeNotice();
  });

  /* --------------------------------------------------- customer drawer */
  function offerLine(o) {
    var kind = o.kind === 'free_bundle' ? 'Free bundle' : (o.kind === 'percent_off' ? 'Discount' : 'Special price');
    var state = !o.active ? '<span class="badge">cancelled</span>' : (o.expired ? '<span class="badge">ended</span>' : (o.usable ? '<span class="badge fulfilled">active</span>' : '<span class="badge refunded">used up</span>'));
    var meta = [];
    if (o.maxUses != null) meta.push(o.used + ' of ' + o.maxUses + ' used');
    else if (o.used) meta.push(o.used + ' used');
    if (o.expiresAt) meta.push('ends ' + day(o.expiresAt));
    return '<div class="mini-card">' +
      '<div class="mini-top"><strong>' + esc(o.title) + '</strong>' + state + '</div>' +
      '<div class="sub">' + kind + (o.planLabel ? ' · ' + esc(o.planLabel) : '') + (meta.length ? ' · ' + esc(meta.join(' · ')) : '') + '</div>' +
      (o.usable ? '<button class="btn btn-danger btn-sm" data-cancel-offer="' + o.id + '" style="margin-top:9px">Cancel offer</button>' : '') +
      '</div>';
  }

  function openCustomer(id) {
    var content = $('#drawerContent');
    content.innerHTML = '<div class="skeleton-row" style="height:22px"></div><div class="skeleton-row"></div><div class="skeleton-row" style="width:70%"></div>';
    $('#drawer').classList.remove('hidden');
    api('/api/admin/customers/' + encodeURIComponent(id)).then(function (d) {
      var c = d.customer;
      st.drawerCustomer = c;
      var disabled = c.status !== 'active';
      var row = st.rows.filter(function (r) { return String(r.id) === String(c.id); })[0] || {};
      content.innerHTML =
        '<div class="drawer-head"><div><p class="eyebrow">Customer</p><h2 style="word-break:normal;overflow-wrap:anywhere">' + esc(c.name) + '</h2>' +
        '<span class="badge ' + (disabled ? 'delivery_failed' : 'fulfilled') + '">' + (disabled ? 'disabled' : 'active') + '</span></div></div>' +
        '<div class="drawer-actions">' +
          '<button class="btn btn-primary btn-sm" data-c-offer="' + c.id + '">🎁 Give offer</button>' +
          '<button class="btn btn-ghost btn-sm" data-c-notice="' + c.id + '">✉ Send notice</button>' +
        '</div>' +
        '<div class="detail-grid">' +
          '<div class="detail-box"><span>Phone</span><strong>' + esc(c.phone) + '</strong></div>' +
          '<div class="detail-box"><span>Email</span><strong>' + esc(c.email || '—') + '</strong></div>' +
          '<div class="detail-box"><span>This week</span><strong>' + (row.orders7d != null ? row.orders7d + (row.orders7d === 1 ? ' order' : ' orders') + ' · ' + money(row.spent7d) : '—') + '</strong></div>' +
          '<div class="detail-box"><span>All time</span><strong>' + (row.ordersTotal != null ? row.ordersTotal + (row.ordersTotal === 1 ? ' order' : ' orders') + ' · ' + money(row.spentTotal) : '—') + '</strong></div>' +
          '<div class="detail-box"><span>Joined</span><strong>' + day(c.createdAt) + '</strong></div>' +
          '<div class="detail-box"><span>Last login</span><strong>' + (c.lastLoginAt ? date(c.lastLoginAt) : 'Never') + '</strong></div>' +
        '</div>' +

        '<h3 style="margin:18px 0 8px;font-size:15px">Offers</h3>' +
        (d.offers.length ? d.offers.map(offerLine).join('') : '<div class="empty"><strong>No offers yet</strong><p>Give a special price, a discount or a free bundle.</p></div>') +

        '<h3 style="margin:20px 0 8px;font-size:15px">Recent orders</h3>' +
        (d.orders.length ? d.orders.map(function (o) {
          var free = o.source === 'gift' || Number(o.priceGHS) === 0;
          return '<div class="mini-card"><div class="mini-top"><strong>' + esc(o.network) + ' ' + esc(o.label) + '</strong><span><b>' + (free ? 'FREE' : money(o.priceGHS)) + '</b></span></div>' +
            '<div class="sub">' + esc(o.phone) + ' · ' + date(o.createdAt) + '</div><div style="margin-top:7px"><span class="badge ' + esc(o.status) + '">' + esc(String(o.status).replace(/_/g, ' ')) + '</span></div></div>';
        }).join('') : '<div class="empty"><strong>No orders yet</strong></div>') +

        '<h3 style="margin:20px 0 8px;font-size:15px">Your private note</h3>' +
        '<label class="field"><textarea id="custNote" maxlength="500" placeholder="Only you can see this…">' + esc(c.adminNote || '') + '</textarea></label>' +
        '<button class="btn btn-ghost btn-sm" data-c-note="' + c.id + '" style="margin-top:8px">Save note</button>' +

        '<h3 style="margin:22px 0 8px;font-size:15px">Account</h3>' +
        '<div class="drawer-actions">' +
          '<button class="btn btn-ghost btn-sm" data-c-reset="' + c.id + '">Reset password</button>' +
          '<button class="btn ' + (disabled ? 'btn-primary' : 'btn-danger') + ' btn-sm" data-c-status="' + c.id + '" data-to="' + (disabled ? 'active' : 'disabled') + '">' + (disabled ? 'Re-enable account' : 'Disable account') + '</button>' +
        '</div><div id="resetBox"></div>';
    }).catch(function (err) {
      content.innerHTML = '<div class="empty"><div>!</div><strong>Could not load this customer</strong><p>' + esc(err.message) + '</p></div>';
    });
  }

  $('#drawerContent').addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('[data-c-offer]'))) { openOffer([t.dataset.cOffer]); return; }
    if ((t = e.target.closest('[data-c-notice]'))) { openNotice([t.dataset.cNotice]); return; }
    if ((t = e.target.closest('[data-cancel-offer]'))) {
      if (!confirm('Cancel this offer? The customer will no longer be able to use it.')) return;
      setBusy(t, true, 'Cancelling…');
      api('/api/admin/customers/' + st.drawerCustomer.id + '/offers/' + t.dataset.cancelOffer, 'DELETE')
        .then(function () { toast('Offer cancelled.', 'success'); openCustomer(st.drawerCustomer.id); load(); })
        .catch(function (err) { toast(err.message, 'error'); setBusy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-c-note]'))) {
      setBusy(t, true, 'Saving…');
      api('/api/admin/customers/' + t.dataset.cNote + '/note', 'POST', { note: ($('#custNote') || {}).value || '' })
        .then(function () { toast('Note saved.', 'success'); })
        .catch(function (err) { toast(err.message, 'error'); })
        .then(function () { setBusy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-c-reset]'))) {
      if (!confirm('Reset this customer\'s password?\n\nThey will be logged out everywhere and you will get a temporary password to give them.')) return;
      setBusy(t, true, 'Resetting…');
      api('/api/admin/customers/' + t.dataset.cReset + '/reset-password', 'POST', {})
        .then(function (r) {
          $('#resetBox').innerHTML = '<div class="alert-strip warn" style="margin-top:12px"><span class="ico">🔑</span><div><strong>Temporary password (shown once)</strong><br>' +
            '<code class="temp-pw">' + esc(r.temporaryPassword) + '</code><br>Send it to the customer privately. They can change it in their account.</div></div>';
        })
        .catch(function (err) { toast(err.message, 'error'); })
        .then(function () { setBusy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-c-status]'))) {
      var to = t.dataset.to;
      if (to === 'disabled' && !confirm('Disable this account? They will be logged out and lose their special prices until you re-enable it.')) return;
      setBusy(t, true, 'Saving…');
      api('/api/admin/customers/' + t.dataset.cStatus + '/status', 'POST', { status: to })
        .then(function () { toast(to === 'disabled' ? 'Account disabled.' : 'Account re-enabled.', 'success'); openCustomer(st.drawerCustomer.id); load(); })
        .catch(function (err) { toast(err.message, 'error'); setBusy(t, false); });
    }
  });

  window.AbrantsCustomers = { load: load };
})();
