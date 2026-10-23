/* Result checkers & AFA page */
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
  var cat = null, qty = 1, needHelp = false;

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }
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
  function showError(id, err, form) {
    var box = $(id);
    box.textContent = err.message; box.hidden = false;
    if (form && err.field) {
      var input = form.querySelector('[name="' + err.field + '"]');
      if (input) { input.closest('.field').classList.add('bad'); input.focus(); }
    }
  }
  function clearError(id, form) {
    $(id).hidden = true;
    if (form) Array.prototype.forEach.call(form.querySelectorAll('.field.bad'), function (f) { f.classList.remove('bad'); });
  }

  /* ------------------------------------------------------------ tabs */
  function selectTab(name) {
    var afa = name === 'afa' && cat.afa;
    $('tabChk').setAttribute('aria-selected', String(!afa));
    $('tabAfa').setAttribute('aria-selected', String(Boolean(afa)));
    $('paneChk').hidden = Boolean(afa);
    $('paneAfa').hidden = !afa;
  }
  $('svSwitch').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tab]');
    if (!b) return;
    selectTab(b.dataset.tab);
    history.replaceState(null, '', b.dataset.tab === 'afa' ? '#afa' : '#checkers');
  });

  /* ------------------------------------------------------------ checkers */
  function chosen() {
    var r = document.querySelector('input[name="checker"]:checked');
    return r ? cat.checkers.filter(function (c) { return c.code === r.value; })[0] : null;
  }
  function chargeFor(price) {
    if (!cat.customerPaysFee) return price;
    return Math.ceil(Math.round((price * 100) / (1 - cat.feeRate) * 1e6) / 1e6) / 100;
  }
  function payLabel(btn, feeEl, price) {
    var total = chargeFor(price);
    btn.innerHTML = 'Pay ' + money(total);
    var fee = Math.round((total - price) * 100) / 100;
    feeEl.hidden = !(fee > 0);
    feeEl.textContent = money(price) + ' + ' + money(fee) + ' payment fee';
  }
  function refreshChecker() {
    var c = chosen();
    var max = Math.min(5, c && c.stock != null ? c.stock : 5);
    if (qty > max) qty = Math.max(1, max);
    $('qtyOut').textContent = qty;
    $('qtyMinus').disabled = qty <= 1;
    $('qtyPlus').disabled = qty >= max;
    payLabel($('chkPay'), $('chkFee'), c ? c.price * qty : 0);
  }
  function renderCheckers() {
    var list = $('chkList');
    var html = '<legend class="sr-only">Choose a checker</legend>';
    cat.checkers.forEach(function (c, i) {
      html += '<label class="ticket"><input type="radio" name="checker" value="' + esc(c.code) + '"' + (i === 0 ? ' checked' : '') + ' />' +
        '<span class="ticket-body"><span class="ticket-name">' + esc(c.name) +
        (c.stock != null && c.stock <= 10 ? '<span class="ticket-left">' + c.stock + ' left</span>' : '') +
        '</span><span class="ticket-price">' + money(c.price) + '</span></span></label>';
    });
    list.innerHTML = html;
    list.addEventListener('change', refreshChecker);
    refreshChecker();
  }
  $('qtyMinus').addEventListener('click', function () { qty = Math.max(1, qty - 1); refreshChecker(); });
  $('qtyPlus').addEventListener('click', function () { qty += 1; refreshChecker(); });

  $('paneChk').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this, btn = $('chkPay'), c = chosen();
    clearError('chkError', form);
    if (!c) return;
    var phone = $('chkPhone').value.replace(/\D/g, ''), email = $('chkEmail').value.trim();
    if (!/^0\d{9}$/.test(phone)) return showError('chkError', { message: 'Enter a valid 10-digit phone number.', field: 'phone' }, form);
    if (!/^\S+@\S+\.\S+$/.test(email)) return showError('chkError', { message: 'Enter a valid email address.', field: 'email' }, form);
    store.set('sv-contact', { phone: phone, email: email });
    busy(btn, true, 'Opening payment…');
    api('/api/services/checkout', { kind: 'checker', code: c.code, quantity: qty, phone: phone, email: email })
      .then(function (d) { remember(d.reference, c.name + (qty > 1 ? ' × ' + qty : '')); location.href = d.authorizationUrl; })
      .catch(function (err) { busy(btn, false); showError('chkError', err, form); });
  });

  /* ------------------------------------------------------------ AFA */
  function fixCard(input) {
    var raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^\d/.test(raw)) raw = 'GHA' + raw;
    var digits = raw.slice(3).replace(/\D/g, '').slice(0, 10);
    var out = 'GHA';
    if (digits.length) out += '-' + digits.slice(0, 9);
    if (digits.length > 9) out += '-' + digits.slice(9);
    input.value = raw ? out : '';
  }
  $('paneAfa').ghanaCard.addEventListener('blur', function () { fixCard(this); });

  $('paneAfa').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = this, btn = $('afaPay');
    clearError('afaError', form);
    fixCard(form.ghanaCard);
    var body = { kind: 'afa' };
    ['fullName', 'ghanaCard', 'dob', 'phone', 'region', 'location', 'occupation', 'email'].forEach(function (k) { body[k] = form[k].value.trim(); });
    var missing = ['fullName', 'ghanaCard', 'dob', 'phone', 'region', 'location', 'email'].filter(function (k) { return !body[k]; })[0];
    if (missing) return showError('afaError', { message: 'Fill in every field.', field: missing }, form);
    store.set('sv-contact', { phone: body.phone, email: body.email });
    busy(btn, true, 'Opening payment…');
    api('/api/services/checkout', body)
      .then(function (d) { remember(d.reference, 'AFA · ' + body.fullName); location.href = d.authorizationUrl; })
      .catch(function (err) { busy(btn, false); showError('afaError', err, form); });
  });
  $('paneAfa').addEventListener('input', function (e) {
    var f = e.target.closest('.field'); if (f) f.classList.remove('bad');
  });

  /* ------------------------------------------------------------ recent */
  function remember(ref, label) {
    var list = (store.get('sv-recent') || []).filter(function (x) { return x.ref !== ref; });
    list.unshift({ ref: ref, label: label, at: Date.now() });
    store.set('sv-recent', list.slice(0, 6));
  }
  function renderRecent(exclude) {
    var list = (store.get('sv-recent') || []).filter(function (x) { return x.ref !== exclude; });
    var nav = $('svRecent');
    if (!list.length) { nav.hidden = true; return; }
    nav.innerHTML = '<h3>Your purchases</h3>' + list.map(function (x) {
      return '<a href="/services.html?reference=' + encodeURIComponent(x.ref) + '">' + esc(x.label) +
        '<small>' + new Date(x.at).toLocaleDateString('en-GH', { day: 'numeric', month: 'short' }) + '</small></a>';
    }).join('');
    nav.hidden = false;
  }

  /* ------------------------------------------------------------ result */
  var polls = 0;
  function pinCard(p) {
    return '<article class="pin-card"><dl class="pin-rows">' +
      '<div class="pin-row"><dt>Serial</dt><dd>' + esc(p.serial) + '</dd><button type="button" class="copy-btn" data-copy="' + esc(p.serial) + '">Copy</button></div>' +
      '<div class="pin-row pin"><dt>PIN</dt><dd>' + esc(p.pin) + '</dd><button type="button" class="copy-btn" data-copy="' + esc(p.pin) + '">Copy</button></div>' +
      '</dl></article>';
  }
  function steps(o) {
    var s = o.status;
    var done = { paid: true, submitted: ['submitted', 'approved', 'rejected'].indexOf(s) >= 0, approved: s === 'approved' };
    var item = function (ok, now, title, sub) {
      return '<li class="' + (ok ? 'done' : now ? 'now' : '') + '"><span class="dot">' + (ok ? '✓' : '') + '</span><div><b>' + title + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div></li>';
    };
    return '<ol class="afa-steps">' +
      item(done.paid, false, 'Paid', money(o.totalGHS)) +
      item(done.submitted, !done.submitted, 'Submitted') +
      item(done.approved, s === 'submitted', 'Approved', s === 'submitted' ? 'Usually within 1–3 working days' : '') +
      '</ol>';
  }
  function renderResult(o) {
    var box = $('svResult'), html = '', wait = false;
    var refLine = '<p class="sv-ref">Reference ' + esc(o.reference) + '</p>';
    if (o.status === 'pending' || o.status === 'paid' || o.status === 'sending') {
      wait = true;
      html = '<div class="sv-waiting"><span class="spinner"></span><h2>' +
        (o.status === 'pending' ? 'Confirming payment…' : o.kind === 'afa' ? 'Submitting your registration…' : 'Getting your PINs…') + '</h2></div>';
    } else if (o.status === 'completed') {
      html = '<h2>' + esc(o.name) + (o.pins.length > 1 ? ' × ' + o.pins.length : '') + '</h2>' +
        '<div class="pins">' + o.pins.map(pinCard).join('') + '</div><div class="sv-actions">' +
        (o.resultUrl ? '<a class="pay-btn" href="' + esc(o.resultUrl) + '" target="_blank" rel="noopener">Check results</a>' : '') +
        '<button type="button" class="ghost-btn" id="copyAll">Copy all</button></div>';
    } else if (o.kind === 'afa' && (o.status === 'submitted' || o.status === 'approved')) {
      html = '<h2>' + (o.status === 'approved' ? 'AFA approved' : 'Registration submitted') + '</h2>' +
        (o.afaName ? '<p class="sv-sub">' + esc(o.afaName) + '</p>' : '') +
        (o.afaId ? '<div class="afa-id"><div><span>AFA ID</span><strong>' + esc(o.afaId) + '</strong></div><button type="button" class="copy-btn" style="color:#064e3b;border-color:#9fe0c0" data-copy="' + esc(o.afaId) + '">Copy</button></div>' : '') +
        steps(o);
    } else if (o.status === 'rejected') {
      html = '<h2>AFA not approved</h2>' + (o.afaName ? '<p class="sv-sub">' + esc(o.afaName) + '</p>' : '') +
        '<div class="sv-note bad">' + esc(o.reason || 'The registration was not approved.') + '</div>';
    } else if (o.status === 'review') {
      html = '<h2>Taking longer than usual</h2><div class="sv-note">Your payment is safe. We are on it and will complete this shortly.</div>';
    } else {
      html = '<h2>' + (o.status === 'refunded' ? 'Refunded' : 'We could not complete this') + '</h2>' +
        '<div class="sv-note bad">' + (o.status === 'refunded' ? 'Your money has been returned.' : 'Your money is being returned to you.') +
        (o.reason ? ' (' + esc(o.reason) + ')' : '') + '</div>';
    }
    box.innerHTML = html + refLine;
    box.hidden = false;
    if (o.status === 'submitted' || o.status === 'review' || o.status === 'rejected' || ['failed', 'refunding'].indexOf(o.status) >= 0) { needHelp = true; $('svHelp').hidden = $('svHelp').getAttribute('href') === '#'; }
    var copyAll = $('copyAll');
    if (copyAll) copyAll.addEventListener('click', function () {
      copy(o.pins.map(function (p) { return o.name + ' Serial: ' + p.serial + '  PIN: ' + p.pin; }).join('\n'), copyAll);
    });
    if (wait && polls++ < 40) setTimeout(function () { loadOrder(o.reference); }, polls < 8 ? 2500 : 6000);
    else if (wait) box.innerHTML = '<h2>Still working on it</h2><div class="sv-note">Your payment is safe. Refresh this page in a minute.</div>' + refLine;
  }
  function loadOrder(ref) {
    api('/api/services/order/' + encodeURIComponent(ref)).then(function (o) {
      $('svLoading').hidden = true;
      renderResult(o);
      renderRecent(ref);
    }).catch(function (err) {
      $('svLoading').hidden = true;
      $('svResult').innerHTML = '<h2>Order not found</h2><div class="sv-note bad">' + esc(err.message) + '</div>';
      $('svResult').hidden = false;
    });
  }

  function copy(text, btn) {
    var ok = function () { var t = btn.textContent; btn.textContent = 'Copied'; btn.classList.add('done'); setTimeout(function () { btn.textContent = t; btn.classList.remove('done'); }, 1600); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text); ok(); });
    else { fallbackCopy(text); ok(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } ta.remove();
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (b) copy(b.getAttribute('data-copy'), b);
  });

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
  if (contact.phone) { $('chkPhone').value = contact.phone; $('paneAfa').phone.value = contact.phone; }
  if (contact.email) { $('chkEmail').value = contact.email; $('paneAfa').email.value = contact.email; }

  api('/api/services').then(function (d) {
    cat = d;
    $('svLoading').hidden = true;
    var hasChk = d.checkers.length > 0, hasAfa = Boolean(d.afa);
    if (!hasChk && !hasAfa) { $('svEmpty').hidden = false; renderRecent(); return; }
    var sw = $('svSwitch');
    sw.hidden = false;
    document.querySelector('.sv-top').classList.add('with-tabs');
    $('tabChk').hidden = !hasChk; $('tabAfa').hidden = !hasAfa;
    sw.classList.toggle('single', !(hasChk && hasAfa));
    if (hasChk) renderCheckers();
    if (hasAfa) {
      $('afaRegion').innerHTML = '<option value="">Choose</option>' + d.regions.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('');
      payLabel($('afaPay'), $('afaFee'), d.afa.price);
      var max = new Date(); max.setFullYear(max.getFullYear() - 15);
      $('paneAfa').dob.max = max.toISOString().slice(0, 10);
    }
    selectTab(hasAfa && (!hasChk || location.hash === '#afa') ? 'afa' : 'checkers');
    renderRecent();
  }).catch(function (err) {
    $('svLoading').hidden = true;
    $('svEmpty').hidden = false;
    toast(err.message, 'error');
  });
})();
