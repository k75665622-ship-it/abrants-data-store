/* Abrants Data Store — customer account page */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var OVERVIEW = null;
  var REDEEMING = null;
  var lastFocused = null;

  /* ------------------------------------------------------------ helpers */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) { return 'GH₵' + Number(v || 0).toFixed(2); }
  function when(v) {
    try { return new Date(v).toLocaleString('en-GH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function day(v) {
    try { return new Date(v).toLocaleDateString('en-GH', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return ''; }
  }
  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div><button class="toast-close" aria-label="Dismiss">×</button>';
    el.querySelector('.toast-close').addEventListener('click', function () { el.remove(); });
    $('toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }
  function setBusy(btn, busy, label) {
    if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(label || 'Please wait…'); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function showErr(el, msg) { el.textContent = msg; el.hidden = !msg; }
  function api(url, method, body) {
    return fetch(url, {
      method: method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || 'Something went wrong. Please try again.'); e.status = res.status; throw e; }
        return data;
      });
    });
  }

  /* --------------------------------------------------------------- views */
  function show(view) {
    $('loadingView').hidden = view !== 'loading';
    $('authView').hidden = view !== 'auth';
    $('dashView').hidden = view !== 'dash';
  }

  function setAuthTab(which) {
    var login = which === 'login';
    $('tabLogin').classList.toggle('active', login);
    $('tabRegister').classList.toggle('active', !login);
    $('tabLogin').setAttribute('aria-selected', login ? 'true' : 'false');
    $('tabRegister').setAttribute('aria-selected', login ? 'false' : 'true');
    $('loginForm').hidden = !login;
    $('registerForm').hidden = login;
    $('authTitle').textContent = login ? 'Welcome back' : 'Create your account';
    $('authSub').textContent = login
      ? 'Log in to see your special prices, free bundles and orders.'
      : 'It takes less than a minute. Use your phone number to log in.';
  }
  $('tabLogin').addEventListener('click', function () { setAuthTab('login'); });
  $('tabRegister').addEventListener('click', function () { setAuthTab('register'); });

  function digitsOnly(input) {
    input.addEventListener('input', function () {
      var v = input.value.replace(/[^\d+]/g, '');
      if (v !== input.value) input.value = v;
    });
  }
  ['loginPhone', 'regPhone'].forEach(function (id) { digitsOnly($(id)); });
  $('redeemPhone').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 10);
  });

  /* ------------------------------------------------------------- render */
  var STATUS = {
    pending: 'Awaiting payment', paid: 'Paid', processing: 'Sending data', fulfilled: 'Delivered',
    delivery_failed: 'Failed', delivery_review: 'Checking', refunding: 'Refunding', refunded: 'Refunded'
  };

  function offerCard(o) {
    var free = o.kind === 'free_bundle';
    var kindLabel = free ? 'FREE BUNDLE' : (o.kind === 'percent_off' ? 'DISCOUNT' : 'SPECIAL PRICE');
    var meta = [];
    if (free && o.remaining != null) meta.push(o.remaining + ' left');
    if (!free && o.remaining != null) meta.push(o.remaining + ' use' + (o.remaining === 1 ? '' : 's') + ' left');
    if (o.expiresAt) meta.push('Ends ' + day(o.expiresAt));
    return '<article class="offer-card">' +
      '<span class="offer-kind' + (free ? ' free' : '') + '">' + kindLabel + '</span>' +
      '<h3>' + esc(o.title) + '</h3>' +
      (o.message ? '<p class="offer-msg">' + esc(o.message) + '</p>' : '') +
      (meta.length ? '<p class="offer-meta">' + esc(meta.join(' · ')) + '</p>' : '') +
      (free
        ? '<button type="button" class="pay-btn" data-redeem="' + esc(o.id) + '">Use free bundle</button>'
        : '<a class="pay-btn" href="/#bundles">Shop with this price</a>') +
      '</article>';
  }

  function render(data) {
    OVERVIEW = data;
    var c = data.customer;
    $('avatar').textContent = (String(c.name || 'A').trim().charAt(0) || 'A').toUpperCase();
    $('helloName').textContent = 'Hi, ' + (String(c.name || '').split(' ')[0] || 'there');
    $('helloPhone').textContent = c.phone;

    var offers = data.offers || [];
    $('offersCount').textContent = offers.length ? String(offers.length) : '';
    $('offersList').innerHTML = offers.length
      ? offers.map(offerCard).join('')
      : '<div class="empty-card"><strong>No offers right now</strong>When the store has a special price or free bundle for you, it will appear here.</div>';

    var notices = data.notices || [];
    $('noticesCount').textContent = data.unread ? data.unread + ' new' : '';
    $('noticesList').innerHTML = notices.length
      ? notices.map(function (n) {
          return '<article class="notice-card' + (n.read ? '' : ' unread') + '"><h3>' + esc(n.title) + '</h3><p>' + esc(n.body) + '</p><time>' + esc(when(n.createdAt)) + '</time></article>';
        }).join('')
      : '<div class="empty-card"><strong>No notices</strong>Messages from the store will show up here.</div>';

    var orders = data.orders || [];
    $('ordersCount').textContent = orders.length ? String(orders.length) : '';
    $('ordersList').innerHTML = orders.length
      ? orders.map(function (o) {
          var free = o.source === 'gift' || Number(o.priceGHS) === 0;
          var price = free ? 'FREE' : money(o.priceGHS);
          var was = !free && o.listPriceGHS && o.listPriceGHS > o.priceGHS ? '<s>' + money(o.listPriceGHS) + '</s>' : '';
          return '<article class="order-card">' +
            '<span class="o-title">' + esc(o.network) + ' ' + esc(o.label) + '</span>' +
            '<span class="o-price">' + was + esc(price) + '</span>' +
            '<span class="o-sub">To ' + esc(o.phone) + ' · ' + esc(when(o.createdAt)) + '</span>' +
            '<span class="chip ' + esc(o.status) + '">' + esc(STATUS[o.status] || o.status) + '</span>' +
            '<span class="o-ref">' + esc(o.reference) + '</span></article>';
        }).join('')
      : '<div class="empty-card"><strong>No orders yet</strong>Buy a bundle while logged in and it will be saved here.</div>';

    show('dash');

    // New notices count as read once they have been shown.
    if (data.unread) setTimeout(function () { api('/api/account/notices/read', 'POST', {}).catch(function () {}); }, 2500);
    if (location.hash === '#offers') $('offersSection').scrollIntoView();
  }

  function load() {
    show('loading');
    api('/api/account/overview').then(render).catch(function (err) {
      if (err.status === 401) { show('auth'); return; }
      show('auth');
      toast(err.message, 'error');
    });
  }

  /* ---------------------------------------------------------- auth forms */
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('loginBtn');
    showErr($('loginError'), '');
    if (!$('loginPhone').value.trim() || !$('loginPassword').value) { showErr($('loginError'), 'Enter your phone number and password.'); return; }
    setBusy(btn, true, 'Logging in…');
    api('/api/account/login', 'POST', { phone: $('loginPhone').value, password: $('loginPassword').value })
      .then(function () { $('loginPassword').value = ''; load(); })
      .catch(function (err) { showErr($('loginError'), err.message); })
      .then(function () { setBusy(btn, false); });
  });

  $('registerForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('registerBtn');
    showErr($('registerError'), '');
    setBusy(btn, true, 'Creating account…');
    api('/api/account/register', 'POST', {
      name: $('regName').value, phone: $('regPhone').value, email: $('regEmail').value, password: $('regPassword').value
    })
      .then(function () { $('regPassword').value = ''; toast('Welcome! Your account is ready.', 'success'); load(); })
      .catch(function (err) { showErr($('registerError'), err.message); })
      .then(function () { setBusy(btn, false); });
  });

  $('logoutBtn').addEventListener('click', function () {
    api('/api/account/logout', 'POST', {}).catch(function () {}).then(function () {
      OVERVIEW = null; setAuthTab('login'); show('auth'); window.scrollTo(0, 0);
    });
  });

  $('passwordForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('pwBtn');
    showErr($('pwError'), '');
    setBusy(btn, true, 'Saving…');
    api('/api/account/password', 'POST', { current: $('pwCurrent').value, next: $('pwNew').value })
      .then(function () { $('pwCurrent').value = ''; $('pwNew').value = ''; toast('Password changed.', 'success'); })
      .catch(function (err) { showErr($('pwError'), err.message); })
      .then(function () { setBusy(btn, false); });
  });

  /* ---------------------------------------------------- free bundle sheet */
  function openRedeem(offerId) {
    var offer = (OVERVIEW.offers || []).filter(function (o) { return String(o.id) === String(offerId); })[0];
    if (!offer) return;
    REDEEMING = offer;
    $('redeemWhat').textContent = '🎁 ' + (offer.planLabel ? offer.planLabel + ' bundle' : offer.title);
    $('redeemPhone').value = OVERVIEW.customer.phone || '';
    showErr($('redeemError'), '');
    lastFocused = document.activeElement;
    $('redeemSheet').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { $('redeemPhone').focus(); }, 60);
  }
  function closeRedeem() {
    $('redeemSheet').hidden = true;
    document.body.style.overflow = '';
    REDEEMING = null;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }
  $('offersList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-redeem]');
    if (b) openRedeem(b.getAttribute('data-redeem'));
  });
  $('closeRedeem').addEventListener('click', closeRedeem);
  $('redeemSheet').addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) closeRedeem(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('redeemSheet').hidden) closeRedeem(); });

  $('redeemBtn').addEventListener('click', function () {
    if (!REDEEMING) return;
    var phone = $('redeemPhone').value.replace(/\D/g, '');
    showErr($('redeemError'), '');
    if (!/^0\d{9}$/.test(phone)) { showErr($('redeemError'), 'Enter a valid 10-digit Ghana phone number, e.g. 0551234567.'); return; }
    var btn = $('redeemBtn');
    setBusy(btn, true, 'Sending…');
    api('/api/account/redeem/' + encodeURIComponent(REDEEMING.id), 'POST', { phone: phone })
      .then(function () { closeRedeem(); toast('Done! Your free data is on its way.', 'success'); load(); })
      .catch(function (err) { showErr($('redeemError'), err.message); })
      .then(function () { setBusy(btn, false); });
  });

  /* ------------------------------------------- show/hide password + forgot */
  Array.prototype.forEach.call(document.querySelectorAll('input[type="password"]'), function (input) {
    var wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    wrap.appendChild(btn);
  });

  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
    var foot = document.querySelector('#loginForm .auth-foot');
    if (!foot) return;
    var num = String(s.supportWhatsapp || '').replace(/\D/g, '');
    var phone = s.supportPhone ? String(s.supportPhone).replace(/[^\d+]/g, '') : '';
    if (!num && !phone) return;
    var a = document.createElement('a');
    a.className = 'forgot-link';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = num ? '💬 Forgot password? Message us on WhatsApp' : '📞 Forgot password? Call us';
    a.href = num
      ? 'https://wa.me/' + num + '?text=' + encodeURIComponent('Hello, I forgot my password. Please reset it. My phone number is ' + ($('loginPhone').value || '') )
      : 'tel:' + phone;
    if (num) a.addEventListener('click', function () {
      a.href = 'https://wa.me/' + num + '?text=' + encodeURIComponent('Hello, I forgot my password. Please reset it. My phone number is ' + $('loginPhone').value.trim());
    });
    foot.parentNode.insertBefore(a, foot);
  }).catch(function () {});

  /* --------------------------------------------------------------- init */
  var y = $('year'); if (y) y.textContent = String(new Date().getFullYear());
  load();
})();
