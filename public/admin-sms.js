/* Abrants Admin — text messages (Settings → Text messages). */
(function () {
  'use strict';
  var $ = function (sel) { return document.querySelector(sel); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
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
        return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok) throw new Error(d.error || 'Request failed.'); return d; });
      });
  }
  function when(v) { try { return new Date(v).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }

  function render(d) {
    var state;
    if (!d.configured) {
      state = '<div class="alert-strip warn"><span class="ico">!</span><div>Not set up. Add <b>MNOTIFY_API_KEY</b> in Render' +
        (d.sender !== 'ABRANTS' ? '' : ' (and <b>SMS_SENDER</b> if your approved sender name is not ABRANTS)') + '.</div></div>';
    } else {
      var bal = d.balance ? (d.balance.sms != null ? d.balance.sms + ' SMS left' : '') + (d.balance.main != null ? (d.balance.sms != null ? ' · ' : '') + 'GHS ' + Number(d.balance.main).toFixed(2) : '') : 'Balance not available';
      state = (d.low ? '<div class="alert-strip warn"><span class="ico">!</span><div><b>Text credit is running low.</b> Top up in ' + esc(d.provider) +
        ': without credit, customers get no texts and nobody can sign up as an agent.</div></div>' : '') +
        '<div class="alert-strip info"><span class="ico">✓</span><div>Sending as <b>' + esc(d.sender) + '</b>' +
        (d.codeSender && d.codeSender !== d.sender ? ' (codes as <b>' + esc(d.codeSender) + '</b>)' : '') + ' through ' + esc(d.provider) + ' · ' + esc(bal) +
        ' · ' + d.counts.sent + ' sent' + (d.counts.failed ? ', ' + d.counts.failed + ' failed' : '') + ' since ' + esc(when(d.counts.since)) + '</div></div>';
    }
    $('#smsState').innerHTML = state;
    $('#smsCustomers').checked = !!d.customers;
    $('#smsAgents').checked = !!d.agents;
    $('#smsTestBtn').disabled = !d.configured;
    $('#smsRecent').innerHTML = (d.recent || []).length ? '<div class="sms-log">' + d.recent.map(function (m) {
      return '<div class="event"><small>' + esc(when(m.at)) + ' · ' + esc(m.to) + ' · ' + esc(m.kind) + (m.ok ? (m.parts > 1 ? ' · ' + m.parts + ' SMS' : '') : ' · <span class="neg">' + esc(m.error) + '</span>') + '</small><strong>' + esc(m.text) + '</strong></div>';
    }).join('') + '</div>' : '';
  }

  function load() { return api('/api/admin/sms').then(render).catch(function (err) { $('#smsState').innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; }); }

  function save() {
    api('/api/admin/sms', 'PUT', { customers: $('#smsCustomers').checked, agents: $('#smsAgents').checked })
      .then(function () { toast('Saved.', 'success'); }).catch(function (err) { toast(err.message, 'error'); load(); });
  }
  $('#smsCustomers').addEventListener('change', save);
  $('#smsAgents').addEventListener('change', save);
  $('#smsTestBtn').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    api('/api/admin/sms/test', 'POST', { phone: $('#smsTestPhone').value }).then(function () { toast('Test SMS sent.', 'success'); return load(); })
      .catch(function (err) { toast(err.message, 'error'); }).then(function () { btn.disabled = false; });
  });

  window.AbrantsSms = { load: load };
})();
