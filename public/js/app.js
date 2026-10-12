/* Abrants Data Store — storefront logic (mobile-first) */
(function () {
  'use strict';

  var ALL_PLANS = [];
  var ACTIVE_NETWORK = 'MTN';
  var SELECTED_PLAN = null;
  var SETTINGS = {};
  var CUSTOMER = null;

  var $ = function (id) { return document.getElementById(id); };
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

        if (data.announcementEnabled && data.announcement) {
          $('announceText').textContent = data.announcement;
          $('announceBar').hidden = false;
        }
        if (data.storeName) {
          document.title = data.storeName + ' — Fast, affordable data bundles';
        }
        var contact = data.supportWhatsapp || data.supportPhone;
        if (contact) {
          var link = $('supportLink');
          link.href = data.supportWhatsapp
            ? 'https://wa.me/' + String(data.supportWhatsapp).replace(/[^\d]/g, '')
            : 'tel:' + data.supportPhone;
          $('supportStrip').hidden = false;
        }
        if (data.channelLink && /^https:\/\//i.test(data.channelLink)) {
          $('channelLink').href = data.channelLink;
          $('channelStrip').hidden = false;
        }
        if (data.maintenanceMode) {
          toast(data.maintenanceMessage || 'The store is briefly closed for maintenance.', 'error');
        }
      })
      .catch(function () { /* settings are optional */ });
  }

  function loadPlans() {
    fetch('/api/plans')
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
        renderPlans();
      })
      .catch(function () {
        plansGrid.innerHTML = '<div class="empty-state"><strong>We could not load bundles</strong>Please refresh the page and try again.</div>';
      });
  }

  function renderTabs(networks) {
    tabsEl.innerHTML = networks.map(function (network) {
      var count = ALL_PLANS.filter(function (p) { return p.network === network; }).length;
      var cls = network === ACTIVE_NETWORK ? 'tab active' : 'tab';
      var dot = network === 'MTN' ? 'mtn' : (network === 'Telecel' ? 'telecel' : 'airtel');
      return '<button class="' + cls + '" role="tab" aria-selected="' + (network === ACTIVE_NETWORK) +
        '" data-network="' + esc(network) + '"><span class="network-dot ' + dot + '"></span>' +
        esc(network) + '<span class="count">' + count + '</span></button>';
    }).join('');
  }

  function renderPlans() {
    var plans = ALL_PLANS.filter(function (p) { return p.network === ACTIVE_NETWORK; });
    if (!plans.length) {
      plansGrid.innerHTML = '<div class="empty-state"><strong>No bundles for this network yet</strong>Try another network above.</div>';
      return;
    }

    var bestId = null;
    var bestUnit = Infinity;
    plans.forEach(function (p) {
      var unit = Number(p.capacityGB) > 0 ? Number(p.priceGHS) / Number(p.capacityGB) : Infinity;
      if (unit < bestUnit) { bestUnit = unit; bestId = p.id; }
    });

    plansGrid.innerHTML = plans.map(function (plan) {
      var unit = Number(plan.capacityGB) > 0 ? Number(plan.priceGHS) / Number(plan.capacityGB) : null;
      var isBest = plan.id === bestId && plans.length > 1;
      return '<button type="button" class="plan-card' + (plan.special ? ' special-plan' : (isBest ? ' featured-plan' : '')) + '" data-plan="' + esc(plan.id) + '">' +
        (plan.special ? '<span class="plan-tag mine">YOUR PRICE</span>' : (isBest ? '<span class="plan-tag">BEST VALUE</span>' : '')) +
        '<span class="plan-size">' + esc(plan.label) + '</span>' +
        '<span class="plan-validity">Valid ' + esc(plan.validity || '30 days') + '</span>' +
        '<span class="plan-price">' +
          (plan.special && plan.listPriceGHS ? '<s class="plan-was">' + money(plan.listPriceGHS) + '</s>' : '') +
          money(plan.priceGHS) + '</span>' +
        (unit ? '<span class="plan-unit">' + money(unit) + ' per GB</span>' : '') +
        '</button>';
    }).join('');
  }

  tabsEl.addEventListener('click', function (event) {
    var btn = event.target.closest('.tab');
    if (!btn) return;
    ACTIVE_NETWORK = btn.dataset.network;
    Array.prototype.forEach.call(tabsEl.querySelectorAll('.tab'), function (tab) {
      var on = tab === btn;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderPlans();
  });

  /* ----------------------------------------------------------- checkout */

  function openSheet(plan) {
    SELECTED_PLAN = plan;
    $('ckPlanLabel').textContent = plan.label;
    $('ckNetwork').textContent = plan.network + ' · delivered to your number';
    $('ckPrice').textContent = money(plan.priceGHS);
    $('ckValidity').textContent = 'Valid ' + (plan.validity || '30 days');
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
    if (SELECTED_PLAN && network !== SELECTED_PLAN.network) {
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
    if (detected && detected !== SELECTED_PLAN.network) {
      showError('That number looks like ' + detected + '. Please choose a ' + detected + ' bundle, or check the number.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      showError('Enter a valid email address so we can send your receipt.');
      emailInput.focus();
      return;
    }

    setBusy(payBtn, true, 'Starting secure payment…');
    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: SELECTED_PLAN.id, phone: phone, email: email })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || 'Something went wrong. Please try again.');
        try { localStorage.setItem('abrants_email', email); } catch (e) { /* private mode */ }
        toast('Taking you to secure payment…', 'success');
        window.location.href = result.data.authorizationUrl;
      })
      .catch(function (err) {
        setBusy(payBtn, false);
        showError(err.message);
      });
  });

  /* -------------------------------------------------------------- init */

  try {
    var savedEmail = localStorage.getItem('abrants_email');
    if (savedEmail) emailInput.value = savedEmail;
  } catch (e) { /* private mode */ }

  var yearEl = $('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  function loadMe() {
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

  loadSettings();
  loadPlans();
  loadMe();
})();
