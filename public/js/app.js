/* Abrants Data Store — storefront logic (mobile-first) */
(function () {
  'use strict';

  var ALL_PLANS = [];
  var PAUSED = [];
  var PAUSE_MSG = '';
  function pauseText(network) { return (PAUSE_MSG || '{network} bundles are temporarily unavailable. You have not been charged.').replace(/\{network\}/g, network === 'Telecel' ? 'Telecel (Vodafone)' : network); }
  var ACTIVE_NETWORK = 'MTN';
  var SELECTED_PLAN = null;
  var SETTINGS = {};
  var CUSTOMER = null;

  var $ = function (id) { return document.getElementById(id); };
  // Parts of the home page that an agent's shop page (shop.html) does not have.
  var some = function (id, fn) { var el = $(id); if (el) fn(el); };
  var SHOP_PAGE = document.body.classList.contains('shop-page');
  // The home page lists the networks; each network has its own page, /data/mtn and so on (server.js marks it
  // "net-view"), with that network's bundles. An agent's shop shows networks and bundles together.
  var NET_VIEW = document.documentElement.classList.contains('net-view');
  var HOME = !SHOP_PAGE && !NET_VIEW;
  var SLUG_NET = { mtn: 'MTN', 'mtn-up2u': 'MTN UP2U', telecel: 'Telecel', airteltigo: 'AirtelTigo' };
  function pageSlug(network) { for (var k in SLUG_NET) { if (SLUG_NET[k] === network) return k; } return null; }
  if (NET_VIEW) ACTIVE_NETWORK = SLUG_NET[document.documentElement.getAttribute('data-net')] || 'MTN';
  if (HOME && plansGrid) plansGrid.hidden = true; // no bundle list on the home page: no placeholders either
  var validityText = function (v) { v = v || '30 days'; return /^no\b/i.test(v) ? v : 'Valid ' + v; };
  var plansGrid = $('plansGrid');
  var tabsEl = $('networkTabs');
  var sheet = $('checkoutSheet');
  var payBtn = $('payBtn');
  var ckError = $('ckError');
  var phoneInput = $('phoneInput');
  var emailInput = $('emailInput');
  var detectEl = $('networkDetect');
  var lastFocused = null;

  /* ------------------------------------------------------------ helpers */

  // Ghana mobile prefixes, so we can preselect the right network as the
  // customer types. Saves a very common "wrong network" mistake.
  var PREFIXES = {
    MTN: ['024', '054', '055', '059', '025', '053'],
    Telecel: ['020', '050'],
    AirtelTigo: ['026', '056', '027', '057']
  };

  // MTN UP2U bundles go to MTN numbers.
  function baseNet(network) { return network === 'MTN UP2U' ? 'MTN' : network; }

  function networkFromPhone(phone) {
    if (!/^0\d{2}/.test(phone)) return null;
    var prefix = phone.slice(0, 3);
    for (var network in PREFIXES) {
      if (PREFIXES[network].indexOf(prefix) !== -1) return network;
    }
    return null;
  }

  function money(value) {
    return 'GH₵' + Number(value || 0).toFixed(2);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(message, kind) {
    var stack = $('toastStack');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div><button class="toast-close" aria-label="Dismiss">×</button>';
    el.querySelector('.toast-close').addEventListener('click', function () { el.remove(); });
    stack.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }

  function setBusy(button, busy, label) {
    if (busy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> ' + esc(label || 'Please wait…');
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  function showError(message) {
    ckError.textContent = message;
    ckError.hidden = false;
  }

  function clearError() {
    ckError.hidden = true;
    ckError.textContent = '';
  }

  /* -------------------------------------------------------- storefront */

  function loadSettings() {
    fetch('/api/settings')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        SETTINGS = data;

        if (data.announcementEnabled && data.announcement && $('announceBar')) {
          $('announceText').textContent = data.announcement;
          $('announceBar').hidden = false;
        }
        if (data.storeName && HOME) {
          document.title = data.storeName + ' — Fast, affordable data bundles';
        }
        var contact = data.supportWhatsapp || data.supportPhone;
        if (contact && !SHOP_PAGE) {
          var help = data.supportWhatsapp
            ? 'https://wa.me/' + String(data.supportWhatsapp).replace(/[^\d]/g, '').replace(/^0(\d{9})$/, '233$1')
            : 'tel:' + data.supportPhone;
          some('supportLink', function (el) { el.href = help; });
          some('supportStrip', function (el) { el.hidden = false; });
          // "Need help?" card at the top
          some('helpLink', function (el) { el.href = help; });
          if (!data.supportWhatsapp) some('helpLinkText', function (el) { el.textContent = 'Call us'; });
          some('needHelp', function (el) { el.hidden = false; });
        }
        if (data.popup) showNotice(data.popup);
        if (data.agentsOpen) inviteAgents();
        if (data.channelLink && /^https:\/\//i.test(data.channelLink) && $('channelLink')) {
          $('channelLink').href = data.channelLink;
          $('channelStrip').hidden = false;
        }
        PAUSED = Array.isArray(data.pausedNetworks) ? data.pausedNetworks : [];
        PAUSE_MSG = data.pauseMessage || '';
        if (ALL_PLANS.length && PAUSED.length) {
          var nets = [];
          ALL_PLANS.forEach(function (pl) { if (nets.indexOf(pl.network) === -1) nets.push(pl.network); });
          renderTabs(nets);
          renderPlans();
        }
        if (data.maintenanceMode) {
          toast(data.maintenanceMessage || 'The store is briefly closed for maintenance.', 'error');
        }
      })
      .catch(function () { /* settings are optional */ });
  }

  /* ------------------------------------------------------- pop-up message */

  // The owner's message (Admin → Settings → Pop-up message), shown once per visit when the store opens: in a new tab
  // or a later visit it shows again, and a changed message shows even to people who closed the old one.
  var NOTICE_KEY = 'abrants_notice_seen';
  var noticeOpen = false;
  function showNotice(n) {
    var seen = null;
    try { seen = sessionStorage.getItem(NOTICE_KEY); } catch (e) { /* private mode */ }
    if (!n || !n.text || seen === String(n.version) || document.getElementById('noticePop')) return;
    var before = document.activeElement;
    var pop = document.createElement('div');
    pop.className = 'notice-pop';
    pop.id = 'noticePop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-describedby', 'noticePopText');
    if (n.title) pop.setAttribute('aria-labelledby', 'noticePopTitle'); else pop.setAttribute('aria-label', 'Message from the store');
    pop.innerHTML =
      '<div class="notice-pop-backdrop" data-close></div>' +
      '<div class="notice-pop-card" tabindex="-1">' +
        '<div class="notice-pop-top" aria-hidden="true"><span class="notice-pop-bars"><i></i><i></i><i></i><i></i></span></div>' +
        '<button type="button" class="notice-pop-x" data-close aria-label="Close">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
        '<div class="notice-pop-body">' +
          (n.title ? '<h2 id="noticePopTitle"></h2>' : '') +
          '<p id="noticePopText"></p>' +
          '<button type="button" class="notice-pop-ok" data-close>Got it</button>' +
        '</div>' +
      '</div>';
    if (n.title) pop.querySelector('#noticePopTitle').textContent = n.title;
    pop.querySelector('#noticePopText').textContent = n.text;
    document.body.appendChild(pop);
    noticeOpen = true;
    document.documentElement.classList.add('notice-open');
    requestAnimationFrame(function () { requestAnimationFrame(function () { pop.classList.add('open'); }); });
    var ok = pop.querySelector('.notice-pop-ok');
    var card = pop.querySelector('.notice-pop-card');
    setTimeout(function () { try { card.focus({ preventScroll: true }); } catch (e) { card.focus(); } }, 60);

    function close() {
      if (!noticeOpen) return;
      noticeOpen = false;
      try { sessionStorage.setItem(NOTICE_KEY, String(n.version)); } catch (e) { /* private mode */ }
      document.removeEventListener('keydown', onKey, true);
      pop.classList.remove('open');
      pop.classList.add('closing');
      document.documentElement.classList.remove('notice-open');
      setTimeout(function () { pop.remove(); }, 260);
      if (before && before.focus && before !== document.body) { try { before.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') { // keep the keyboard inside the message
        var items = [pop.querySelector('.notice-pop-x'), ok];
        var i = items.indexOf(document.activeElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
      }
    }
    pop.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey, true);
  }

  /* ------------------------------------------------- agent programme invite */

  // Shown only while the owner has the agent programme switched on, never inside an agent's shop, never over the
  // checkout, and at most once every 3 days for someone who closes it (30 days for someone who opens it).
  function inviteAgents() {
    if (SHOP_PAGE || document.documentElement.classList.contains('in-shop')) return;
    // Someone who already has a shop sees "My shop" instead (js/myshop.js).
    try { if (localStorage.getItem('abrants_agent') === '1') return; } catch (e) { /* private mode */ }
    if ($('agentCta')) $('agentCta').hidden = false;
    if ($('needAgent')) $('needAgent').hidden = false;
    var pop = $('agentPop');
    if (!pop) return;
    var KEY = 'abrants_agent_invite';
    var until = 0;
    try { until = Number(localStorage.getItem(KEY) || 0); } catch (e) { /* private mode */ }
    if (Date.now() < until) return;
    var shown = false;
    function later(days) { try { localStorage.setItem(KEY, String(Date.now() + days * 864e5)); } catch (e) { /* private mode */ } }
    function show() {
      if (shown || document.documentElement.classList.contains('in-shop')) return;
      if (noticeOpen || !sheet.hidden || !$('firstTimeConfirm').hidden) { setTimeout(show, 5000); return; }
      shown = true;
      window.removeEventListener('scroll', onScroll);
      pop.hidden = false;
      requestAnimationFrame(function () { pop.classList.add('open'); });
    }
    function onScroll() { if (window.scrollY > window.innerHeight * 1.2) show(); }
    setTimeout(show, 8000);
    window.addEventListener('scroll', onScroll, { passive: true });
    $('agentPopClose').addEventListener('click', function () { pop.hidden = true; later(3); });
    $('agentPopGo').addEventListener('click', function () { later(30); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden && sheet.hidden) { pop.hidden = true; later(3); } });
  }

  // In an agent's shop (js/shop.js) the server answers with that agent's prices.
  function shopQuery() { return window.abrantsShopQuery ? window.abrantsShopQuery() : ''; }

  function loadPlans() {
    if (SHOP_PAGE && !shopQuery()) return; // a closed shop shows no bundles
    fetch('/api/plans' + shopQuery())
      .then(function (res) {
        if (!res.ok) throw new Error('Unable to load bundles.');
        return res.json();
      })
      .then(function (plans) {
        ALL_PLANS = Array.isArray(plans) ? plans : [];
        if (!ALL_PLANS.length) {
          plansGrid.innerHTML = '<div class="empty-state"><strong>No bundles available right now</strong>Please check back shortly.</div>';
          return;
        }
        var networks = [];
        ALL_PLANS.forEach(function (plan) {
          if (networks.indexOf(plan.network) === -1) networks.push(plan.network);
        });
        if (networks.indexOf(ACTIVE_NETWORK) === -1) ACTIVE_NETWORK = networks[0];
        renderTabs(networks);
        if (HOME) { plansGrid.hidden = true; PULSE.plans(); return; }
        renderPlans();
        if (NET_VIEW) { renderNetHero(); openAsked(); }
      })
      .catch(function () {
        plansGrid.innerHTML = '<div class="empty-state"><strong>We could not load bundles</strong>Please refresh the page and try again.</div>';
      });
  }

  // MTN UP2U right after MTN (it is an MTN product), so it is seen without scrolling the tabs.
  var TAB_RANK = { MTN: 1, 'MTN UP2U': 2, Telecel: 3, AirtelTigo: 4 };
  // Each network is a card: its colour, a signal meter, its lowest price and how many bundles it has.
  var NET_SLUG = { MTN: 'mtn', 'MTN UP2U': 'up2u', Telecel: 'telecel', AirtelTigo: 'airtel' };
  function netSlug(network) { return NET_SLUG[network] || 'other'; }
  function renderTabs(networks) {
    networks = networks.slice().sort(function (a, b) { return (TAB_RANK[a] || 9) - (TAB_RANK[b] || 9); });
    tabsEl.innerHTML = networks.map(function (network) {
      var plans = ALL_PLANS.filter(function (p) { return p.network === network; });
      var from = Math.min.apply(null, plans.map(function (p) { return Number(p.priceGHS); }));
      var on = network === ACTIVE_NETWORK;
      var paused = PAUSED.indexOf(network) !== -1;
      var open = HOME && pageSlug(network)
        ? '<a class="tab net-card net-' + netSlug(network) + (paused ? ' paused' : '') + '" href="/data/' + pageSlug(network) + '" data-network="' + esc(network) + '">'
        : '<button type="button" class="tab net-card net-' + netSlug(network) + (on ? ' active' : '') + (paused ? ' paused' : '') + '" role="tab" aria-selected="' + on + '" data-network="' + esc(network) + '">';
      return open +
        '<span class="net-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' +
        '<span class="net-name">' + esc(network === 'Telecel' ? 'Telecel' : network) + '</span>' +
        '<span class="net-from">' + (paused ? 'Paused for now' : 'From ' + money(from)) + '</span>' +
        '<span class="count">' + (paused ? 'Paused' : network === 'MTN UP2U' ? 'No expiry' : plans.length + ' bundle' + (plans.length === 1 ? '' : 's')) + '</span>' +
        (open.charAt(1) === 'a' ? '</a>' : '</button>');
    }).join('');
    if (HOME) tabsEl.removeAttribute('role'); // links to the network pages, not tabs
  }

  /* A network's own page: a banner in its colour (back to all networks, its name, lowest price), then its bundles. */
  function renderNetHero() {
    var el = $('netHero');
    if (!el) return;
    var plans = ALL_PLANS.filter(function (p) { return p.network === ACTIVE_NETWORK; });
    var from = plans.length ? Math.min.apply(null, plans.map(function (p) { return Number(p.priceGHS); })) : null;
    el.className = 'net-hero net-' + netSlug(ACTIVE_NETWORK);
    el.innerHTML = '<a class="net-back" href="/#bundles"><span aria-hidden="true">‹</span> All networks</a>' +
      '<h1>' + esc(ACTIVE_NETWORK) + '</h1>' +
      '<p>' + (plans.length ? plans.length + ' bundle' + (plans.length === 1 ? '' : 's') + ' · from ' + money(from) : 'No bundles right now') +
      (ACTIVE_NETWORK === 'MTN UP2U' ? ' · no expiry' : '') + '</p>' +
      '<span class="net-hero-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
    el.hidden = false;
    document.documentElement.setAttribute('data-net', pageSlug(ACTIVE_NETWORK) || '');
    document.title = ACTIVE_NETWORK + ' data bundles · Abrants Data Store';
  }
  // From "Popular this week": /data/mtn?plan=mtn-5gb opens that bundle's checkout straight away.
  function openAsked() {
    var want = null;
    try { want = new URLSearchParams(location.search).get('plan'); } catch (e) { want = null; }
    if (!want) return;
    var plan = ALL_PLANS.filter(function (p) { return p.id === want && p.network === ACTIVE_NETWORK; })[0];
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* old browser */ }
    if (plan) openSheet(plan);
  }

  function renderPlans() {
    var plans = ALL_PLANS.filter(function (p) { return p.network === ACTIVE_NETWORK; });
    plansGrid.setAttribute('data-net', netSlug(ACTIVE_NETWORK));
    if (PAUSED.indexOf(ACTIVE_NETWORK) !== -1) {
      plansGrid.innerHTML = '<div class="empty-state paused-state"><strong>' + esc(ACTIVE_NETWORK === 'Telecel' ? 'Telecel (Vodafone)' : ACTIVE_NETWORK) + ' is paused for now</strong>' + esc(pauseText(ACTIVE_NETWORK)) + '</div>';
      return;
    }
    if (!plans.length) {
      plansGrid.innerHTML = '<div class="empty-state"><strong>No bundles for this network yet</strong>Try another network above.</div>';
      return;
    }

    var bestId = null;
    var bestUnit = Infinity;
    // "Best value" by price per GB; not for MTN UP2U, where some packages carry minutes too.
    if (ACTIVE_NETWORK !== 'MTN UP2U') plans.forEach(function (p) {
      var unit = Number(p.capacityGB) > 0 ? Number(p.priceGHS) / Number(p.capacityGB) : Infinity;
      if (unit < bestUnit) { bestUnit = unit; bestId = p.id; }
    });

    plansGrid.innerHTML = plans.map(function (plan) {
      var unit = Number(plan.capacityGB) >= 0.1 && !/min/i.test(plan.label) ? Number(plan.priceGHS) / Number(plan.capacityGB) : null;
      var isBest = plan.id === bestId && plans.length > 1;
      var validity = plan.validity || '30 days';
      // In an agent's shop: the bundles the agent marked "Popular" (they come first), then the best value.
      var tag = plan.special ? '<span class="plan-tag mine">YOUR PRICE</span>'
        : plan.popular ? '<span class="plan-tag popular">Popular</span>'
        : isBest ? '<span class="plan-tag">' + (SHOP_PAGE ? 'Best value' : 'BEST VALUE') + '</span>' : '';
      return '<button type="button" class="plan-card' + (plan.special ? ' special-plan' : (plan.popular ? ' popular-plan' : (isBest ? ' featured-plan' : ''))) + '" data-plan="' + esc(plan.id) + '">' +
        tag +
        '<span class="plan-size">' + esc(plan.label) + '</span>' +
        '<span class="plan-validity">' + esc(validityText(validity)) + '</span>' +
        '<span class="plan-price">' +
          (plan.special && plan.listPriceGHS ? '<s class="plan-was">' + money(plan.listPriceGHS) + '</s>' : '') +
          money(plan.priceGHS) + '</span>' +
        (unit ? '<span class="plan-unit">' + money(unit) + ' per GB</span>' : '') +
        '</button>';
    }).join('');
  }

  tabsEl.addEventListener('click', function (event) {
    var btn = event.target.closest('.tab');
    if (!btn || HOME) return; // on the home page the cards are links to the network pages
    ACTIVE_NETWORK = btn.dataset.network;
    if (NET_VIEW) {
      try { history.replaceState(null, '', '/data/' + pageSlug(ACTIVE_NETWORK)); } catch (e) { /* old browser */ }
      renderNetHero();
    }
    Array.prototype.forEach.call(tabsEl.querySelectorAll('.tab'), function (tab) {
      var on = tab === btn;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderPlans();
    // On a phone the bundles are below the cards: bring their top into view if it is off screen.
    var top = plansGrid.getBoundingClientRect().top;
    if (top > window.innerHeight - 140) {
      plansGrid.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  });

  /* ----------------------------------------------------------- checkout */

  function openSheet(plan) {
    SELECTED_PLAN = plan;
    if ($('agentPop')) $('agentPop').hidden = true; // never over the checkout
    $('ckPlanLabel').textContent = plan.label;
    $('ckNetwork').textContent = plan.network + ' · delivered to your number';
    // Paystack's fee is paid by the customer on top of the bundle price (same rounding as the server).
    var feeRate = Number(SETTINGS.paymentFeeRate) > 0 ? Number(SETTINGS.paymentFeeRate) : 0.0195;
    var total = SETTINGS.customerPaysFee === false ? Number(plan.priceGHS) : Math.ceil(Math.round(Number(plan.priceGHS) * 100 / (1 - feeRate) * 1e6) / 1e6) / 100;
    var fee = Math.round((total - Number(plan.priceGHS)) * 100) / 100;
    $('ckPrice').textContent = money(total);
    var feeEl = $('ckFee');
    if (fee > 0) { feeEl.textContent = 'Bundle ' + money(plan.priceGHS) + ' + payment fee ' + money(fee) + ' (charged by Paystack)'; feeEl.hidden = false; } else { feeEl.hidden = true; }
    $('ckValidity').textContent = validityText(plan.validity);
    var sp = $('ckSpecial');
    if (plan.special && plan.listPriceGHS) {
      $('ckSpecialText').textContent = '🎁 ' + (plan.offerTitle || 'Special price for you') + ' — normally ' + money(plan.listPriceGHS);
      sp.hidden = false;
    } else { sp.hidden = true; }
    clearError();
    lastFocused = document.activeElement;
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    updateDetect();
    setTimeout(function () { phoneInput.focus(); }, 60);
  }

  function closeSheet() {
    sheet.hidden = true;
    document.body.style.overflow = '';
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  plansGrid.addEventListener('click', function (event) {
    var card = event.target.closest('.plan-card');
    if (!card) return;
    var plan = ALL_PLANS.filter(function (p) { return p.id === card.dataset.plan; })[0];
    if (plan) openSheet(plan);
  });

  $('closeCheckout').addEventListener('click', closeSheet);
  sheet.addEventListener('click', function (event) {
    if (event.target.hasAttribute('data-close')) closeSheet();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !sheet.hidden) closeSheet();
  });

  // Live network detection while typing the number.
  function updateDetect() {
    var phone = phoneInput.value.replace(/\D/g, '');
    if (phone.length < 3) { detectEl.hidden = true; return; }
    var network = networkFromPhone(phone);
    detectEl.hidden = false;
    if (!network) {
      detectEl.className = 'network-detect warn';
      detectEl.textContent = 'We could not recognise this prefix — please double-check the number.';
      return;
    }
    detectEl.className = 'network-detect';
    if (SELECTED_PLAN && network !== baseNet(SELECTED_PLAN.network)) {
      detectEl.className = 'network-detect warn';
      detectEl.textContent = 'This looks like a ' + network + ' number, but you picked a ' + SELECTED_PLAN.network + ' bundle.';
    } else {
      detectEl.textContent = '✓ Looks like a ' + network + ' number.';
    }
  }

  phoneInput.addEventListener('input', function () {
    var digits = phoneInput.value.replace(/\D/g, '').slice(0, 10);
    phoneInput.value = digits;
    updateDetect();
  });

  emailInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); payBtn.click(); }
  });

  payBtn.addEventListener('click', function () {
    clearError();
    if (!SELECTED_PLAN) { showError('Please pick a bundle first.'); return; }

    var phone = phoneInput.value.replace(/\D/g, '');
    var email = emailInput.value.trim();

    if (!/^0\d{9}$/.test(phone)) {
      showError('Enter a valid 10-digit Ghana phone number, e.g. 0551234567.');
      phoneInput.focus();
      return;
    }
    var detected = networkFromPhone(phone);
    if (SELECTED_PLAN.network === 'MTN UP2U' && detected !== 'MTN') {
      showError('MTN UP2U works only on MTN numbers (024, 025, 053, 054, 055 or 059).');
      phoneInput.focus();
      return;
    }
    if (detected && detected !== baseNet(SELECTED_PLAN.network)) {
      showError('That number looks like ' + detected + '. Please choose a ' + detected + ' bundle, or check the number.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      showError('Enter a valid email address so we can send your receipt.');
      emailInput.focus();
      return;
    }

    startCheckout(phone, email, false);
  });

  // Sends the customer to Paystack. For a first-time MTN number the server first asks us to get a "yes".
  function startCheckout(phone, email, confirmed) {
    setBusy(payBtn, true, 'Starting secure payment…');
    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: SELECTED_PLAN.id, phone: phone, email: email, confirmFirstTime: confirmed === true, campaign: window.abrantsFrom ? window.abrantsFrom() : '', shop: window.abrantsShop ? window.abrantsShop() : '' })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .then(function (result) {
        if (result.status === 409 && result.data.firstTime) {
          setBusy(payBtn, false);
          askFirstTime(result.data.message, function () { startCheckout(phone, email, true); }, result.data.title);
          return;
        }
        if (!result.ok) throw new Error(result.data.error || 'Something went wrong. Please try again.');
        try { localStorage.setItem('abrants_email', email); localStorage.setItem('abrants_last_order', result.data.reference || ''); } catch (e) { /* private mode */ }
        toast('Taking you to secure payment…', 'success');
        window.location.href = result.data.authorizationUrl;
      })
      .catch(function (err) {
        setBusy(payBtn, false);
        showError(err.message);
      });
  }

  function askFirstTime(message, onYes, title) {
    var box = $('firstTimeConfirm');
    $('ftTitle').textContent = title || 'First time on this number?';
    $('ftText').textContent = message || 'A brand-new MTN number must be verified by MTN before data can be delivered. This can take up to 7 days. Do you want to continue?';
    box.hidden = false;
    var yes = $('ftYes'), no = $('ftNo');
    function close() { box.hidden = true; yes.onclick = null; no.onclick = null; }
    yes.onclick = function () { close(); onYes(); };
    no.onclick = function () { close(); };
    yes.focus();
  }

  /* -------------------------------------------------------------- init */

  try {
    var savedEmail = localStorage.getItem('abrants_email');
    if (savedEmail) emailInput.value = savedEmail;
  } catch (e) { /* private mode */ }

  var yearEl = $('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  function loadMe() {
    if (SHOP_PAGE || !$('accountLink')) return; // customer accounts and offers do not apply in an agent's shop
    return fetch('/api/account/me', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.customer) { if ($('memberPromo')) $('memberPromo').hidden = false; return; }
        CUSTOMER = data.customer;
        var first = String(CUSTOMER.name || '').split(' ')[0] || 'Account';
        $('accountLinkText').textContent = first;
        $('accountLink').classList.add('logged-in');
        $('accountDot').hidden = !data.unread;
        $('guestHint').hidden = true;
        if ($('memberPromo')) $('memberPromo').hidden = true;
        if (!phoneInput.value && CUSTOMER.phone) phoneInput.value = CUSTOMER.phone;
        if (!emailInput.value && CUSTOMER.email) emailInput.value = CUSTOMER.email;
        if (data.offers) {
          $('offerBannerText').textContent = 'You have ' + data.offers + ' offer' + (data.offers > 1 ? 's' : '') + ' waiting — tap to view';
          $('offerBanner').hidden = false;
        }
      })
      .catch(function () { if ($('memberPromo')) $('memberPromo').hidden = false; });
  }

  /* ----------------------------------------------------- the store's pulse (home page) */
  // Delivery speed per network, what sold most this week, the latest deliveries: /api/pulse, answered from the
  // server's memory (never the database). Each part shows only once there is enough to show.
  var PULSE = (function () {
    var data = null, plansReady = false;
    var bars = '<span class="net-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
    function ago(ms) {
      var m = Math.round(ms / 60000);
      return m < 1 ? 'just now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
    }
    function render() {
      if (!data || !plansReady || !$('pulse')) return;
      var shown = 0;
      $('pulseSpeed').hidden = !data.speed.length;
      if (data.speed.length) {
        shown++;
        $('speedList').innerHTML = data.speed.map(function (x) {
          return '<li class="net-' + netSlug(x.network) + '">' + bars + '<b>' + esc(x.network) + '</b><span>' + esc(x.label) + '</span>' +
            '<i class="sp-track"><i data-fill="' + Number(x.fill) + '"></i></i></li>';
        }).join('');
        Array.prototype.forEach.call($('speedList').querySelectorAll('[data-fill]'), function (el) { el.style.width = Math.round(Number(el.getAttribute('data-fill')) * 100) + '%'; });
      }
      var pop = data.popular.map(function (x) { return ALL_PLANS.filter(function (p) { return p.id === x.planId; })[0]; })
        .filter(function (p) { return p && pageSlug(p.network); }).slice(0, 6);
      $('pulsePopular').hidden = pop.length < 3;
      if (pop.length >= 3) {
        shown++;
        $('popRow').innerHTML = pop.map(function (p, i) {
          return '<a class="pop-card net-' + netSlug(p.network) + '" href="/data/' + pageSlug(p.network) + '?plan=' + encodeURIComponent(p.id) + '">' +
            '<span class="pop-rank">' + (i === 0 ? 'Top pick' : '#' + (i + 1)) + '</span>' + bars +
            '<b class="pop-size">' + esc(p.label) + '</b><span class="pop-net">' + esc(p.network) + '</span>' +
            '<span class="pop-price">' + money(p.priceGHS) + '</span><span class="pop-buy">Buy</span></a>';
        }).join('');
      }
      $('pulseLive').hidden = !data.live.length;
      if (data.live.length) {
        shown++;
        $('liveList').innerHTML = data.live.map(function (x) {
          return '<li class="net-' + netSlug(x.network) + '"><span class="lv-tile">' + esc(x.who.slice(0, 3)) + '</span>' +
            '<span class="lv-txt"><b>' + esc(x.who) + '</b><span>got ' + esc(x.network + ' ' + x.label) + '</span></span><time>' + ago(x.agoMs) + '</time></li>';
        }).join('');
      }
      $('pulse').hidden = !shown;
    }
    function load() {
      fetch('/api/pulse').then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) { data = d; render(); } }).catch(function () { /* the page works without it */ });
    }
    if (HOME && $('pulse')) {
      load();
      setInterval(function () { if (!document.hidden) load(); }, 60000);
    }
    return { plans: function () { plansReady = true; render(); } };
  })();

  loadSettings();
  loadPlans();
  loadMe();
  // Result checkers and AFA: show what is on sale right now, or "Coming soon". (The shop page does its own.)
  if (!SHOP_PAGE) fetch('/api/services' + shopQuery()).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d || !$('needChkText')) return;
    var chk = d.checkers || [];
    if (chk.length) {
      var low = Math.min.apply(null, chk.map(function (c) { return c.price; }));
      // "WASSCE Results" -> "WASSCE": the card already says what they are.
      $('needChkText').textContent = chk.map(function (c) { return String(c.name).replace(/\s+results?$/i, ''); }).join(', ') + ' PINs from GH₵' + low.toFixed(2) + '.';
    } else {
      $('needChkText').textContent = 'WASSCE and BECE PINs. Coming soon.';
    }
    if (d.afa) {
      $('afaFeeStep').textContent = 'Fill in your Ghana Card details and pay the GH₵' + Number(d.afa.price).toFixed(2) + ' registration fee.';
    } else {
      $('afaRegister').hidden = true; $('afaSoon').hidden = false;
    }
  }).catch(function () {});
})();
