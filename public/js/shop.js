/* Agent shops. A shop link (abrantsdata.com/s/kwame-data-hub) opens that agent's own shop page (shop.html); its order
   page is /s/kwame-data-hub/order and its checker/AFA page /s/kwame-data-hub/services (Paystack returns there after
   paying). Inside a shop everything stays in the shop: the header shows the shop, and every link that would lead to the
   store's own pages leads to the shop's instead, including links a page adds later. The shop is also remembered for
   this browser tab. Opening the store's own address (abrantsdata.com) leaves the shop. Prices are decided by the server. */
(function () {
  'use strict';
  var KEY = 'abrants_shop';
  var COLOURS = { gold: '#ffc72c', blue: '#1d4ed8', green: '#15803d', purple: '#6d28d9', red: '#c8102e', teal: '#0f766e', orange: '#c2410c', pink: '#be185d' };
  var m = /^\/s\/([A-Za-z0-9-]{1,40})(?:\/(order|services))?\/?$/.exec(location.pathname);
  var home = location.pathname === '/' || location.pathname === '/index.html';
  var slug = '';
  try {
    if (m) { slug = m[1].toLowerCase(); sessionStorage.setItem(KEY, slug); }
    else if (home) sessionStorage.removeItem(KEY);
    else slug = sessionStorage.getItem(KEY) || '';
  } catch (e) { slug = m ? m[1].toLowerCase() : ''; }

  window.abrantsShop = function () { return slug; };
  window.abrantsShopQuery = function () { return slug ? '?shop=' + encodeURIComponent(slug) : ''; };
  if (!slug) { window.abrantsShopInfo = Promise.resolve(null); return; }

  var root = document.documentElement;
  root.classList.add('in-shop'); // hides the store's own accounts, offers and links straight away
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function forget() {
    slug = '';
    root.classList.remove('in-shop');
    try { sessionStorage.removeItem(KEY); } catch (e) { /* private mode */ }
  }
  function initials(name) {
    return String(name || '').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || 'S';
  }
  window.abrantsShopAvatar = function (d) {
    return d.logo ? '<img src="' + esc(d.logo) + '" alt="" width="38" height="38" />' : esc(initials(d.name));
  };

  /* Where a link to one of the store's own pages goes inside this shop (null = leave it alone). */
  function inShop(href) {
    var base = '/s/' + encodeURIComponent(slug);
    var u;
    try { u = new URL(href, location.href); } catch (e) { return null; }
    if (u.origin !== location.origin) return null;
    var tail = u.search + u.hash;
    if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/account.html') return base + (u.pathname === '/account.html' ? '' : u.hash);
    if (u.pathname === '/order-status.html') return base + '/order' + tail;
    if (u.pathname === '/services.html') return base + '/services' + tail;
    return null;
  }
  function fixLinks(scope) {
    Array.prototype.forEach.call((scope || document).querySelectorAll('a[href]'), function (a) {
      var to = inShop(a.getAttribute('href'));
      if (to) a.setAttribute('href', to);
    });
  }
  // Links added later (an order card, a message) are caught when they are clicked.
  document.addEventListener('click', function (e) {
    if (!slug) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank') return;
    var to = inShop(a.getAttribute('href'));
    if (to) { e.preventDefault(); location.href = to; }
  }, true);

  // On the checker/AFA page and the order page: the shop's name in the header and footer (services.js points help at
  // the shop's WhatsApp).
  function brand(d) {
    var homeUrl = '/s/' + encodeURIComponent(d.slug);
    var b = document.querySelector('.site-header .brand');
    if (b) {
      b.href = homeUrl;
      b.setAttribute('aria-label', d.name);
      b.classList.add('shop-brand');
      b.innerHTML = '<span class="shop-brand-av" style="background:' + (COLOURS[d.theme] || COLOURS.gold) + '">' + window.abrantsShopAvatar(d) + '</span>' +
        '<span><strong>' + esc(d.name) + '</strong></span>';
    }
    var foot = document.querySelector('.site-footer');
    if (foot) foot.innerHTML = '<div class="wrap footer-bottom"><span>' + esc(d.name) + '</span><span>Payments by Paystack</span></div>';
    fixLinks();
    document.title = document.title.replace(/\s*[—–-]\s*Abrants Data Store\s*$/, '') + ' · ' + d.name;
  }

  // The shop page has its details written in by the server; other pages ask for them.
  var inline = document.getElementById('shopData');
  var ready;
  if (inline) {
    var d = null;
    try { d = JSON.parse(inline.textContent); } catch (e) { d = null; }
    if (!d || !d.open) forget();
    ready = Promise.resolve(d);
  } else {
    fixLinks(); // straight away; the header follows once the shop's details arrive
    ready = fetch('/api/shop/' + encodeURIComponent(slug), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.open) { forget(); return null; }
        brand(d);
        return d;
      })
      .catch(function () { return null; });
  }
  window.abrantsShopInfo = ready;
})();
