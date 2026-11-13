/* Abrants Data Store — agent page: join, log in, prices, sales, payouts, settings. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var money = function (v) { var n = Number(v || 0); return (n < 0 ? '−GH₵' : 'GH₵') + Math.abs(n).toFixed(2); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var NET = { MTN: 'MTN MoMo', Telecel: 'Telecel Cash', AirtelTigo: 'AirtelTigo Money' };
  var st = { data: null, salesOffset: 0, tab: 'prices' };

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }
  function api(url, method, body) {
    return fetch(url, { method: method || 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var e = new Error(d.error || 'Something went wrong. Please try again.'); e.status = r.status; e.field = d.field; e.key = d.key; throw e; }
          return d;
        });
      });
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(label); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function formError(form, err) {
    var box = form.querySelector('.ck-error') || $(form.id.replace('Form', 'Error'));
    if (box) { box.textContent = err ? err.message : ''; box.hidden = !err; }
    if (err && err.field && form.elements[err.field] && form.elements[err.field].focus) form.elements[err.field].focus();
  }
  function date(v) {
    try { return new Date(v).toLocaleString('en-GH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function slugPreview(name) {
    var s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
    return s.length >= 3 ? location.host + '/s/' + s : '';
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); } finally { ta.remove(); }
    });
  }

  /* ------------------------------------------------------------ views */
  function show(view) {
    ['loadingView', 'authView', 'dashView'].forEach(function (v) { $(v).hidden = v !== view; });
  }

  function setAuthTab(which) {
    $('tabJoin').classList.toggle('active', which === 'join'); $('tabJoin').setAttribute('aria-selected', which === 'join');
    $('tabLogin').classList.toggle('active', which === 'login'); $('tabLogin').setAttribute('aria-selected', which === 'login');
    $('joinForm').hidden = which !== 'join' || st.closed;
    $('joinClosed').hidden = which !== 'join' || !st.closed;
    $('loginForm').hidden = which !== 'login';
  }

  function render(d) {
    st.data = d;
    var a = d.agent, b = d.balances, p = d.programme;
    $('avatar').textContent = (a.shopName || 'A').trim().charAt(0).toUpperCase();
    $('shopName').textContent = a.shopName;
    var label = { active: 'Active', pending: 'Waiting for approval', suspended: 'Paused' }[a.status] || a.status;
    $('agStatus').textContent = p.open ? label : 'Programme paused';
    $('agStatus').className = 'ag-status ' + (p.open ? a.status : 'suspended');
    $('pwForce').hidden = !a.mustChangePassword;

    var notice = '';
    if (!p.open) notice = 'The agent programme is paused. Your shop link shows the normal store until it reopens. Your earnings are safe.';
    else if (a.status === 'pending') notice = 'Your shop opens as soon as the store approves you. You can set your prices now.';
    else if (a.status === 'suspended') notice = 'Your shop is paused by the store. Contact the store to reopen it.';
    $('agNotice').textContent = notice; $('agNotice').hidden = !notice;
    $('termsNotice').hidden = a.termsVersion === p.termsVersion;

    var live = p.open && a.status === 'active';
    $('linkCard').hidden = false;
    $('shopUrl').textContent = d.shopUrl;
    $('openShop').href = d.shopUrl;
    $('shareWa').href = 'https://wa.me/?text=' + encodeURIComponent('Buy data, result checkers and AFA from ' + a.shopName + ': ' + d.shopUrl);
    $('linkCard').classList.toggle('muted-card', !live);
    ['copyLink', 'shareWa', 'openShop'].forEach(function (id) { $(id).hidden = !live; });

    $('mReady').textContent = money(b.readyGHS);
    $('mHeld').textContent = money(b.heldGHS);
    $('mWay').textContent = money(b.onTheWayGHS);
    $('mPaid').textContent = money(b.paidGHS + (b.sendingGHS || 0));
    var info = 'To ' + (NET[a.momoNetwork] || a.momoNetwork) + ' ' + a.momoNumber + ' · min. ' + money(p.minPayoutGHS) +
      (p.payoutFeeGHS > 0 ? ' · ' + money(p.payoutFeeGHS) + ' fee' : '') + (p.payoutDay != null ? ' · every ' + DAYS[p.payoutDay] : '');
    $('mPayInfo').textContent = info;

    renderPrices(d.products, p.marginFactor);
    renderSales(d.sales, false);
    renderPayouts(d.payouts);
    var f = $('profileForm'); f.shopName.value = a.shopName; f.whatsapp.value = a.whatsapp || '';
    var m = $('momoForm'); m.momoNumber.value = a.momoNumber; m.momoNetwork.value = a.momoNetwork; m.momoName.value = a.momoName; m.password.value = '';
  }

  function earnFor(row, factor) {
    var input = row.querySelector('input');
    var agentPrice = Number(row.dataset.agent), store = Number(row.dataset.store);
    var val = input.value.trim() === '' ? store : Number(input.value);
    var earnEl = row.querySelector('.ag-row-earn');
    if (!isFinite(val) || val <= 0) { earnEl.textContent = '—'; return; }
    var low = val < agentPrice;
    row.classList.toggle('warn', low);
    if (low) { earnEl.textContent = 'Below your cost'; earnEl.classList.add('zero'); return; }
    var e = Math.floor((val - agentPrice) * factor * 100 + 1e-6) / 100;
    earnEl.textContent = 'You earn ' + money(e);
    earnEl.classList.toggle('zero', e <= 0);
  }

  function renderPrices(products, factor) {
    var groups = [];
    var byGroup = {};
    products.forEach(function (p) { if (!byGroup[p.group]) { byGroup[p.group] = []; groups.push(p.group); } byGroup[p.group].push(p); });
    $('priceList').innerHTML = groups.map(function (g) {
      return '<div class="ag-group"><h2>' + esc(g) + '</h2>' + byGroup[g].map(function (p) {
        return '<div class="ag-row" data-key="' + esc(p.key) + '" data-agent="' + p.agentPrice + '" data-store="' + p.storePrice + '">' +
          '<div class="ag-row-name">' + esc(p.kind === 'data' ? p.label : p.name) + '</div>' +
          '<div class="ag-row-meta">Your cost <b>' + money(p.agentPrice) + '</b> · Store ' + money(p.storePrice) + '</div>' +
          '<div class="ag-row-earn"></div>' +
          '<label><span>Your price</span><input inputmode="decimal" autocomplete="off" placeholder="' + p.storePrice.toFixed(2) + '" value="' + (p.myPrice == null ? '' : p.myPrice.toFixed(2)) + '" aria-label="Your price for ' + esc(p.name) + '" /></label>' +
          '</div>';
      }).join('') + '</div>';
    }).join('') || '<div class="empty-card"><strong>Nothing to sell yet</strong></div>';
    Array.prototype.forEach.call(document.querySelectorAll('.ag-row'), function (row) {
      earnFor(row, factor);
      row.querySelector('input').addEventListener('input', function () { earnFor(row, factor); });
    });
  }

  var STATE = { delivered: 'Delivered', on_the_way: 'On the way', failed: 'Failed', refunded: 'Refunded' };
  function renderSales(list, append) {
    var html = list.map(function (s) {
      var counts = s.state === 'delivered' || s.state === 'on_the_way';
      return '<div class="order-card">' +
        '<div class="o-title">' + esc(s.what) + '</div>' +
        '<div class="o-price">' + money(s.priceGHS) + '</div>' +
        '<div class="o-sub">' + esc(s.phone) + ' · ' + esc(date(s.createdAt)) + '</div>' +
        '<div class="o-earn' + (counts ? '' : ' none') + '">+' + money(s.earningGHS) + '</div>' +
        '<span class="chip ' + esc(s.state) + '" style="justify-self:start">' + esc(STATE[s.state] || s.state) + '</span>' +
        '</div>';
    }).join('');
    if (append) $('salesList').insertAdjacentHTML('beforeend', html);
    else $('salesList').innerHTML = html || '<div class="empty-card"><strong>No sales yet</strong>Share your shop link to get your first customer.</div>';
    st.salesOffset = (append ? st.salesOffset : 0) + list.length;
    $('moreSales').hidden = list.length < 30;
  }

  var PSTATE = { paid: 'Paid', sending: 'Sending', otp: 'Sending', failed: 'Failed' };
  function renderPayouts(list) {
    $('payoutList').innerHTML = list.map(function (p) {
      return '<div class="order-card">' +
        '<div class="o-title">' + money(p.sentGHS) + '</div>' +
        '<span class="chip ' + esc(p.status) + '">' + esc(PSTATE[p.status] || p.status) + '</span>' +
        '<div class="o-sub">' + esc(date(p.paidAt || p.createdAt)) + ' · ' + esc(p.momoNumber) + (p.feeGHS > 0 ? ' · fee ' + money(p.feeGHS) : '') + '</div>' +
        '</div>';
    }).join('') || '<div class="empty-card"><strong>No payouts yet</strong></div>';
  }

  function setTab(name) {
    st.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.ag-tabs .seg-btn'), function (b) {
      var on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
    });
    ['prices', 'sales', 'payouts', 'settings'].forEach(function (t) { $('pane-' + t).hidden = t !== name; });
  }

  /* ------------------------------------------------------------ load */
  function load() {
    return api('/api/agent/me').then(function (d) { render(d); show('dashView'); })
      .catch(function (err) {
        if (err.status !== 401) { toast(err.message, 'error'); }
        return api('/api/agent/programme').then(function (p) {
          st.closed = !p.open;
          setAuthTab(st.closed || location.hash === '#login' ? 'login' : 'join');
          show('authView');
        }).catch(function () { setAuthTab('login'); show('authView'); });
      });
  }

  /* ------------------------------------------------------------ events */
  $('tabJoin').addEventListener('click', function () { setAuthTab('join'); });
  $('tabLogin').addEventListener('click', function () { setAuthTab('login'); });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-pw]');
    if (t) { var inp = t.parentNode.querySelector('input'); var vis = inp.type === 'password'; inp.type = vis ? 'text' : 'password'; t.textContent = vis ? 'Hide' : 'Show'; return; }
    var tab = e.target.closest('.ag-tabs .seg-btn');
    if (tab) setTab(tab.dataset.tab);
  });
  $('joinForm').shopName.addEventListener('input', function () { $('linkPreview').textContent = slugPreview(this.value); });
  $('joinForm').phone.addEventListener('input', function () { $('joinForm').momoNumber.placeholder = this.value || 'Same as phone'; });

  /* Sign-up: the details, then (when SMS is set up) a 6-digit code sent to the phone. */
  function joinBody(f) {
    return { name: f.name.value, shopName: f.shopName.value, phone: f.phone.value, password: f.password.value,
      momoNumber: f.momoNumber.value || f.phone.value, momoNetwork: f.momoNetwork.value, momoName: f.momoName.value, agree: f.agree.checked };
  }
  function codeMode(on, sentTo) {
    var f = $('joinForm');
    f.classList.toggle('coding', on);
    $('codeStep').hidden = !on;
    if (on) {
      $('codeLabel').textContent = 'Enter the code we sent to ' + sentTo;
      f.code.value = '';
      f.code.focus();
    } else { st.codeToken = null; }
  }
  function createShop(f, body) {
    busy($('joinBtn'), true, 'Creating your shop…');
    return api('/api/agent/register', 'POST', body).then(function () { return load(); });
  }
  function joinFailed(f, err) {
    // A problem with a detail typed earlier: show the details again so it can be fixed.
    if (err.field && err.field !== 'code' && f.classList.contains('coding')) codeMode(false);
    if (err.field === 'agree') { openTerms(); return; }
    formError(f, err);
  }
  $('joinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target; formError(f, null);
    var body = joinBody(f);
    if (st.codeToken) {
      if (!/^\d{6}$/.test(f.code.value.trim())) { formError(f, { message: 'Enter the 6-digit code from the SMS.', field: 'code' }); return; }
      body.code = f.code.value.trim(); body.codeToken = st.codeToken;
      createShop(f, body).catch(function (err) { joinFailed(f, err); }).then(function () { busy($('joinBtn'), false); });
      return;
    }
    if (!body.agree) { openTerms(); return; }
    busy($('joinBtn'), true, 'Checking your details…');
    api('/api/agent/register/code', 'POST', body).then(function (d) {
      if (!d.codeNeeded) return createShop(f, body);
      st.codeToken = d.codeToken;
      codeMode(true, d.sentTo);
    }).catch(function (err) { joinFailed(f, err); }).then(function () { busy($('joinBtn'), false); });
  });
  $('joinForm').code.addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6);
    if (this.value.length === 6 && !$('joinBtn').disabled) $('joinForm').requestSubmit ? $('joinForm').requestSubmit($('joinBtn')) : $('joinBtn').click();
  });
  $('resendCode').addEventListener('click', function () {
    var f = $('joinForm'), btn = this; formError(f, null);
    btn.disabled = true;
    api('/api/agent/register/code', 'POST', joinBody(f)).then(function (d) {
      if (!d.codeNeeded) { codeMode(false); return; }
      st.codeToken = d.codeToken;
      codeMode(true, d.sentTo);
      toast('New code sent.', 'success');
    }).catch(function (err) { joinFailed(f, err); }).then(function () { btn.disabled = false; });
  });
  $('editDetails').addEventListener('click', function () { formError($('joinForm'), null); codeMode(false); $('joinForm').name.focus(); });

  /* Agent terms: a pop-up that has to be read to the end before "I agree" works. */
  var terms = { loaded: false, read: false, update: false, back: null };
  function termsAtEnd() {
    var b = $('termsBody');
    return b.scrollHeight - b.scrollTop - b.clientHeight < 24;
  }
  function termsCheck() {
    if (!terms.loaded || !termsAtEnd()) return;
    terms.read = true;
    $('termsAgree').disabled = false;
    $('termsAgree').textContent = 'I agree';
  }
  function loadTerms() {
    if (terms.loaded) return;
    $('termsBody').innerHTML = '<div class="skeleton" style="min-height:240px"></div>';
    fetch('/agent-terms.html', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(); return r.text(); }).then(function (html) {
      var art = new DOMParser().parseFromString(html, 'text/html').getElementById('terms');
      if (!art) throw new Error();
      $('termsBody').innerHTML = '';
      $('termsBody').appendChild(document.importNode(art, true));
      terms.loaded = true;
      $('termsBody').scrollTop = 0;
      termsCheck();
    }).catch(function () {
      $('termsBody').innerHTML = '<p class="ck-error">Could not load the terms. <button type="button" class="ag-linkbtn" id="termsRetry">Try again</button></p>';
      $('termsRetry').addEventListener('click', loadTerms);
    });
  }
  function openTerms() {
    terms.back = document.activeElement;
    $('termsModal').hidden = false;
    document.body.style.overflow = 'hidden';
    if (!terms.read) { $('termsAgree').disabled = true; $('termsAgree').textContent = 'Scroll to the end'; $('termsBody').scrollTop = 0; }
    loadTerms();
    $('termsBody').focus();
    termsCheck();
  }
  function closeTerms() {
    terms.update = false;
    $('termsModal').hidden = true;
    document.body.style.overflow = '';
    if (terms.back && terms.back.focus) terms.back.focus();
  }
  $('termsBody').addEventListener('scroll', termsCheck, { passive: true });
  window.addEventListener('resize', function () { if (!$('termsModal').hidden) termsCheck(); });
  $('openTerms').addEventListener('click', function (e) { e.preventDefault(); openTerms(); });
  $('agreeBox').addEventListener('click', function (e) {
    if (this.checked && !terms.read) { e.preventDefault(); openTerms(); }
  });
  $('termsAgree').addEventListener('click', function () {
    if (!terms.read) return;
    if (terms.update) {
      var btn = this; btn.disabled = true;
      api('/api/agent/terms', 'POST').then(function () { terms.update = false; $('termsNotice').hidden = true; closeTerms(); toast('Thank you.', 'success'); })
        .catch(function (err) { toast(err.message, 'error'); }).then(function () { btn.disabled = false; });
      return;
    }
    $('agreeBox').checked = true;
    terms.back = $('joinBtn');
    closeTerms();
  });
  $('termsClose').addEventListener('click', closeTerms);
  // Terms changed since this agent signed up: read them, then "I agree" records it.
  $('readNewTerms').addEventListener('click', function () { terms.read = false; terms.update = true; openTerms(); });
  $('termsModal').addEventListener('click', function (e) { if (e.target === this) closeTerms(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('termsModal').hidden) closeTerms(); });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target; formError(f, null);
    busy($('loginBtn'), true, 'Logging in…');
    api('/api/agent/login', 'POST', { phone: f.phone.value, password: f.password.value }).then(function () { f.password.value = ''; return load(); })
      .catch(function (err) { formError(f, err); }).then(function () { busy($('loginBtn'), false); });
  });

  $('logoutBtn').addEventListener('click', function () {
    api('/api/agent/logout', 'POST').then(function () { location.hash = '#login'; location.reload(); });
  });

  $('copyLink').addEventListener('click', function () {
    copy(st.data.shopUrl).then(function () { toast('Link copied.', 'success'); }, function () { toast('Could not copy. Press and hold the link to copy it.', 'error'); });
  });

  $('pricesForm').addEventListener('submit', function (e) {
    e.preventDefault();
    formError(e.target, null);
    var prices = {}; var big = [];
    Array.prototype.forEach.call(document.querySelectorAll('.ag-row'), function (row) {
      var v = row.querySelector('input').value.trim();
      prices[row.dataset.key] = v;
      if (v && Number(v) > Number(row.dataset.store) * 3) big.push(row.querySelector('.ag-row-name').textContent + ' at ' + money(v));
    });
    if (big.length && !confirm('Check these prices before saving:\n' + big.join('\n'))) return;
    busy($('savePrices'), true, 'Saving…');
    api('/api/agent/prices', 'PUT', { prices: prices }).then(function (d) {
      st.data.products = d.products;
      renderPrices(d.products, st.data.programme.marginFactor);
      toast('Prices saved. Your shop shows them now.', 'success');
    }).catch(function (err) {
      formError(e.target, err);
      var row = err.key && document.querySelector('.ag-row[data-key="' + err.key + '"] input');
      if (row) { row.focus(); row.scrollIntoView({ block: 'center' }); }
    }).then(function () { busy($('savePrices'), false); });
  });

  $('moreSales').addEventListener('click', function () {
    var btn = this; busy(btn, true, 'Loading…');
    api('/api/agent/sales?offset=' + st.salesOffset).then(function (list) { renderSales(list, true); })
      .catch(function (err) { toast(err.message, 'error'); }).then(function () { busy(btn, false); });
  });

  function settingsForm(id, url, body, done) {
    $(id).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, btn = f.querySelector('button[type="submit"]');
      formError(f, null); busy(btn, true, 'Saving…');
      api(url, 'PUT', body(f)).then(function (d) { done(f, d); }).catch(function (err) { formError(f, err); }).then(function () { busy(btn, false); });
    });
  }
  settingsForm('profileForm', '/api/agent/profile', function (f) { return { shopName: f.shopName.value, whatsapp: f.whatsapp.value }; },
    function () { toast('Saved.', 'success'); load(); });
  settingsForm('momoForm', '/api/agent/momo', function (f) { return { momoNumber: f.momoNumber.value, momoNetwork: f.momoNetwork.value, momoName: f.momoName.value, password: f.password.value }; },
    function () { toast('MoMo details saved.', 'success'); load(); });
  settingsForm('passwordForm', '/api/agent/password', function (f) { return { current: f.current.value, next: f.next.value }; },
    function (f) { f.reset(); toast('Password changed.', 'success'); });
  settingsForm('forceForm', '/api/agent/password', function (f) { return { current: f.current.value, next: f.next.value }; },
    function (f) { f.reset(); toast('Password saved.', 'success'); load(); });

  $('year').textContent = new Date().getFullYear();
  load();
})();
