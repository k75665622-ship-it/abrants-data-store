/* Abrants Admin — result checkers & AFA (FastDealsGH) */
(function () {
  'use strict';
  var $ = function (sel) { return document.querySelector(sel); };
  var money = function (v) { return 'GH₵' + Number(v || 0).toFixed(2); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var when = function (v) { try { return new Date(v).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } };
  var label = { completed: 'delivered', submitted: 'AFA waiting', approved: 'approved', rejected: 'rejected', review: 'stuck', paid: 'sending', sending: 'sending', failed: 'failed', refunding: 'refunding', refunded: 'refunded' };
  var st = { status: '', data: null, open: null };

  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div>';
    $('#toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }
  function api(url, method, body) {
    return fetch(url, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        if (res.status === 401) { location.reload(); throw new Error('Session expired.'); }
        return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok) throw new Error(d.error || 'Request failed.'); return d; });
      });
  }
  function busy(btn, on, text) {
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(text); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function badge(s) { return '<span class="badge ' + esc(s) + '">' + esc(label[s] || s) + '</span>'; }

  function profitLine(price, cost) {
    if (!(price > 0) || cost == null) return '';
    var p = price - cost;
    return ' · profit <span class="' + (p > 0 ? 'pos' : 'neg') + '">' + money(p) + '</span>';
  }
  function priceRow(key, name, cost, stock, conf, outOfStock) {
    var price = conf.price == null ? '' : conf.price;
    return '<div class="svc-row" data-key="' + esc(key) + '"><div><strong>' + esc(name) + '</strong><small>Cost ' + (cost == null ? '—' : money(cost)) +
      (stock != null ? ' · ' + (outOfStock ? '<span class="neg">sold out</span>' : stock + ' in stock') : '') +
      '<span class="pl">' + profitLine(Number(price), cost) + '</span></small></div>' +
      '<input type="number" inputmode="decimal" min="0" step="0.5" placeholder="Price" value="' + esc(price) + '" data-cost="' + (cost == null ? '' : cost) + '" aria-label="Your price for ' + esc(name) + '" />' +
      '<label class="switch"><input type="checkbox"' + (conf.enabled ? ' checked' : '') + ' /><span class="track"></span><span class="sr-only">Sell ' + esc(name) + '</span></label></div>';
  }

  function render(d) {
    st.data = d;
    $('#svcAlert').innerHTML = d.connected ? '' :
      '<div class="alert-strip warn"><span class="ico">!</span><div>FastDealsGH is not connected' + (d.error && d.error !== 'not_configured' ? ' (' + esc(d.error) + ')' : '. Add FASTDEALS_API_KEY in Render.') + '</div></div>';
    var s = d.summary || {};
    $('#svcStats').innerHTML =
      '<div class="detail-box"><span>FastDealsGH wallet</span><strong>' + (d.wallet == null ? '—' : money(d.wallet)) + '</strong></div>' +
      '<div class="detail-box"><span>Sold</span><strong>' + (s.sold || 0) + '</strong></div>' +
      '<div class="detail-box"><span>Profit</span><strong>' + money(s.profit) + '</strong></div>' +
      '<div class="detail-box"><span>Need attention</span><strong>' + (s.attention || 0) + '</strong></div>';

    var rows = d.checkers.map(function (c) {
      return priceRow(c.code, c.name, c.cost, c.stock, { price: c.price, enabled: c.enabled }, c.stock === 0);
    }).join('');
    rows += priceRow('AFA', 'AFA registration', d.afa.cost, null, { price: d.afa.price, enabled: d.afa.enabled });
    $('#svcPrices').innerHTML = d.connected || d.checkers.length ? rows : '<p class="muted">Prices appear once FastDealsGH is connected.</p>';

    var list = d.rows || [];
    $('#svcOrders').innerHTML = list.length ? list.map(orderRow).join('') : '<p class="muted" style="margin:6px 0">No orders yet.</p>';
  }

  function orderRow(o) {
    var open = st.open === o.reference;
    var detail = '';
    if (open) {
      var parts = ['<div><code>' + esc(o.reference) + '</code></div>',
        '<div>' + esc(o.phone) + ' · ' + esc(o.email) + '</div>',
        '<div>Sold ' + money(o.priceGHS) + (o.costGHS != null ? ' · cost ' + money(o.costGHS) : '') + (o.profitGHS != null ? ' · profit ' + money(o.profitGHS) : '') + '</div>'];
      if (o.pins && o.pins.length) parts.push('<div>' + o.pins.map(function (p) { return 'Serial <code>' + esc(p.serial) + '</code> PIN <code>' + esc(p.pin) + '</code>'; }).join('<br>') + '</div>');
      if (o.afa) parts.push('<div>' + esc(o.afa.full_name) + ' · ' + esc(o.afa.ghana_card_number) + (o.afa.date_of_birth ? ' · ' + esc(o.afa.date_of_birth) : '') + ' · ' + esc(o.afa.location) + ', ' + esc(o.afa.region) + '</div>');
      if (o.afaId) parts.push('<div>AFA ID <code>' + esc(o.afaId) + '</code></div>');
      if (o.note) parts.push('<div class="muted">' + esc(o.note) + '</div>');
      var btns = '';
      if (o.status === 'review' || o.status === 'paid') btns += '<button class="btn btn-primary btn-sm" data-svc-retry="' + esc(o.reference) + '">Retry</button>';
      if (['review', 'failed', 'rejected'].indexOf(o.status) >= 0) btns += '<button class="btn btn-danger btn-sm" data-svc-refund="' + esc(o.reference) + '">Refund customer</button>';
      if (btns) parts.push('<div class="drawer-actions">' + btns + '</div>');
      detail = '<div class="svc-detail">' + parts.join('') + '</div>';
    }
    return '<div class="svc-order"><button type="button" data-svc-open="' + esc(o.reference) + '" aria-expanded="' + open + '"><span><strong>' +
      esc(o.name) + (o.quantity > 1 ? ' × ' + o.quantity : '') + ' · ' + money(o.priceGHS) + '</strong><small>' + esc(o.phone) + ' · ' + when(o.createdAt) + '</small></span>' +
      badge(o.status) + '</button>' + detail + '</div>';
  }

  function load() {
    $('#svcOrders').innerHTML = '<div class="skeleton-row"></div>';
    return api('/api/admin/services' + (st.status ? '?status=' + encodeURIComponent(st.status) : '')).then(render)
      .catch(function (err) { $('#svcAlert').innerHTML = '<div class="alert-strip"><span class="ico">!</span><div>' + esc(err.message) + '</div></div>'; });
  }

  document.addEventListener('input', function (e) {
    var input = e.target.closest('#svcPrices input[type="number"]');
    if (!input) return;
    var cost = input.dataset.cost === '' ? null : Number(input.dataset.cost);
    input.closest('.svc-row').querySelector('.pl').innerHTML = profitLine(Number(input.value), cost);
  });

  document.addEventListener('click', function (e) {
    var t;
    if ((t = e.target.closest('#svcSave'))) {
      var body = { checkers: {}, afa: {} };
      Array.prototype.forEach.call(document.querySelectorAll('#svcPrices .svc-row'), function (row) {
        var conf = { price: row.querySelector('input[type="number"]').value, enabled: row.querySelector('input[type="checkbox"]').checked };
        if (row.dataset.key === 'AFA') body.afa = conf; else body.checkers[row.dataset.key] = conf;
      });
      busy(t, true, 'Saving…');
      api('/api/admin/services/prices', 'PUT', body).then(function () { toast('Prices saved.', 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); }).then(function () { busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-svc-status]'))) {
      Array.prototype.forEach.call(document.querySelectorAll('#svcFilter .chip'), function (c) { c.classList.toggle('active', c === t); });
      st.status = t.getAttribute('data-svc-status'); st.open = null; load();
      return;
    }
    if ((t = e.target.closest('[data-svc-open]'))) {
      var ref = t.getAttribute('data-svc-open');
      st.open = st.open === ref ? null : ref;
      render(st.data);
      return;
    }
    if ((t = e.target.closest('[data-svc-retry]'))) {
      busy(t, true, 'Retrying…');
      api('/api/admin/services/orders/' + encodeURIComponent(t.getAttribute('data-svc-retry')) + '/retry', 'POST', {})
        .then(function (o) { toast(o && o.status === 'review' ? 'Still not through. Check the FastDealsGH wallet.' : 'Done.', o && o.status === 'review' ? 'error' : 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-svc-refund]'))) {
      if (!confirm('Refund this customer through Paystack?')) return;
      busy(t, true, 'Refunding…');
      api('/api/admin/services/orders/' + encodeURIComponent(t.getAttribute('data-svc-refund')) + '/refund', 'POST', {})
        .then(function (o) { toast(o && o.status === 'refunding' ? 'Refund started.' : 'Refund did not go through. Refund it in Paystack.', o && o.status === 'refunding' ? 'success' : 'error'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); busy(t, false); });
    }
  });

  window.AbrantsServices = { load: load };
})();
