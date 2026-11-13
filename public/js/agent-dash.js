/* The agent's "My shop" dashboard: Home, Prices, My shop (how it looks), Money, Inbox and Settings,
   the QR poster and deleting the shop. Helpers come from js/agent.js (window.Ag). */
(function () {
  'use strict';
  var Ag = window.Ag;
  var $ = Ag.$, money = Ag.money, esc = Ag.esc, toast = Ag.toast, api = Ag.api, busy = Ag.busy, formError = Ag.formError;
  var THEMES = [['gold', 'Gold', '#ffc72c'], ['blue', 'Blue', '#1d4ed8'], ['green', 'Green', '#15803d'], ['purple', 'Purple', '#6d28d9'],
    ['red', 'Red', '#c8102e'], ['teal', 'Teal', '#0f766e'], ['orange', 'Orange', '#c2410c'], ['pink', 'Pink', '#be185d']];
  var COLOUR = {}; THEMES.forEach(function (t) { COLOUR[t[0]] = t[2]; });
  var TABS = ['home', 'prices', 'shop', 'money', 'inbox', 'settings'];
  var st = { d: null, tab: 'home', salesOffset: 0, inboxLoaded: false };

  function when(v, withTime) {
    try { return new Date(v).toLocaleString('en-GB', withTime ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'long', year: 'numeric' }); }
    catch (e) { return ''; }
  }
  function initials(name) {
    return String(name || '').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || 'S';
  }
  function face(a) { return a.logo ? '<img src="' + esc(a.logo) + '" alt="" />' : esc(initials(a.shopName)); }
  function onDark(theme) { return theme !== 'gold'; }

  /* ------------------------------------------------------------ render */
  function render(d) {
    st.d = d;
    Ag.st.data = d;
    var a = d.agent, b = d.balances, p = d.programme;
    var av = $('avatar');
    av.innerHTML = face(a);
    av.style.background = COLOUR[a.theme] || COLOUR.gold;
    av.style.color = onDark(a.theme) ? '#fff' : '#221a00';
    $('shopName').textContent = a.shopName;
    var label = { active: 'Open', pending: 'Waiting for approval', suspended: 'Paused' }[a.status] || a.status;
    $('agStatus').textContent = p.open ? label : 'Programme paused';
    $('agStatus').className = 'ag-status ' + (p.open ? a.status : 'suspended');
    $('agStrikes').hidden = !a.strikes;
    $('agStrikes').textContent = a.strikes + ' strike' + (a.strikes > 1 ? 's' : '');
    $('pwForce').hidden = !a.mustChangePassword;

    var notice = '';
    if (!p.open) notice = 'The agent programme is paused. Your shop link is closed until it reopens. Your earnings are safe.';
    else if (a.status === 'pending') notice = 'Your shop opens as soon as the store approves you. You can set your prices and make the shop yours now.';
    else if (a.status === 'suspended') {
      notice = 'Your shop is paused' + (a.suspendedUntil ? ' until ' + when(a.suspendedUntil) + '. It opens again by itself' : '') + '.' +
        (a.statusReason ? ' Reason: ' + a.statusReason : ' Contact the store to reopen it.');
    }
    $('agNotice').textContent = notice; $('agNotice').hidden = !notice;
    $('termsNotice').hidden = a.termsVersion === p.termsVersion;

    var live = p.open && a.status === 'active';
    $('shopUrl').textContent = d.shopUrl.replace(/^https?:\/\//, '');
    $('openShop').href = d.shopUrl;
    $('shareWa').href = 'https://wa.me/?text=' + encodeURIComponent('Buy data, result checkers and MTN AFA from ' + a.shopName + ': ' + d.shopUrl);
    $('linkCard').classList.toggle('muted-card', !live);
    ['copyLink', 'shareWa'].forEach(function (id) { $(id).hidden = !live; });

    $('mReady').textContent = money(b.readyGHS);
    $('mHeld').textContent = money(b.heldGHS);
    $('mWay').textContent = money(b.onTheWayGHS);
    $('mPaid').textContent = money(b.paidGHS + (b.sendingGHS || 0));
    $('mPayInfo').textContent = 'To ' + (Ag.NET[a.momoNetwork] || a.momoNetwork) + ' ' + a.momoNumber + '. Paid from ' + money(p.minPayoutGHS) +
      (p.payoutFeeGHS > 0 ? ', less a ' + money(p.payoutFeeGHS) + ' transfer fee' : '') + (p.payoutDay != null ? ', every ' + Ag.DAYS[p.payoutDay] : '') + '.';
    renderStats(d.stats);
    badge(a.unread);
    var latest = $('homeMsg');
    latest.hidden = !a.unread;
    latest.textContent = a.unread ? 'You have ' + a.unread + ' new message' + (a.unread > 1 ? 's' : '') + ' from the store. Open your inbox.' : '';

    renderSales(d.sales, false);
    $('homeSales').innerHTML = d.sales.slice(0, 5).map(saleCard).join('') ||
      '<div class="empty-card"><strong>No sales yet</strong>Share your shop link on your WhatsApp status to get your first customer.</div>';
    renderPayouts(d.payouts);
    renderPrices(d.products, p.marginFactor);
    fillShop(a);
    var m = $('momoForm'); m.momoNumber.value = a.momoNumber; m.momoNetwork.value = a.momoNetwork; m.momoName.value = a.momoName; m.password.value = '';
    st.inboxLoaded = false;
    if (st.tab === 'inbox') loadInbox();
  }

  function renderStats(s) {
    if (!s) { $('agStats').innerHTML = ''; return; }
    var tile = function (name, x) {
      return '<div class="ag-stat"><span>' + name + '</span><strong>' + money(x.earnedGHS) + '</strong><small>' + x.orders + ' order' + (x.orders === 1 ? '' : 's') + '</small></div>';
    };
    $('agStats').innerHTML = tile('Today', s.today) + tile('This week', s.week) + tile('This month', s.month);
  }

  function badge(n) {
    $('inboxBadge').hidden = !n;
    $('inboxBadge').textContent = n > 9 ? '9+' : String(n || '');
  }

  /* ------------------------------------------------------------ tabs */
  function setTab(name) {
    if (TABS.indexOf(name) === -1) name = 'home';
    st.tab = name;
    $('dashView').dataset.tab = name;
    TABS.forEach(function (t) { $('pane-' + t).hidden = t !== name; });
    Array.prototype.forEach.call(document.querySelectorAll('.ag-nav-btn'), function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('openSettings').classList.toggle('active', name === 'settings');
    if (name === 'inbox') loadInbox();
    try { history.replaceState(null, '', name === 'home' ? location.pathname : '#' + name); } catch (e) { /* old browser */ }
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-go], .ag-nav-btn');
    if (!t || $('dashView').hidden) return;
    var name = t.dataset.go || t.dataset.tab;
    setTab(name);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ------------------------------------------------------------ prices, shown or hidden, popular */
  function earnFor(row, factor) {
    var input = row.querySelector('input');
    var agentPrice = Number(row.dataset.agent), store = Number(row.dataset.store);
    var val = input.value.trim() === '' ? store : Number(input.value);
    var earnEl = row.querySelector('.ag-row-earn');
    if (!isFinite(val) || val <= 0) { earnEl.textContent = ''; return; }
    var low = val < agentPrice;
    row.classList.toggle('warn', low);
    if (low) { earnEl.textContent = 'Below your cost'; earnEl.classList.add('zero'); return; }
    var e = Math.floor((val - agentPrice) * factor * 100 + 1e-6) / 100;
    earnEl.textContent = 'You earn ' + money(e);
    earnEl.classList.toggle('zero', e <= 0);
  }
  function renderPrices(products, factor) {
    var groups = [], byGroup = {};
    products.forEach(function (p) { if (!byGroup[p.group]) { byGroup[p.group] = []; groups.push(p.group); } byGroup[p.group].push(p); });
    $('priceList').innerHTML = groups.map(function (g) {
      return '<div class="ag-group"><h2>' + esc(g) + '</h2>' + byGroup[g].map(function (p) {
        return '<div class="ag-row' + (p.hidden ? ' off' : '') + '" data-key="' + esc(p.key) + '" data-agent="' + p.agentPrice + '" data-store="' + p.storePrice + '">' +
          '<div class="ag-row-name">' + esc(p.kind === 'data' ? p.label : p.name) + '</div>' +
          '<div class="ag-row-meta">Your cost <b>' + money(p.agentPrice) + '</b>, store price ' + money(p.storePrice) + '</div>' +
          '<div class="ag-row-earn"></div>' +
          '<label><span>Your price</span><input inputmode="decimal" autocomplete="off" placeholder="' + p.storePrice.toFixed(2) + '" value="' + (p.myPrice == null ? '' : p.myPrice.toFixed(2)) + '" aria-label="Your price for ' + esc(p.name) + '" /></label>' +
          '<div class="ag-row-flags">' +
            '<button type="button" class="ag-flag ag-flag-show" aria-pressed="' + !p.hidden + '">' + (p.hidden ? 'Hidden' : 'In my shop') + '</button>' +
            '<button type="button" class="ag-flag ag-flag-pop" aria-pressed="' + !!p.popular + '"' + (p.hidden ? ' disabled' : '') + '>Popular</button>' +
          '</div>' +
          '</div>';
      }).join('') + '</div>';
    }).join('') || '<div class="empty-card"><strong>Nothing to sell yet</strong></div>';
    Array.prototype.forEach.call(document.querySelectorAll('.ag-row'), function (row) {
      earnFor(row, factor);
      row.querySelector('input').addEventListener('input', function () { earnFor(row, factor); });
    });
  }
  $('priceList').addEventListener('click', function (e) {
    var f = e.target.closest('.ag-flag');
    if (!f || f.disabled) return;
    var row = f.closest('.ag-row');
    var on = f.getAttribute('aria-pressed') !== 'true';
    if (f.classList.contains('ag-flag-pop') && on && document.querySelectorAll('.ag-flag-pop[aria-pressed="true"]').length >= 6) {
      toast('Mark at most 6 products as popular.', 'error'); return;
    }
    f.setAttribute('aria-pressed', String(on));
    if (f.classList.contains('ag-flag-show')) {
      f.textContent = on ? 'In my shop' : 'Hidden';
      row.classList.toggle('off', !on);
      var pop = row.querySelector('.ag-flag-pop');
      pop.disabled = !on;
      if (!on) pop.setAttribute('aria-pressed', 'false');
    }
  });
  $('pricesForm').addEventListener('submit', function (e) {
    e.preventDefault();
    formError(e.target, null);
    var prices = {}, hidden = [], featured = [], big = [];
    Array.prototype.forEach.call(document.querySelectorAll('.ag-row'), function (row) {
      var v = row.querySelector('input').value.trim();
      prices[row.dataset.key] = v;
      if (row.querySelector('.ag-flag-show').getAttribute('aria-pressed') !== 'true') hidden.push(row.dataset.key);
      if (row.querySelector('.ag-flag-pop').getAttribute('aria-pressed') === 'true') featured.push(row.dataset.key);
      if (v && Number(v) > Number(row.dataset.store) * 3) big.push(row.querySelector('.ag-row-name').textContent + ' at ' + money(v));
    });
    if (big.length && !confirm('Check these prices before saving:\n' + big.join('\n'))) return;
    busy($('savePrices'), true, 'Saving…');
    api('/api/agent/prices', 'PUT', { prices: prices, hidden: hidden, featured: featured }).then(function (d) {
      st.d.products = d.products;
      renderPrices(d.products, st.d.programme.marginFactor);
      toast('Prices saved. Your shop shows them now.', 'success');
    }).catch(function (err) {
      formError(e.target, err);
      var row = err.key && document.querySelector('.ag-row[data-key="' + err.key + '"] input');
      if (row) { row.focus(); row.scrollIntoView({ block: 'center' }); }
    }).then(function () { busy($('savePrices'), false); });
  });

  /* ------------------------------------------------------------ sales and payouts */
  var STATE = { delivered: 'Delivered', on_the_way: 'On the way', failed: 'Failed', refunded: 'Refunded' };
  function saleCard(s) {
    var counts = s.state === 'delivered' || s.state === 'on_the_way';
    return '<div class="order-card">' +
      '<div class="o-title">' + esc(s.what) + '</div>' +
      '<div class="o-price">' + money(s.priceGHS) + '</div>' +
      '<div class="o-sub">' + esc(s.phone) + ', ' + esc(when(s.createdAt, true)) + '</div>' +
      '<div class="o-earn' + (counts ? '' : ' none') + '">+' + money(s.earningGHS) + '</div>' +
      '<span class="chip ' + esc(s.state) + '" style="justify-self:start">' + esc(STATE[s.state] || s.state) + '</span>' +
      '</div>';
  }
  function renderSales(list, append) {
    var html = list.map(saleCard).join('');
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
        '<div class="o-sub">' + esc(when(p.paidAt || p.createdAt, true)) + ', to ' + esc(p.momoNumber) + (p.feeGHS > 0 ? ' (fee ' + money(p.feeGHS) + ')' : '') + '</div>' +
        '</div>';
    }).join('') || '<div class="empty-card"><strong>No payouts yet</strong>Money you earn is sent to your MoMo once it is ready.</div>';
  }
  $('moreSales').addEventListener('click', function () {
    var btn = this; busy(btn, true, 'Loading…');
    api('/api/agent/sales?offset=' + st.salesOffset).then(function (list) { renderSales(list, true); })
      .catch(function (err) { toast(err.message, 'error'); }).then(function () { busy(btn, false); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-money]'), function (b) {
    b.addEventListener('click', function () {
      var which = b.dataset.money;
      Array.prototype.forEach.call(document.querySelectorAll('[data-money]'), function (x) {
        x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b ? 'true' : 'false');
      });
      $('moneySales').hidden = which !== 'sales';
      $('moneyPayouts').hidden = which !== 'payouts';
    });
  });

  /* ------------------------------------------------------------ inbox */
  var KIND = { strike: 'Strike', paused: 'Paused', approved: 'Open', reopened: 'Open', paid: 'Paid', message: 'Message' };
  function loadInbox() {
    if (st.inboxLoaded) return;
    st.inboxLoaded = true;
    api('/api/agent/messages').then(function (list) {
      $('inboxList').innerHTML = list.map(function (m) {
        return '<article class="ag-msg ' + esc(m.kind) + (m.read ? '' : ' unread') + (m.removed ? ' removed' : '') + '">' +
          '<div class="ag-msg-head"><span class="ag-msg-kind">' + esc(KIND[m.kind] || 'Message') + '</span><time>' + esc(when(m.createdAt, true)) + '</time></div>' +
          '<h3>' + esc(m.title) + (m.removed ? ' <em>(removed by the store)</em>' : '') + '</h3>' +
          (m.body ? '<p>' + esc(m.body) + '</p>' : '') + '</article>';
      }).join('') || '<div class="empty-card"><strong>No messages</strong>Messages from the store show here, and they come by SMS too.</div>';
      if (list.some(function (m) { return !m.read; })) {
        api('/api/agent/messages/read', 'POST').then(function () {
          badge(0); $('homeMsg').hidden = true;
          if (st.d) st.d.agent.unread = 0;
        }).catch(function () { /* stays unread */ });
      }
    }).catch(function (err) { st.inboxLoaded = false; $('inboxList').innerHTML = '<p class="ck-error">' + esc(err.message) + '</p>'; });
  }

  /* ------------------------------------------------------------ my shop: how it looks */
  $('swatches').innerHTML = THEMES.map(function (t) {
    return '<label class="ag-swatch" style="--sw:' + t[2] + '"><input type="radio" name="theme" value="' + t[0] + '" /><span class="ag-swatch-dot" aria-hidden="true"></span><span class="ag-swatch-name">' + t[1] + '</span></label>';
  }).join('');
  function counter(input, out, max) {
    var left = max - input.value.length;
    out.textContent = left <= 30 ? left + ' left' : '';
  }
  function preview() {
    var f = $('shopForm');
    var theme = (f.querySelector('input[name="theme"]:checked') || {}).value || 'gold';
    $('shopPreview').dataset.theme = theme;
    $('pvName').textContent = f.shopName.value.trim() || 'Your shop';
    $('pvBio').textContent = f.bio.value.trim();
    counter(f.bio, $('bioCount'), 140);
    counter(f.announcement, $('noteCount'), 120);
  }
  // Unsaved changes in the form survive a reload of the dashboard (after a logo upload, for example).
  function fillShop(a) {
    var f = $('shopForm');
    var lf = face(a);
    $('logoPreview').innerHTML = lf;
    $('pvStamp').innerHTML = lf;
    $('logoRemove').hidden = !a.logo;
    if (st.shopDirty) return;
    f.shopName.value = a.shopName; f.bio.value = a.bio || ''; f.announcement.value = a.announcement || ''; f.whatsapp.value = a.whatsapp || '';
    var r = f.querySelector('input[name="theme"][value="' + (a.theme || 'gold') + '"]');
    if (r) r.checked = true;
    preview();
  }
  $('shopForm').addEventListener('input', function () { st.shopDirty = true; preview(); });
  $('shopForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, btn = $('saveShop');
    formError(f, null); busy(btn, true, 'Saving…');
    api('/api/agent/shop', 'PUT', { shopName: f.shopName.value, bio: f.bio.value, announcement: f.announcement.value, whatsapp: f.whatsapp.value,
      theme: (f.querySelector('input[name="theme"]:checked') || {}).value })
      .then(function () { st.shopDirty = false; toast('Saved. Your shop shows it now.', 'success'); return Ag.load(); })
      .catch(function (err) { formError(f, err); }).then(function () { busy(btn, false); });
  });

  // A picture is cut to a square and shrunk to 320 × 320 here, so the upload stays small.
  // (Read as a data: address: the site's security policy does not allow blob: pictures.)
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) { reject(new Error('Choose a picture (JPG, PNG or WebP).')); return; }
      if (file.size > 15 * 1024 * 1024) { reject(new Error('That picture is too big. Choose a smaller one.')); return; }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('That picture could not be opened. Try another one.')); };
      reader.onload = function () { draw(reader.result); };
      reader.readAsDataURL(file);
      function draw(url) {
      var img = new Image();
      img.onload = function () {
        var side = Math.min(img.naturalWidth, img.naturalHeight);
        var c = document.createElement('canvas'); c.width = 320; c.height = 320;
        var g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, 320, 320);
        g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 320, 320);
        var q = 0.86, out = c.toDataURL('image/jpeg', q);
        while (out.length > 190000 && q > 0.4) { q -= 0.12; out = c.toDataURL('image/jpeg', q); }
        resolve(out);
      };
      img.onerror = function () { reject(new Error('That picture could not be opened. Try another one.')); };
      img.src = url;
      }
    });
  }
  $('logoFile').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    var label = this.closest('.ag-file');
    label.classList.add('busy');
    shrink(file).then(function (data) {
      $('logoPreview').innerHTML = '<img src="' + data + '" alt="" />';
      return api('/api/agent/logo', 'POST', { image: data });
    }).then(function () { toast('Logo saved.', 'success'); return Ag.load(); })
      .catch(function (err) { toast(err.message, 'error'); if (st.d) fillShop(st.d.agent); })
      .then(function () { label.classList.remove('busy'); });
  });
  $('logoRemove').addEventListener('click', function () {
    api('/api/agent/logo', 'DELETE').then(function () { toast('Logo removed.', 'success'); return Ag.load(); })
      .catch(function (err) { toast(err.message, 'error'); });
  });

  /* ------------------------------------------------------------ link, QR poster */
  $('copyLink').addEventListener('click', function () {
    Ag.copy(st.d.shopUrl).then(function () { toast('Link copied.', 'success'); }, function () { toast('Could not copy. Press and hold the link to copy it.', 'error'); });
  });

  var modalBack = null;
  function openModal(id) {
    modalBack = document.activeElement;
    $(id).hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModals() {
    ['qrModal', 'deleteModal'].forEach(function (id) { $(id).hidden = true; });
    document.body.style.overflow = '';
    if (modalBack && modalBack.focus) modalBack.focus();
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close-modal]') || e.target.id === 'qrModal' || e.target.id === 'deleteModal') closeModals();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && (!$('qrModal').hidden || !$('deleteModal').hidden)) closeModals(); });

  // A 4:5 poster (good for WhatsApp status and for printing): the shop's colour, name, QR code and link.
  function wrapText(g, text, maxWidth) {
    var words = String(text).split(/\s+/), lines = [], line = '';
    words.forEach(function (w) {
      var t = line ? line + ' ' + w : w;
      if (g.measureText(t).width > maxWidth && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }
  function drawPoster() {
    var a = st.d.agent, c = $('qrCanvas'), g = c.getContext('2d'), W = c.width, H = c.height;
    var accent = COLOUR[a.theme] || COLOUR.gold, ink = onDark(a.theme) ? '#ffffff' : '#221a00';
    var display = '"Space Grotesk", "DM Sans", system-ui, sans-serif';
    g.fillStyle = accent; g.fillRect(0, 0, W, H);
    // awning stripes
    for (var x = 0, i = 0; x < W; x += 60, i += 1) {
      g.fillStyle = i % 2 ? '#ffffff' : 'rgba(0,0,0,.28)';
      g.fillRect(x, 0, 60, 70);
      g.beginPath(); g.ellipse(x + 30, 70, 30, 28, 0, 0, Math.PI); g.fill();
    }
    g.fillStyle = ink; g.textAlign = 'center';
    g.font = '700 92px ' + display;
    var lines = wrapText(g, a.shopName, W - 140).slice(0, 2);
    lines.forEach(function (l, n) { g.fillText(l, W / 2, 230 + n * 96); });
    g.font = '500 40px "DM Sans", system-ui, sans-serif';
    g.fillText('Data, result checkers and MTN AFA', W / 2, 230 + lines.length * 96 + 10);
    // white card for the QR code
    var size = 560, top = 470, left = (W - size) / 2;
    g.fillStyle = '#ffffff';
    if (g.roundRect) { g.beginPath(); g.roundRect(left - 40, top - 40, size + 80, size + 80, 40); g.fill(); } else g.fillRect(left - 40, top - 40, size + 80, size + 80);
    var img = new Image();
    return new Promise(function (resolve) {
      img.onload = function () {
        g.imageSmoothingEnabled = false;
        g.drawImage(img, left, top, size, size);
        g.fillStyle = ink; g.textAlign = 'center';
        g.font = '700 54px ' + display;
        g.fillText('Scan to buy', W / 2, top + size + 130);
        g.font = '500 36px "DM Sans", system-ui, sans-serif';
        g.fillText(st.d.shopUrl.replace(/^https?:\/\//, ''), W / 2, top + size + 190);
        resolve();
      };
      img.onerror = function () { resolve(); };
      img.src = '/s/' + encodeURIComponent(a.slug) + '/qr.svg';
    });
  }
  function posterBlob() {
    return new Promise(function (resolve) { $('qrCanvas').toBlob(resolve, 'image/png'); });
  }
  $('openQr').addEventListener('click', function () {
    openModal('qrModal');
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(drawPoster);
    $('qrShare').hidden = !(navigator.canShare && navigator.share);
  });
  $('qrDownload').addEventListener('click', function () {
    posterBlob().then(function (blob) {
      if (!blob) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = st.d.agent.slug + '-poster.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    });
  });
  $('qrShare').addEventListener('click', function () {
    posterBlob().then(function (blob) {
      var file = new File([blob], st.d.agent.slug + '-poster.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share({ files: [file], text: st.d.shopUrl });
      return navigator.share({ title: st.d.agent.shopName, url: st.d.shopUrl });
    }).catch(function () { /* closed */ });
  });

  /* ------------------------------------------------------------ settings */
  function settingsForm(id, url, body, done) {
    $(id).addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, btn = f.querySelector('button[type="submit"]');
      formError(f, null); busy(btn, true, 'Saving…');
      api(url, 'PUT', body(f)).then(function (d) { done(f, d); }).catch(function (err) { formError(f, err); }).then(function () { busy(btn, false); });
    });
  }
  settingsForm('momoForm', '/api/agent/momo', function (f) { return { momoNumber: f.momoNumber.value, momoNetwork: f.momoNetwork.value, momoName: f.momoName.value, password: f.password.value }; },
    function () { toast('MoMo details saved.', 'success'); Ag.load(); });
  settingsForm('passwordForm', '/api/agent/password', function (f) { return { current: f.current.value, next: f.next.value }; },
    function (f) { f.reset(); toast('Password changed.', 'success'); });
  settingsForm('forceForm', '/api/agent/password', function (f) { return { current: f.current.value, next: f.next.value }; },
    function (f) { f.reset(); toast('Password saved.', 'success'); Ag.load(); });

  $('logoutBtn').addEventListener('click', function () {
    Ag.remember(false);
    api('/api/agent/logout', 'POST').then(function () { location.hash = '#login'; location.reload(); });
  });

  $('openDelete').addEventListener('click', function () {
    var b = st.d.balances, owed = (b.readyGHS || 0) + (b.heldGHS || 0) + (b.onTheWayGHS || 0) + (b.sendingGHS || 0);
    $('deleteMoney').textContent = owed > 0.004
      ? 'You still have ' + money(owed) + ' coming. We send it to your MoMo (' + st.d.agent.momoNumber + ') first, then delete your account.'
      : 'You have no money waiting, so your account is deleted straight away.';
    $('deleteForm').password.value = '';
    formError($('deleteForm'), null);
    openModal('deleteModal');
    setTimeout(function () { $('deleteForm').password.focus(); }, 50);
  });
  $('deleteForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, btn = f.querySelector('button[type="submit"]');
    formError(f, null); busy(btn, true, 'Deleting…');
    api('/api/agent/delete', 'POST', { password: f.password.value }).then(function (out) {
      Ag.remember(false);
      closeModals();
      $('goneText').textContent = out.deleted
        ? 'Your shop and your account have been deleted. Thank you for selling with us.'
        : 'Your shop link has stopped working. We will send your ' + money(out.owedGHS) + ' to your MoMo, then delete your account. You will get an SMS.';
      Ag.show('goneView');
    }).catch(function (err) { formError(f, err); busy(btn, false); });
  });

  window.AgDash = { render: render, setTab: setTab };
  // Opening /agent.html#inbox (or #prices, ...) goes straight there.
  var first = location.hash.replace('#', '');
  if (TABS.indexOf(first) !== -1) setTab(first);
  Ag.load();
})();
