/* Pay bills page: ECG electricity, Ghana Water and TV (DStv, GOtv, StarTimes) */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var money = function (v) { return 'GH₵' + Number(v || 0).toFixed(2); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  var LABEL = { ecg: 'Meter number', water: 'Account number', tv: 'Smartcard number' };
  var SHORT = { ecg: 'ECG', water: 'Ghana Water', tv: 'TV' };
  var TV = { DSTV: 'DStv', GOTV: 'GOtv', STARTIMES: 'StarTimes' };
  var cat = null, kind = 'ecg', service = 'DSTV', checked = null, needHelp = false;
  // "DStv Compact" already says DStv; "Basic" needs the provider in front.
  var tvLabel = function (svc, pkg) {
    if (!pkg) return TV[svc] || '';
    return pkg.toLowerCase().indexOf(String(TV[svc] || '').toLowerCase()) >= 0 ? pkg : (TV[svc] + ' · ' + pkg);
  };
  var dayFmt = function (d) { try { return new Date(d + 'T00:00:00').toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return d; } };

  function api(url, body) {
    return fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var e = new Error(d.error || 'Something went wrong. Try again.'); e.field = d.field; throw e; }
          return d;
        });
      });
  }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(label); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function showError(err) {
    var box = $('blError');
    box.textContent = err.message; box.hidden = false;
    if (err.field) {
      var input = $('blPane').querySelector('[name="' + err.field + '"]');
      if (input) { input.closest('.field').classList.add('bad'); input.focus(); }
    }
  }
  function clearError() {
    $('blError').hidden = true;
    Array.prototype.forEach.call($('blPane').querySelectorAll('.field.bad'), function (f) { f.classList.remove('bad'); });
  }

  /* ------------------------------------------------------------ amounts */
  function conf() { return cat.bills[kind]; }
  function serviceFee(amount) { var c = conf(); return Math.round((Number(c.fee || 0) + amount * Number(c.feePercent || 0) / 100) * 100) / 100; }
  function chargeFor(price) {
    if (!cat.customerPaysFee) return price;
    return Math.ceil(Math.round((price * 100) / (1 - cat.feeRate) * 1e6) / 1e6) / 100;
  }
  function refreshPay() {
    var amount = Number($('blAmount').value);
    var ok = amount > 0;
    var fee = ok ? serviceFee(amount) : 0;
    var price = Math.round((amount + fee) * 100) / 100;
    var total = ok ? chargeFor(price) : 0;
    $('blPay').innerHTML = ok ? 'Pay ' + money(total) : 'Pay';
    var parts = [];
    if (ok) {
      parts.push(money(amount));
      if (fee > 0) parts.push(money(fee) + ' service fee');
      var pf = Math.round((total - price) * 100) / 100;
      if (pf > 0) parts.push(money(pf) + ' payment fee');
    }
    $('blFee').hidden = parts.length < 2;
    $('blFee').textContent = parts.join(' + ');
    Array.prototype.forEach.call($('blChips').children, function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.v) === amount)); });
  }
  function renderChips(due) {
    var c = conf(), list = kind === 'ecg' ? [20, 50, 100, 200] : [50, 100, 200];
    if (due > 0) list = [Math.round(due * 100) / 100].concat(list.filter(function (v) { return v !== due; }).slice(0, 2));
    list = list.filter(function (v) { return v >= c.min && v <= c.max; });
    $('blChips').innerHTML = list.map(function (v, i) {
      return '<button type="button" data-v="' + v + '">' + (due > 0 && i === 0 ? (kind === 'tv' ? 'Amount due ' : 'Amount owed ') : '') + money(v) + '</button>';
    }).join('');
  }
  $('blChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-v]'); if (!b) return;
    $('blAmount').value = b.dataset.v; refreshPay();
  });
  $('blAmount').addEventListener('input', refreshPay);

  /* ------------------------------------------------------------ tabs + check */
  function resetCheck() {
    checked = null;
    $('blWho').hidden = true; $('blDue').hidden = true; $('blRest').hidden = true;
    $('blCheck').hidden = false;
  }
  function selectKind(k) {
    kind = k;
    $('tabEcg').setAttribute('aria-selected', String(k === 'ecg'));
    $('tabWater').setAttribute('aria-selected', String(k === 'water'));
    $('tabTv').setAttribute('aria-selected', String(k === 'tv'));
    $('blProviders').hidden = k !== 'tv';
    $('blAccountLabel').textContent = LABEL[k];
    $('blAccount').placeholder = { ecg: '0210444711', water: '0500123456', tv: '7020000004' }[k];
    $('blAccount').value = '';
    $('blAmount').value = '';
    $('blAmount').min = conf().min; $('blAmount').max = conf().max;
    $('blAmount').placeholder = money(conf().min).replace('GH₵', '') + ' to ' + money(conf().max).replace('GH₵', '');
    clearError(); resetCheck(); refreshPay();
  }
  $('blProviders').addEventListener('click', function (e) {
    var b = e.target.closest('[data-service]'); if (!b) return;
    service = b.dataset.service;
    Array.prototype.forEach.call(this.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    if (checked) resetCheck();
    clearError();
  });
  $('blSwitch').addEventListener('click', function (e) {
    var b = e.target.closest('[data-kind]'); if (!b || b.hidden) return;
    selectKind(b.dataset.kind);
    history.replaceState(null, '', '#' + b.dataset.kind);
  });
  $('blAccount').addEventListener('input', function () {
    var f = this.closest('.field'); if (f) f.classList.remove('bad');
    if (checked && this.value.replace(/[\s-]/g, '').toUpperCase() !== checked.account) resetCheck();
  });
  $('blAccount').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !checked) { e.preventDefault(); doCheck(); } });
  $('blChange').addEventListener('click', function () { resetCheck(); $('blAccount').focus(); $('blAccount').select(); });

  function doCheck() {
    clearError();
    var account = $('blAccount').value.trim();
    if (account.replace(/[\s-]/g, '').length < 5) return showError({ message: 'Enter the ' + LABEL[kind].toLowerCase() + '.', field: 'account' });
    var btn = $('blCheck');
    busy(btn, true, 'Checking');
    api('/api/services/bills/lookup', { kind: kind, account: account, service: kind === 'tv' ? service : undefined }).then(function (d) {
      checked = d;
      $('blAccount').value = d.account;
      $('blName').textContent = d.name;
      $('blArea').textContent = kind === 'tv' ? tvLabel(service, d.packageName) : (d.area || '');
      $('blWho').hidden = false;
      $('blCheck').hidden = true;
      var due = Number(d.amountDue), hasDue = kind !== 'ecg' && d.amountDue != null;
      $('blDue').hidden = !hasDue;
      $('blDue').innerHTML = (kind === 'tv' ? 'Amount due: <b>' : 'Amount owed: <b>') + money(due) + '</b>' + (kind === 'tv' && d.dueDate ? ' · due ' + esc(dayFmt(d.dueDate)) : '');
      renderChips(hasDue && due > 0 ? due : 0);
      if (hasDue && due >= conf().min && due <= conf().max) $('blAmount').value = due.toFixed(2);
      $('blRest').hidden = false;
      refreshPay();
      if (!$('blAmount').value) $('blAmount').focus();
    }).catch(function (err) { showError(err); }).then(function () { busy(btn, false); });
  }
  $('blCheck').addEventListener('click', doCheck);

  $('blPane').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!checked) { doCheck(); return; }
    clearError();
    var c = conf(), amount = Number($('blAmount').value);
    var phone = $('blPhone').value.replace(/\D/g, ''), email = $('blEmail').value.trim();
    if (!(amount >= c.min && amount <= c.max)) return showError({ message: 'Enter an amount from ' + money(c.min) + ' to ' + money(c.max) + '.', field: 'amount' });
    if (!/^0\d{9}$/.test(phone)) return showError({ message: 'Enter a valid 10-digit phone number.', field: 'phone' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return showError({ message: 'Enter a valid email address.', field: 'email' });
    store.set('sv-contact', { phone: phone, email: email });
    var btn = $('blPay');
    busy(btn, true, 'Opening payment…');
    api('/api/services/checkout', { kind: kind, service: kind === 'tv' ? service : undefined, account: checked.account, amount: amount, phone: phone, email: email })
      .then(function (d) { remember(d.reference, (kind === 'tv' ? TV[service] : SHORT[kind]) + ' · ' + checked.account + ' · ' + money(amount)); location.href = d.authorizationUrl; })
      .catch(function (err) { busy(btn, false); showError(err); });
  });
  $('blPane').addEventListener('input', function (e) {
    var f = e.target.closest('.field'); if (f && e.target.id !== 'blAccount') f.classList.remove('bad');
  });

  /* ------------------------------------------------------------ recent */
  function remember(ref, label) {
    var list = (store.get('bl-recent') || []).filter(function (x) { return x.ref !== ref; });
    list.unshift({ ref: ref, label: label, at: Date.now() });
    store.set('bl-recent', list.slice(0, 6));
  }
  function renderRecent(exclude) {
    var list = (store.get('bl-recent') || []).filter(function (x) { return x.ref !== exclude; });
    var nav = $('svRecent');
    if (!list.length) { nav.hidden = true; return; }
    nav.innerHTML = '<h3>Your bill payments</h3>' + list.map(function (x) {
      return '<a href="/bills.html?reference=' + encodeURIComponent(x.ref) + '">' + esc(x.label) +
        '<small>' + new Date(x.at).toLocaleDateString('en-GH', { day: 'numeric', month: 'short' }) + '</small></a>';
    }).join('');
    nav.hidden = false;
  }

  /* ------------------------------------------------------------ result */
  var polls = 0;
  function details(o) {
    var what = { ecg: 'Meter', water: 'Account', tv: 'Smartcard' }[o.kind] || 'Account';
    return '<ul class="bl-paid">' +
      '<li><span>' + what + '</span><b>' + esc(o.account) + '</b></li>' +
      '<li><span>Name</span><b>' + esc(o.accountName) + '</b></li>' +
      (o.kind === 'tv' ? '<li><span>Service</span><b>' + esc(tvLabel(o.service, o.packageName)) + '</b></li>' : '') +
      '<li><span>Amount</span><b>' + money(o.billAmount) + '</b></li>' +
      '<li><span>You paid</span><b>' + money(o.totalGHS) + '</b></li>' +
      '</ul>';
  }
  function renderResult(o) {
    var box = $('svResult'), html = '', wait = false, slow = false;
    var refLine = '<p class="sv-ref">Reference ' + esc(o.reference) + '</p>';
    var biller = o.kind === 'ecg' ? 'ECG' : o.kind === 'water' ? 'Ghana Water' : (TV[o.service] || 'your TV provider');
    if (o.status === 'pending' || o.status === 'paid' || o.status === 'sending') {
      wait = true;
      html = '<div class="sv-waiting"><span class="spinner"></span><h2>' + (o.status === 'pending' ? 'Confirming payment…' : 'Paying your bill…') + '</h2></div>';
    } else if (o.status === 'submitted') {
      wait = true; slow = true;
      html = '<div class="sv-waiting"><span class="spinner"></span><h2>Sent to ' + biller + '. Waiting for confirmation…</h2></div>' + details(o);
    } else if (o.status === 'completed') {
      html = '<div class="bl-done"><span class="bl-tick" aria-hidden="true">✓</span><h2>' + ({ ecg: 'Electricity paid', water: 'Water bill paid', tv: (TV[o.service] || 'TV') + ' paid' }[o.kind]) + '</h2></div>' + details(o) +
        '<div class="sv-actions"><a class="pay-btn" href="/bills.html#' + esc(o.kind) + '">Pay another bill</a></div>';
    } else if (o.status === 'review') {
      html = '<h2>Taking longer than usual</h2><div class="sv-note">Your payment is safe. We are checking it with ' + biller + ' and will sort it out shortly. Please don\'t pay again.</div>' + details(o);
    } else {
      html = '<h2>' + (o.status === 'refunded' ? 'Refunded' : 'We could not pay this bill') + '</h2>' +
        '<div class="sv-note bad">' + (o.status === 'refunded' ? 'Your money has been returned.' : 'Your money is being returned to you.') +
        (o.reason ? ' (' + esc(o.reason) + ')' : '') + '</div>';
    }
    box.innerHTML = html + refLine;
    box.hidden = false;
    if (['review', 'failed', 'refunding'].indexOf(o.status) >= 0) { needHelp = true; $('svHelp').hidden = $('svHelp').getAttribute('href') === '#'; }
    if (wait && polls++ < 45) setTimeout(function () { loadOrder(o.reference); }, slow ? 8000 : (polls < 8 ? 2500 : 6000));
    else if (wait) box.innerHTML = '<h2>Still working on it</h2><div class="sv-note">Your payment is safe. Refresh this page in a few minutes.</div>' + refLine;
  }
  function loadOrder(ref) {
    api('/api/services/order/' + encodeURIComponent(ref)).then(function (o) {
      $('svLoading').hidden = true; renderResult(o); renderRecent(ref);
    }).catch(function (err) {
      $('svLoading').hidden = true;
      $('svResult').innerHTML = '<h2>Payment not found</h2><div class="sv-note bad">' + esc(err.message) + '</div>';
      $('svResult').hidden = false;
    });
  }

  /* ------------------------------------------------------------ start */
  $('year').textContent = new Date().getFullYear();
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
    var n = String(s.supportWhatsapp || '').replace(/[^\d]/g, '').replace(/^0(\d{9})$/, '233$1');
    if (n) $('svHelp').href = 'https://wa.me/' + n;
    else if (s.supportPhone) $('svHelp').href = 'tel:' + s.supportPhone;
    if (needHelp && $('svHelp').getAttribute('href') !== '#') $('svHelp').hidden = false;
  }).catch(function () {});

  var params = new URLSearchParams(location.search);
  var ref = params.get('reference') || params.get('trxref');
  if (ref) { loadOrder(ref); return; }

  var contact = store.get('sv-contact') || {};
  if (contact.phone) $('blPhone').value = contact.phone;
  if (contact.email) $('blEmail').value = contact.email;

  api('/api/services').then(function (d) {
    cat = d;
    $('svLoading').hidden = true;
    var bills = d.bills || {};
    var has = { ecg: Boolean(bills.ecg), water: Boolean(bills.water), tv: Boolean(bills.tv) };
    var kinds = ['ecg', 'water', 'tv'].filter(function (k) { return has[k]; });
    if (!kinds.length) { $('svEmpty').hidden = false; renderRecent(); return; }
    var sw = $('blSwitch');
    sw.hidden = false;
    document.querySelector('.sv-top').classList.add('with-tabs');
    $('tabEcg').hidden = !has.ecg; $('tabWater').hidden = !has.water; $('tabTv').hidden = !has.tv;
    sw.classList.toggle('single', kinds.length === 1);
    $('blPane').hidden = false;
    var want = location.hash.slice(1);
    selectKind(kinds.indexOf(want) >= 0 ? want : kinds[0]);
    renderRecent();
  }).catch(function (err) {
    $('svLoading').hidden = true; $('svEmpty').hidden = false;
    var t = document.createElement('div'); t.className = 'toast error'; t.textContent = err.message; $('toastStack').appendChild(t);
  });
})();
