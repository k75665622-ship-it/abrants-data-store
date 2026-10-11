/* Abrants Admin — control center */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var state = {
    section: 'overview',
    status: 'all',
    search: '',
    network: 'all',
    from: '',
    to: '',
    page: 1,
    pageSize: 25,
    pages: 1,
    total: 0,
    plans: [],
    settings: {},
    blockedSearch: '',
    editingPlan: null
  };

  var SECTION_META = {
    overview: ['Store dashboard', 'Everything important, in one place.'],
    orders: ['Orders', 'Search payments, retry deliveries and issue refunds.'],
    bundles: ['Bundles & pricing', 'Control what you sell and what it costs.'],
    customers: ['Customers & promos', 'See who buys the most and reward them.'],
    numbers: ['Blocked numbers', 'Stop specific numbers from buying.'],
    settings: ['Settings', 'Storefront content and support details.'],
    activity: ['Activity log', 'A record of every admin action.']
  };

  var NETWORK_CODES = { MTN: 'YELLO', Telecel: 'TELECEL', AirtelTigo: 'AT_PREMIUM' };
  var searchTimer = null;
  var blockedTimer = null;

  /* ------------------------------------------------------------ helpers */

  function money(v) { return 'GH₵' + Number(v || 0).toFixed(2); }

  function date(v) {
    try { return new Date(v).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return String(v || '—'); }
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function badge(status) {
    return '<span class="badge ' + esc(status) + '">' + esc(String(status).replace(/_/g, ' ')) + '</span>';
  }

  function toast(message, kind) {
    var stack = $('#toastStack');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div><button class="toast-close" aria-label="Dismiss">×</button>';
    el.querySelector('.toast-close').addEventListener('click', function () { el.remove(); });
    stack.appendChild(el);
    setTimeout(function () { el.remove(); }, 5200);
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> ' + esc(label || 'Working…');
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }

  function api(url, options) {
    options = options || {};
    return fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body
    }).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error('Your session expired. Please sign in again.'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Request failed.');
        return data;
      });
    });
  }

  function showLogin() {
    $('#appView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
  }

  function showApp() {
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    loadWallet();
    switchSection(state.section);
  }

  /* --------------------------------------------------------------- auth */

  $('#loginForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var btn = $('#loginBtn');
    $('#loginError').textContent = '';
    setBusy(btn, true, 'Signing in…');
    api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) })
      .then(function () { $('#password').value = ''; showApp(); toast('Welcome back.', 'success'); })
      .catch(function (err) { $('#loginError').textContent = err.message; })
      .finally(function () { setBusy(btn, false); });
  });

  $('#logoutBtn').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' }).catch(function () {}).finally(showLogin);
  });

  /* ----------------------------------------------------------- navigation */

  function switchSection(name) {
    state.section = name;
    $$('.admin-section').forEach(function (el) { el.classList.add('hidden'); });
    var target = $('#section-' + name);
    if (target) target.classList.remove('hidden');

    $$('.side-link, .appnav button').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.section === name);
    });

    var meta = SECTION_META[name] || SECTION_META.overview;
    $('#pageTitle').textContent = meta[0];
    $('#pageSubtitle').textContent = meta[1];

    if (name === 'overview') loadDashboard();
    if (name === 'orders') { loadOrders(); loadStats(); }
    if (name === 'bundles') loadPlans();
    if (name === 'customers' && window.AbrantsCustomers) window.AbrantsCustomers.load();
    if (name === 'numbers') loadBlocked();
    if (name === 'settings') loadSettings();
    if (name === 'activity') loadAudit();

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.addEventListener('click', function (event) {
    var nav = event.target.closest('[data-section]');
    if (nav) { switchSection(nav.dataset.section); return; }
  });

  $('#refreshBtn').addEventListener('click', function () {
    loadWallet();
    switchSection(state.section);
    toast('Refreshed.');
  });

  /* ----------------------------------------------------------- dashboard */

  function renderChart(series) {
    var svg = $('#salesChart');
    if (!series || !series.length) { svg.innerHTML = ''; return; }

    var W = 560, H = 150, pad = 6;
    var max = Math.max.apply(null, series.map(function (d) { return Math.max(d.revenue, d.profit); }));
    if (!max) max = 1;

    var slot = W / series.length;
    var barW = Math.max(slot * 0.5, 6);

    var bars = series.map(function (d, i) {
      var h = Math.max((d.revenue / max) * (H - pad * 2), d.revenue > 0 ? 3 : 1.5);
      var x = i * slot + (slot - barW) / 2;
      var y = H - pad - h;
      var fill = d.revenue > 0 ? '#ffd21c' : '#1e2534';
      return '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + barW.toFixed(2) +
        '" height="' + h.toFixed(2) + '" rx="2.5" fill="' + fill + '">' +
        '<title>' + esc(d.day) + ': ' + money(d.revenue) + ' revenue · ' + d.orders + ' orders</title></rect>';
    }).join('');

    var points = series.map(function (d, i) {
      var h = Math.max((d.profit / max) * (H - pad * 2), 0);
      var x = i * slot + slot / 2;
      var y = H - pad - h;
      return x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' ');

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML =
      '<line x1="0" y1="' + (H - pad) + '" x2="' + W + '" y2="' + (H - pad) + '" stroke="#242b3a" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
      bars +
      '<polyline points="' + points + '" fill="none" stroke="#34d399" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>';
  }

  function renderAlerts(s) {
    var html = '';
    if (s.lowWallet) {
      html += '<div class="alert-strip"><span class="ico">⚠</span><div><strong>Provider wallet is running low.</strong><br>' +
        'Balance is ' + money(s.wallet) + ', below your ' + money(s.lowWalletThreshold) +
        ' threshold. Top up DataHustle so deliveries do not start failing.</div></div>';
    }
    if (s.maintenanceMode) {
      html += '<div class="alert-strip warn"><span class="ico">🛠</span><div><strong>Maintenance mode is ON.</strong><br>' +
        'Customers cannot start new checkouts right now. Turn it off in Settings when you are ready.</div></div>';
    }
    if (s.mockMode) {
      html += '<div class="alert-strip info"><span class="ico">ℹ</span><div><strong>Mock mode is enabled.</strong><br>' +
        'No real provider purchases are being made. Set <code>DATAHUSTLE_MOCK_MODE=false</code> before going live.</div></div>';
    }
    $('#alerts').innerHTML = html;
  }

  function loadStats() {
    return api('/api/admin/stats').then(function (s) {
      $('#revenue').textContent = money(s.revenue);
      $('#realizedProfit').textContent = money(s.realizedProfit);
      $('#last7d').textContent = s.last7d;
      $('#attention').textContent = (s.pending + s.deliveryFailed + (s.deliveryReview || 0) + (s.refunding || 0));
      $('#attentionCard').classList.toggle('alert', (s.pending + s.deliveryFailed + (s.deliveryReview || 0)) > 0);

      var counts = {
        all: s.total, pending: s.pending, paid: s.paid, processing: s.processing,
        fulfilled: s.fulfilled, failed: s.deliveryFailed, review: s.deliveryReview,
        refunding: s.refunding, refunded: s.refunded
      };
      Object.keys(counts).forEach(function (key) {
        var el = $('#s-' + key);
        if (el) el.textContent = counts[key] || 0;
      });
      return s;
    });
  }

  function loadDashboard() {
    loadStats().then(function (s) {
      ['today', 'week', 'month'].forEach(function (key) {
        var p = (s.periods && s.periods[key]) || { orders: 0, revenue: 0, profit: 0 };
        var rev = $('#' + key + 'Revenue');
        if (rev) rev.textContent = money(p.revenue);
        var ord = $('#' + key + 'Orders');
        if (ord) ord.textContent = p.orders;
        var prof = $('#' + key + 'Profit');
        if (prof) prof.textContent = money(p.profit);
      });

      renderChart(s.series || []);
      renderAlerts(s);

      var bundles = s.topBundles || [];
      $('#topBundles').innerHTML = bundles.length
        ? bundles.map(function (b) {
          return '<div class="list-row"><div class="lr-main"><strong>' + esc(b.network) + ' · ' + esc(b.label) +
            '</strong><small>' + b.orders + ' order' + (b.orders === 1 ? '' : 's') + '</small></div>' +
            '<div class="lr-value"><strong>' + money(b.revenue) + '</strong>' +
            '<small class="' + (b.profit < 0 ? 'neg' : 'pos') + '">' + money(b.profit) + ' profit</small></div></div>';
        }).join('')
        : '<div class="empty"><div>⌁</div><strong>No sales yet</strong><p>Sales from the last 30 days will appear here.</p></div>';

      var nets = s.networks || [];
      $('#networkSplit').innerHTML = nets.length
        ? nets.map(function (n) {
          return '<div class="list-row"><div class="lr-main"><strong>' + esc(n.network) + '</strong>' +
            '<small>' + n.orders + ' order' + (n.orders === 1 ? '' : 's') + '</small></div>' +
            '<div class="lr-value"><strong>' + money(n.revenue) + '</strong></div></div>';
        }).join('')
        : '<div class="empty"><div>⌁</div><strong>No network data</strong><p>Nothing sold in the last 30 days.</p></div>';
    }).catch(function (err) {
      if (err.message.indexOf('session') === -1) toast(err.message, 'error');
    });
  }

  function loadWallet() {
    var pill = $('#walletPill');
    api('/api/admin/wallet').then(function (w) {
      pill.classList.remove('err', 'low', 'mock');
      var low = w.lowWalletThreshold > 0 && w.balance < w.lowWalletThreshold;
      if (low) pill.classList.add('low');
      if (w.mockMode) pill.classList.add('mock');
      pill.textContent = (w.mockMode ? 'Mock · ' : '') + 'Wallet ' + money(w.balance);
      pill.title = w.mockMode ? 'Mock mode: no real provider purchases' : 'DataHustle wallet balance';
    }).catch(function () {
      pill.classList.remove('low', 'mock');
      pill.classList.add('err');
      pill.textContent = 'Wallet unavailable';
    });
  }

  /* -------------------------------------------------------------- orders */

  function orderQuery(extra) {
    var q = new URLSearchParams({
      status: state.status,
      search: state.search,
      network: state.network,
      from: state.from,
      to: state.to
    });
    if (extra) Object.keys(extra).forEach(function (k) { q.set(k, extra[k]); });
    return q.toString();
  }

  function loadOrders() {
    var body = $('#ordersBody');
    body.innerHTML = '<tr><td colspan="7"><div class="skeleton-row"></div><div class="skeleton-row" style="width:60%"></div></td></tr>';
    api('/api/admin/orders?' + orderQuery({ page: state.page, pageSize: state.pageSize }))
      .then(function (data) {
        var rows = data.rows || [];
        state.total = data.total || 0;
        state.pages = data.pages || 1;
        state.page = data.page || 1;

        body.innerHTML = rows.map(function (o) {
          return '<tr>' +
            '<td data-label="Order"><span class="ref">' + esc(o.reference) + '</span><span class="sub">' + esc(o.network) + '</span></td>' +
            '<td data-label="Customer">' + esc(o.phone) + '<span class="sub">' + esc(o.email || '—') + '</span></td>' +
            '<td data-label="Bundle"><strong>' + esc(o.label) + '</strong><span class="sub">' + esc(o.capacityGB) + 'GB · ' + esc(o.network) + '</span></td>' +
            '<td data-label="Amount"><strong>' + (o.source === 'gift' ? 'FREE gift' : money(o.priceGHS)) + '</strong>' +
            (o.estimatedProfitGHS == null ? '' : '<span class="sub ' + (o.estimatedProfitGHS < 0 ? 'neg' : 'pos') + '">' + money(o.estimatedProfitGHS) + '</span>') + '</td>' +
            '<td data-label="Status">' + badge(o.status) + '</td>' +
            '<td data-label="Date">' + date(o.createdAt) + '</td>' +
            '<td data-label=""><div class="cell-actions"><button class="btn btn-subtle btn-sm" data-view="' + esc(o.reference) + '">View</button></div></td>' +
            '</tr>';
        }).join('');

        $('#empty').classList.toggle('hidden', rows.length > 0);
        var from = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
        var to = Math.min(state.page * state.pageSize, state.total);
        $('#pagerInfo').textContent = state.total === 0
          ? 'No orders'
          : 'Showing ' + from + '–' + to + ' of ' + state.total;
        $('#prevPage').disabled = state.page <= 1;
        $('#nextPage').disabled = state.page >= state.pages;
      })
      .catch(function (err) {
        body.innerHTML = '';
        $('#empty').classList.remove('hidden');
        if (err.message.indexOf('session') === -1) toast(err.message, 'error');
      });
  }

  $('#statusCards').addEventListener('click', function (event) {
    var chip = event.target.closest('.chip');
    if (!chip) return;
    state.status = chip.dataset.status;
    state.page = 1;
    $$('#statusCards .chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
    loadOrders();
  });

  $('#search').addEventListener('input', function (event) {
    state.search = event.target.value.trim();
    state.page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadOrders, 260);
  });

  $('#filterNetwork').addEventListener('change', function (e) { state.network = e.target.value; state.page = 1; loadOrders(); });
  $('#filterFrom').addEventListener('change', function (e) { state.from = e.target.value; state.page = 1; loadOrders(); });
  $('#filterTo').addEventListener('change', function (e) { state.to = e.target.value; state.page = 1; loadOrders(); });
  $('#prevPage').addEventListener('click', function () { if (state.page > 1) { state.page--; loadOrders(); } });
  $('#nextPage').addEventListener('click', function () { if (state.page < state.pages) { state.page++; loadOrders(); } });

  $('#exportBtn').addEventListener('click', function () {
    var q = new URLSearchParams({
      status: state.status, search: state.search, network: state.network, from: state.from, to: state.to
    });
    window.location.href = '/api/admin/orders/export?' + q.toString();
    toast('Preparing your CSV download…');
  });

  $('#ordersBody').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-view]');
    if (btn) openOrder(btn.dataset.view);
  });

  /* --------------------------------------------------------- order drawer */

  function closeDrawer() { $('#drawer').classList.add('hidden'); }
  $('#closeDrawer').addEventListener('click', closeDrawer);
  $('#drawer').addEventListener('click', function (e) { if (e.target.id === 'drawer') closeDrawer(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeDrawer();
    closePlanModal();
  });

  function openOrder(reference) {
    var content = $('#drawerContent');
    content.innerHTML = '<div class="skeleton-row" style="height:22px"></div><div class="skeleton-row"></div><div class="skeleton-row" style="width:70%"></div>';
    $('#drawer').classList.remove('hidden');

    Promise.all([
      api('/api/admin/orders?search=' + encodeURIComponent(reference) + '&limit=5'),
      api('/api/admin/orders/' + encodeURIComponent(reference) + '/events')
    ]).then(function (results) {
      var orders = Array.isArray(results[0]) ? results[0] : (results[0].rows || []);
      var events = Array.isArray(results[1]) ? results[1] : (results[1].rows || []);
      var o = orders.filter(function (x) { return x.reference === reference; })[0];
      if (!o) throw new Error('Order not found.');

      var canRetry = ['delivery_review', 'delivery_failed', 'paid'].indexOf(o.status) !== -1 && !o.providerReference;
      var canRefund = ['delivery_failed', 'delivery_review', 'paid'].indexOf(o.status) !== -1 && o.refundStatus !== 'processed';

      content.innerHTML =
        '<div class="drawer-head">' +
          '<div><p class="eyebrow">Order details</p><h2>' + esc(o.reference) + '</h2>' + badge(o.status) + '</div>' +
        '</div>' +
        '<div class="drawer-actions">' +
          '<button class="btn btn-ghost btn-sm" data-copy="' + esc(o.reference) + '">Copy reference</button>' +
          (canRetry ? '<button class="btn btn-primary btn-sm" data-retry="' + esc(o.reference) + '">↻ Retry delivery</button>' : '') +
          (canRefund ? '<button class="btn btn-danger btn-sm" data-refund="' + esc(o.reference) + '">Refund customer</button>' : '') +
        '</div>' +
        '<div class="detail-grid">' +
          '<div class="detail-box"><span>Customer</span><strong>' + esc(o.phone) + '</strong></div>' +
          '<div class="detail-box"><span>Email</span><strong>' + esc(o.email || '—') + '</strong></div>' +
          '<div class="detail-box"><span>Customer paid</span><strong>' + money(o.priceGHS) + '</strong></div>' +
          '<div class="detail-box"><span>Provider cost</span><strong>' + (o.providerCostGHS == null ? '—' : money(o.providerCostGHS)) + '</strong></div>' +
          '<div class="detail-box"><span>Paystack fee</span><strong>' + (o.paymentFeeGHS == null ? '—' : money(o.paymentFeeGHS)) + '</strong></div>' +
          '<div class="detail-box"><span>Est. profit</span><strong class="' + ((o.estimatedProfitGHS || 0) < 0 ? 'neg' : 'pos') + '">' +
            (o.estimatedProfitGHS == null ? '—' : money(o.estimatedProfitGHS)) + '</strong></div>' +
          '<div class="detail-box"><span>Bundle</span><strong>' + esc(o.label) + ' · ' + esc(o.network) + '</strong></div>' +
          '<div class="detail-box"><span>Created</span><strong>' + date(o.createdAt) + '</strong></div>' +
          '<div class="detail-box"><span>Provider ref</span><strong>' + esc(o.providerReference || '—') + '</strong></div>' +
          '<div class="detail-box"><span>Tracking ID</span><strong>' + esc(o.trackingId || '—') + '</strong></div>' +
          '<div class="detail-box"><span>Refund status</span><strong>' + esc(o.refundStatus || '—') + '</strong></div>' +
          '<div class="detail-box"><span>Refund ID</span><strong>' + esc(o.refundId || '—') + '</strong></div>' +
        '</div>' +

        '<h3 style="margin:18px 0 8px;font-size:15px">Support note</h3>' +
        '<label class="field"><textarea id="orderNote" maxlength="500" placeholder="Add a note for whoever handles this order next…">' + esc(o.adminNote || '') + '</textarea></label>' +
        '<button class="btn btn-ghost btn-sm" data-note="' + esc(o.reference) + '" style="margin-top:8px">Save note</button>' +

        '<h3 style="margin:20px 0 8px;font-size:15px">Change status</h3>' +
        '<div class="filter-row">' +
          '<label class="field"><span>Set status to</span>' +
          '<select id="orderStatusSelect">' +
            ['pending', 'paid', 'processing', 'fulfilled', 'delivery_failed', 'delivery_review', 'refunding', 'refunded']
              .map(function (s) { return '<option value="' + s + '"' + (s === o.status ? ' selected' : '') + '>' + s.replace(/_/g, ' ') + '</option>'; }).join('') +
          '</select></label>' +
          '<label class="field"><span>&nbsp;</span><button class="btn btn-ghost" data-status-set="' + esc(o.reference) + '">Apply status</button></label>' +
        '</div>' +

        '<h3 style="margin:20px 0 8px;font-size:15px">Order history</h3>' +
        '<div class="timeline">' +
          (events.length ? events.map(function (e) {
            return '<div class="event"><small>' + date(e.createdAt) + '</small><strong>' + esc(e.eventType) + '</strong>' +
              '<pre>' + esc(JSON.stringify(e.details || {}, null, 2)) + '</pre></div>';
          }).join('') : '<div class="empty"><div>⌁</div><strong>No events yet</strong></div>') +
        '</div>';
    }).catch(function (err) {
      content.innerHTML = '<div class="empty"><div>!</div><strong>Could not load this order</strong><p>' + esc(err.message) + '</p></div>';
    });
  }

  $('#drawerContent').addEventListener('click', function (event) {
    var copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
      var ref = copyBtn.dataset.copy;
      if (navigator.clipboard) navigator.clipboard.writeText(ref);
      toast('Reference copied.', 'success');
      return;
    }

    var noteBtn = event.target.closest('[data-note]');
    if (noteBtn) {
      var note = ($('#orderNote') || {}).value || '';
      setBusy(noteBtn, true, 'Saving…');
      api('/api/admin/orders/' + encodeURIComponent(noteBtn.dataset.note) + '/note', {
        method: 'POST', body: JSON.stringify({ note: note })
      }).then(function () { toast('Note saved.', 'success'); })
        .catch(function (err) { toast(err.message, 'error'); })
        .finally(function () { setBusy(noteBtn, false); });
      return;
    }

    var retryBtn = event.target.closest('[data-retry]');
    if (retryBtn) {
      if (!confirm('Retry delivery for ' + retryBtn.dataset.retry + '?\n\nOnly do this if the provider did NOT already deliver.')) return;
      setBusy(retryBtn, true, 'Retrying…');
      api('/api/admin/orders/' + encodeURIComponent(retryBtn.dataset.retry) + '/retry', { method: 'POST' })
        .then(function () { toast('Retry accepted by the provider.', 'success'); openOrder(retryBtn.dataset.retry); loadOrders(); })
        .catch(function (err) { toast(err.message, 'error'); setBusy(retryBtn, false); });
      return;
    }

    var refundBtn = event.target.closest('[data-refund]');
    if (refundBtn) {
      if (!confirm('Refund this customer through Paystack?\n\nThis is real money and cannot be undone from here.')) return;
      setBusy(refundBtn, true, 'Refunding…');
      api('/api/admin/orders/' + encodeURIComponent(refundBtn.dataset.refund) + '/refund', { method: 'POST' })
        .then(function () { toast('Refund queued with Paystack.', 'success'); openOrder(refundBtn.dataset.refund); loadOrders(); })
        .catch(function (err) { toast(err.message, 'error'); setBusy(refundBtn, false); });
      return;
    }

    var statusBtn = event.target.closest('[data-status-set]');
    if (statusBtn) {
      var select = $('#orderStatusSelect');
      if (!select) return;
      if (!confirm('Force this order to "' + select.value.replace(/_/g, ' ') + '"?\n\nUse this only to correct a wrong state.')) return;
      setBusy(statusBtn, true, 'Applying…');
      api('/api/admin/orders/' + encodeURIComponent(statusBtn.dataset.statusSet) + '/status', {
        method: 'POST', body: JSON.stringify({ status: select.value })
      }).then(function () { toast('Status updated.', 'success'); openOrder(statusBtn.dataset.statusSet); loadOrders(); })
        .catch(function (err) { toast(err.message, 'error'); setBusy(statusBtn, false); });
    }
  });

  /* ------------------------------------------------------------- bundles */

  function planProfit(plan) {
    var fee = Number(plan.priceGHS) * 0.0195;
    return Number(plan.priceGHS) - Number(plan.providerCostGHS || 0) - fee;
  }

  function loadPlans() {
    var grid = $('#plansGridAdmin');
    grid.innerHTML = '<div class="skeleton-row" style="height:120px"></div><div class="skeleton-row" style="height:120px"></div>';
    api('/api/admin/plans').then(function (plans) {
      state.plans = plans;
      grid.innerHTML = plans.map(function (p) {
        var profit = planProfit(p);
        var margin = Number(p.priceGHS) ? (profit / Number(p.priceGHS)) * 100 : 0;
        var unit = Number(p.capacityGB) > 0 ? Number(p.priceGHS) / Number(p.capacityGB) : null;
        return '<article class="setting-card' + (p.active ? '' : ' inactive') + '">' +
          '<div class="setting-top">' +
            '<div>' +
              '<span class="network-label">' + esc(p.network) + '</span>' +
              '<h3>' + esc(p.label) + '</h3>' +
              '<div class="meta">' + esc(p.capacityGB) + 'GB · ' + esc(p.validity) + (unit ? ' · ' + money(unit) + '/GB' : '') + '</div>' +
            '</div>' +
            '<label class="switch" title="Show on the storefront">' +
              '<input type="checkbox" data-toggle="' + esc(p.id) + '"' + (p.active ? ' checked' : '') + ' />' +
              '<span class="track"></span><span>' + (p.active ? 'Live' : 'Hidden') + '</span>' +
            '</label>' +
          '</div>' +
          '<div class="profit-preview">' +
            '<span>Est. profit</span><strong class="' + (profit < 0 ? 'neg' : 'pos') + '">' + money(profit) + '</strong>' +
            '<em>' + margin.toFixed(1) + '% margin · fee ' + money(Number(p.priceGHS) * 0.0195) + '</em>' +
          '</div>' +
          '<div class="setting-editors">' +
            '<label class="field"><span>Customer price (GH₵)</span>' +
              '<div class="editor-row"><input type="number" min="0.01" step="0.01" value="' + Number(p.priceGHS).toFixed(2) + '" data-price="' + esc(p.id) + '" />' +
              '<button class="btn btn-primary btn-sm" data-save-price="' + esc(p.id) + '">Save</button></div>' +
            '</label>' +
            '<label class="field"><span>Provider cost (GH₵)</span>' +
              '<div class="editor-row"><input type="number" min="0" step="0.01" value="' + Number(p.providerCostGHS || 0).toFixed(2) + '" data-cost="' + esc(p.id) + '" />' +
              '<button class="btn btn-ghost btn-sm" data-save-cost="' + esc(p.id) + '">Save</button></div>' +
            '</label>' +
          '</div>' +
          '<div class="setting-foot">' +
            '<span class="fee-note">Code: ' + esc(p.networkCode) + '</span>' +
            '<div class="panel-actions">' +
              '<button class="btn btn-subtle btn-sm" data-edit-plan="' + esc(p.id) + '">Edit</button>' +
              '<button class="btn btn-danger btn-sm" data-delete-plan="' + esc(p.id) + '">Remove</button>' +
            '</div>' +
          '</div>' +
        '</article>';
      }).join('');
    }).catch(function (err) { grid.innerHTML = '<p class="notice bad">' + esc(err.message) + '</p>'; });
  }

  function findPlan(id) {
    return state.plans.filter(function (p) { return p.id === id; })[0];
  }

  $('#plansGridAdmin').addEventListener('click', function (event) {
    var savePrice = event.target.closest('[data-save-price]');
    if (savePrice) {
      var id = savePrice.dataset.savePrice;
      var input = document.querySelector('[data-price="' + CSS.escape(id) + '"]');
      setBusy(savePrice, true, 'Saving…');
      api('/api/admin/plans/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify({ priceGHS: Number(input.value) })
      }).then(function () { toast('Price updated.', 'success'); loadPlans(); loadStats(); })
        .catch(function (err) { toast(err.message, 'error'); setBusy(savePrice, false); });
      return;
    }

    var saveCost = event.target.closest('[data-save-cost]');
    if (saveCost) {
      var cid = saveCost.dataset.saveCost;
      var cinput = document.querySelector('[data-cost="' + CSS.escape(cid) + '"]');
      setBusy(saveCost, true, 'Saving…');
      api('/api/admin/plans/' + encodeURIComponent(cid) + '/cost', {
        method: 'PUT', body: JSON.stringify({ providerCostGHS: Number(cinput.value) })
      }).then(function () { toast('Provider cost updated.', 'success'); loadPlans(); })
        .catch(function (err) { toast(err.message, 'error'); setBusy(saveCost, false); });
      return;
    }

    var edit = event.target.closest('[data-edit-plan]');
    if (edit) { openPlanModal(findPlan(edit.dataset.editPlan)); return; }

    var del = event.target.closest('[data-delete-plan]');
    if (del) {
      var plan = findPlan(del.dataset.deletePlan);
      if (!confirm('Remove "' + (plan ? plan.label + ' · ' + plan.network : del.dataset.deletePlan) + '"?\n\nIf it already has orders it will be hidden from customers instead of deleted.')) return;
      setBusy(del, true, 'Removing…');
      api('/api/admin/plans/' + encodeURIComponent(del.dataset.deletePlan), { method: 'DELETE' })
        .then(function (r) {
          toast(r.archived ? 'Bundle hidden — it has past orders so it was not deleted.' : 'Bundle deleted.', 'success');
          loadPlans();
        })
        .catch(function (err) { toast(err.message, 'error'); setBusy(del, false); });
    }
  });

  $('#plansGridAdmin').addEventListener('change', function (event) {
    var toggle = event.target.closest('[data-toggle]');
    if (!toggle) return;
    var id = toggle.dataset.toggle;
    api('/api/admin/plans/' + encodeURIComponent(id), {
      method: 'PUT', body: JSON.stringify({ active: toggle.checked })
    }).then(function () {
      toast(toggle.checked ? 'Bundle is now live.' : 'Bundle hidden from customers.', 'success');
      loadPlans();
    }).catch(function (err) { toast(err.message, 'error'); toggle.checked = !toggle.checked; });
  });

  /* --------------------------------------------------------- plan modal */

  function openPlanModal(plan) {
    state.editingPlan = plan || null;
    $('#planModalKicker').textContent = plan ? 'Edit bundle' : 'New bundle';
    $('#planModalTitle').textContent = plan ? (plan.label + ' · ' + plan.network) : 'Add a bundle';
    $('#planNetwork').value = plan ? plan.network : 'MTN';
    $('#planLabel').value = plan ? plan.label : '';
    $('#planCapacity').value = plan ? plan.capacityGB : '';
    $('#planValidity').value = plan ? plan.validity : '30 days';
    $('#planPrice').value = plan ? Number(plan.priceGHS).toFixed(2) : '';
    $('#planCost').value = plan && plan.providerCostGHS != null ? Number(plan.providerCostGHS).toFixed(2) : '';
    $('#planNetworkCode').value = plan ? plan.networkCode : 'YELLO';
    $('#planLabel').readOnly = Boolean(plan);
    $('#planCapacity').readOnly = Boolean(plan);
    $('#planNetwork').disabled = Boolean(plan);
    $('#planNetworkCode').readOnly = Boolean(plan);
    $('#planModal').classList.remove('hidden');
  }

  function closePlanModal() { $('#planModal').classList.add('hidden'); }

  $('#addPlanBtn').addEventListener('click', function () { openPlanModal(null); });
  $('#closePlanModal').addEventListener('click', closePlanModal);
  $('#cancelPlanBtn').addEventListener('click', closePlanModal);
  $('#planModal').addEventListener('click', function (e) { if (e.target.id === 'planModal') closePlanModal(); });

  $('#planNetwork').addEventListener('change', function (e) {
    $('#planNetworkCode').value = NETWORK_CODES[e.target.value] || '';
  });

  $('#planForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var btn = $('#savePlanBtn');
    var payload = {
      network: $('#planNetwork').value,
      label: $('#planLabel').value.trim(),
      capacityGB: Number($('#planCapacity').value),
      validity: $('#planValidity').value.trim() || '30 days',
      priceGHS: Number($('#planPrice').value),
      providerCostGHS: $('#planCost').value === '' ? null : Number($('#planCost').value),
      networkCode: $('#planNetworkCode').value.trim()
    };

    var isEdit = Boolean(state.editingPlan);
    var url = isEdit ? '/api/admin/plans/' + encodeURIComponent(state.editingPlan.id) : '/api/admin/plans';
    var method = isEdit ? 'PUT' : 'POST';
    if (isEdit) delete payload.label, delete payload.capacityGB, delete payload.network, delete payload.networkCode;

    setBusy(btn, true, 'Saving…');
    api(url, { method: method, body: JSON.stringify(payload) })
      .then(function () {
        toast(isEdit ? 'Bundle updated.' : 'Bundle created.', 'success');
        closePlanModal();
        loadPlans();
      })
      .catch(function (err) { toast(err.message, 'error'); })
      .finally(function () { setBusy(btn, false); });
  });

  /* ----------------------------------------------------- blocked numbers */

  function loadBlocked() {
    var body = $('#blockedBody');
    api('/api/admin/blocked-numbers?search=' + encodeURIComponent(state.blockedSearch)).then(function (rows) {
      body.innerHTML = rows.map(function (r) {
        return '<tr>' +
          '<td data-label="Phone"><strong>' + esc(r.phone) + '</strong></td>' +
          '<td data-label="Reason">' + esc(r.reason || '—') + '</td>' +
          '<td data-label="Blocked on">' + date(r.createdAt) + '</td>' +
          '<td data-label=""><div class="cell-actions"><button class="btn btn-ghost btn-sm" data-unblock="' + esc(r.phone) + '">Unblock</button></div></td>' +
          '</tr>';
      }).join('');
      $('#blockedEmpty').classList.toggle('hidden', rows.length > 0);
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  $('#blockedSearch').addEventListener('input', function (event) {
    state.blockedSearch = event.target.value.trim();
    clearTimeout(blockedTimer);
    blockedTimer = setTimeout(loadBlocked, 260);
  });

  $('#blockForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var msg = $('#blockMessage');
    msg.textContent = '';
    msg.className = 'notice';
    var phone = $('#blockPhone').value.replace(/\D/g, '');
    var reason = $('#blockReason').value.trim();
    if (!/^0\d{9}$/.test(phone)) {
      msg.textContent = 'Enter a valid 10-digit Ghana phone number.';
      msg.className = 'notice bad';
      return;
    }
    api('/api/admin/blocked-numbers', { method: 'POST', body: JSON.stringify({ phone: phone, reason: reason }) })
      .then(function () {
        $('#blockPhone').value = '';
        $('#blockReason').value = '';
        msg.textContent = 'Number blocked successfully.';
        msg.className = 'notice ok';
        toast('Number blocked.', 'success');
        loadBlocked();
      })
      .catch(function (err) { msg.textContent = err.message; msg.className = 'notice bad'; });
  });

  $('#blockedBody').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-unblock]');
    if (!btn) return;
    if (!confirm('Unblock ' + btn.dataset.unblock + '?')) return;
    setBusy(btn, true, '…');
    api('/api/admin/blocked-numbers/' + encodeURIComponent(btn.dataset.unblock), { method: 'DELETE' })
      .then(function () { toast('Number unblocked.', 'success'); loadBlocked(); })
      .catch(function (err) { toast(err.message, 'error'); setBusy(btn, false); });
  });

  /* ------------------------------------------------------------ settings */

  function loadSettings() {
    api('/api/admin/settings').then(function (s) {
      state.settings = s;
      $('#setStoreName').value = s.storeName || '';
      $('#setAnnouncement').value = s.announcement || '';
      $('#setAnnounceEnabled').checked = Boolean(s.announcementEnabled);
      $('#setWhatsapp').value = s.supportWhatsapp || '';
      $('#setSupportPhone').value = s.supportPhone || '';
      $('#setChannelLink').value = s.channelLink || '';
      $('#setLowWallet').value = s.lowWalletThreshold || 0;
      $('#setMaintenance').checked = Boolean(s.maintenanceMode);
      $('#setMaintenanceMsg').value = s.maintenanceMessage || '';
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  $('#settingsForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var btn = $('#saveSettingsBtn');
    var msg = $('#settingsMessage');
    msg.textContent = '';
    msg.className = 'notice';
    var payload = {
      storeName: $('#setStoreName').value.trim(),
      announcement: $('#setAnnouncement').value.trim(),
      announcementEnabled: $('#setAnnounceEnabled').checked,
      supportWhatsapp: $('#setWhatsapp').value.trim(),
      supportPhone: $('#setSupportPhone').value.trim(),
      channelLink: $('#setChannelLink').value.trim(),
      lowWalletThreshold: Number($('#setLowWallet').value || 0),
      maintenanceMode: $('#setMaintenance').checked,
      maintenanceMessage: $('#setMaintenanceMsg').value.trim()
    };
    setBusy(btn, true, 'Saving…');
    api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) })
      .then(function () {
        msg.textContent = 'Settings saved. The storefront updates within a few seconds.';
        msg.className = 'notice ok';
        toast('Settings saved.', 'success');
        loadWallet();
      })
      .catch(function (err) { msg.textContent = err.message; msg.className = 'notice bad'; })
      .finally(function () { setBusy(btn, false); });
  });

  /* --------------------------------------------------------- audit log */

  function loadAudit() {
    var list = $('#auditList');
    list.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row" style="width:70%"></div>';
    api('/api/admin/audit?limit=120').then(function (rows) {
      list.innerHTML = rows.length
        ? rows.map(function (r) {
          return '<div class="list-row"><div class="lr-main"><strong>' + esc(String(r.action).replace(/\./g, ' › ')) + '</strong>' +
            '<small>' + date(r.createdAt) + (r.ip ? ' · ' + esc(r.ip) : '') + '</small></div>' +
            '<div class="lr-value"><small class="ref">' + esc(JSON.stringify(r.details || {}).slice(0, 60)) + '</small></div></div>';
        }).join('')
        : '<div class="empty"><div>⌁</div><strong>Nothing logged yet</strong><p>Admin actions will show up here.</p></div>';
    }).catch(function (err) { list.innerHTML = '<p class="notice bad">' + esc(err.message) + '</p>'; });
  }

  /* ---------------------------------------------------------------- init */

  api('/api/admin/session')
    .then(function (s) { if (s.authenticated) showApp(); else showLogin(); })
    .catch(showLogin);
})();
