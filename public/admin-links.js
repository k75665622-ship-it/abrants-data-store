/* Abrants Admin — tracking links */
(function () {
  'use strict';
  var $ = function (sel) { return document.querySelector(sel); };
  var money = function (v) { return 'GH₵' + Number(v || 0).toFixed(2); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var st = { range: '30d', data: null, editing: null };

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
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(text); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }

  // The real domain comes from the store's SITE_URL setting. Without it, the address this page was opened on is used.
  function siteBase() { return (st.data && st.data.siteUrl) || window.location.origin; }
  function fullUrl(link) { return siteBase() + link.path; }

  function ago(v) {
    if (!v) return '';
    var s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' minutes ago';
    if (s < 86400) { var h = Math.round(s / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    var d = Math.round(s / 86400);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); } finally { ta.remove(); }
    });
  }

  function find(code) {
    var all = (st.data && st.data.links) || [];
    for (var i = 0; i < all.length; i++) if (all[i].code === code) return all[i];
    return null;
  }

  /* ---------------------------------------------------------------- render */

  function renderStats(d) {
    var t = d.totals;
    $('#lkStats').innerHTML =
      '<article class="stat-card"><span>Orders from links</span><strong>' + t.orders + '</strong><small>' + d.sharePercent + '% of all orders</small></article>' +
      '<article class="stat-card"><span>Customers</span><strong>' + t.customers + '</strong><small>' + t.newCustomers + ' new</small></article>' +
      '<article class="stat-card"><span>Sales</span><strong>' + money(t.revenueGHS) + '</strong><small>' + esc(d.ranges[d.range]) + '</small></article>' +
      '<article class="stat-card"><span>Profit</span><strong class="' + (t.profitGHS < 0 ? 'neg' : 'pos') + '">' + money(t.profitGHS) + '</strong><small>after costs and fees</small></article>';
  }

  function numbers(x, commission) {
    var out = '<div class="lk-nums">' +
      '<div><b>' + x.orders + '</b><span>orders</span></div>' +
      '<div><b>' + x.customers + '</b><span>customers' + (x.newCustomers ? ' · ' + x.newCustomers + ' new' : '') + '</span></div>' +
      '<div><b>' + money(x.revenueGHS) + '</b><span>sales</span></div>' +
      '<div><b class="' + (x.profitGHS < 0 ? 'neg' : 'pos') + '">' + money(x.profitGHS) + '</b><span>profit</span></div>';
    if (commission != null) out += '<div><b>' + money(commission) + '</b><span>commission</span></div>';
    return out + '</div>';
  }

  function editForm(l) {
    return '<form class="lk-edit" data-lk-form="' + esc(l.code) + '" autocomplete="off">' +
      '<div class="lk-grid">' +
      '<label class="field"><span>Name</span><input name="name" maxlength="60" required value="' + esc(l.name) + '" /></label>' +
      '<label class="field"><span>Commission per order</span><input name="commissionGHS" inputmode="decimal" value="' + (l.commissionGHS == null ? '' : esc(l.commissionGHS)) + '" /></label>' +
      '</div>' +
      '<label class="field" style="margin-top:10px"><span>Note</span><input name="note" maxlength="200" value="' + esc(l.note) + '" /></label>' +
      '<div class="lk-actions" style="margin-top:12px">' +
      '<button class="btn btn-primary btn-sm" type="submit">Save</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-lk-cancel>Cancel</button>' +
      '<button class="btn btn-danger btn-sm" type="button" data-lk-delete="' + esc(l.code) + '">Delete</button>' +
      '</div></form>';
  }

  function card(l) {
    var head = '<div class="lk-top"><div><strong>' + esc(l.name) + '</strong>' +
      (l.note ? '<small>' + esc(l.note) + '</small>' : '') + '</div></div>';
    if (st.editing === l.code) return '<div class="lk-card">' + head + editForm(l) + '</div>';
    return '<div class="lk-card">' + head +
      '<div class="lk-url">' + esc(fullUrl(l)) + '</div>' +
      '<div class="lk-actions">' +
      '<button class="btn btn-primary btn-sm" type="button" data-lk-copy="' + esc(l.code) + '">Copy link</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-lk-wa="' + esc(l.code) + '">WhatsApp</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-lk-edit="' + esc(l.code) + '">Edit</button>' +
      '</div>' + numbers(l, l.commissionEarnedGHS) +
      '<small class="lk-last">' + (l.lastOrderAt ? 'Last order ' + esc(ago(l.lastOrderAt)) : 'No orders yet') + '</small></div>';
  }

  function render(d) {
    st.data = d;
    // Opened Admin on the Render address and no real domain is set: links would say onrender.com.
    $('#lkAlert').innerHTML = !d.siteUrl && /\.onrender\.com$/i.test(window.location.hostname)
      ? '<div class="alert-strip warn"><span class="ico">!</span><div>Links will say ' + esc(window.location.hostname) + '. Add SITE_URL in Render, or open Admin on your own domain.</div></div>' : '';
    renderStats(d);
    Array.prototype.forEach.call(document.querySelectorAll('#lkRange .chip'), function (c) {
      c.classList.toggle('active', c.getAttribute('data-lk-range') === d.range);
    });
    $('#lkList').innerHTML = d.links.length ? d.links.map(card).join('') : '<p class="muted" style="margin:6px 0">No links yet.</p>';

    var others = d.others || [];
    $('#lkOthersPanel').classList.toggle('hidden', !others.length);
    $('#lkOthers').innerHTML = others.map(function (o) {
      return '<div class="lk-card"><div class="lk-top"><div><strong>' + esc(o.code) + '</strong></div>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-lk-save="' + esc(o.code) + '">Save as link</button></div>' + numbers(o) + '</div>';
    }).join('');
  }

  function load() {
    if (!st.data) $('#lkList').innerHTML = '<div class="skeleton-row"></div>';
    return api('/api/admin/links?range=' + encodeURIComponent(st.range)).then(render)
      .catch(function (err) { $('#lkList').innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; });
  }

  /* ---------------------------------------------------------------- actions */

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id === 'lkForm') {
      e.preventDefault();
      var btn = $('#lkCreate');
      busy(btn, true, 'Creating…');
      api('/api/admin/links', 'POST', {
        name: $('#lkName').value, commissionGHS: $('#lkCommission').value, note: $('#lkNote').value
      }).then(function (link) {
        form.reset();
        // Copy straight away: the next thing the owner does is send it.
        return copy(fullUrl(link)).then(function () { toast('Link ready and copied.', 'success'); }, function () { toast('Link ready.', 'success'); });
      }).then(load).catch(function (err) { toast(err.message, 'error'); })
        .then(function () { busy(btn, false); });
      return;
    }
    var code = form.getAttribute && form.getAttribute('data-lk-form');
    if (code) {
      e.preventDefault();
      var save = form.querySelector('button[type="submit"]');
      busy(save, true, 'Saving…');
      api('/api/admin/links/' + encodeURIComponent(code), 'PUT', {
        name: form.name.value, commissionGHS: form.commissionGHS.value, note: form.note.value
      }).then(function () { st.editing = null; toast('Saved.', 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); busy(save, false); });
    }
  });

  document.addEventListener('click', function (e) {
    var t, l;
    if ((t = e.target.closest('[data-lk-range]'))) { st.range = t.getAttribute('data-lk-range'); st.editing = null; load(); return; }
    if ((t = e.target.closest('[data-lk-copy]'))) {
      l = find(t.getAttribute('data-lk-copy')); if (!l) return;
      copy(fullUrl(l)).then(function () { toast('Link copied.', 'success'); }, function () { toast('Could not copy. Select the link and copy it by hand.', 'error'); });
      return;
    }
    if ((t = e.target.closest('[data-lk-wa]'))) {
      l = find(t.getAttribute('data-lk-wa')); if (!l) return;
      window.open('https://wa.me/?text=' + encodeURIComponent('Abrants Data Store: ' + fullUrl(l)), '_blank', 'noopener');
      return;
    }
    if ((t = e.target.closest('[data-lk-edit]'))) { st.editing = t.getAttribute('data-lk-edit'); render(st.data); return; }
    if (e.target.closest('[data-lk-cancel]')) { st.editing = null; render(st.data); return; }
    if ((t = e.target.closest('[data-lk-delete]'))) {
      l = find(t.getAttribute('data-lk-delete')); if (!l) return;
      if (!confirm('Delete the link for ' + l.name + '? The link stops working. Its orders stay in your records.')) return;
      busy(t, true, 'Deleting…');
      api('/api/admin/links/' + encodeURIComponent(l.code), 'DELETE')
        .then(function () { st.editing = null; toast('Deleted.', 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); busy(t, false); });
      return;
    }
    if ((t = e.target.closest('[data-lk-save]'))) {
      var code = t.getAttribute('data-lk-save');
      busy(t, true, 'Saving…');
      api('/api/admin/links', 'POST', { name: code, code: code })
        .then(function () { toast('Saved as a link.', 'success'); return load(); })
        .catch(function (err) { toast(err.message, 'error'); busy(t, false); });
    }
  });

  window.AbrantsLinks = { load: load };
})();
