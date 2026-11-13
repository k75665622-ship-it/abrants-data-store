/* Agent shops. A shop link (abrantsdata.com/s/kwame-data-hub) opens that agent's own shop page (shop.html).
   The shop is remembered for this browser tab, so the checker and AFA page and the order page after paying carry the
   shop's name and prices, and their links lead back to the shop. Opening the store's own address (abrantsdata.com)
   leaves the shop. Prices are always decided by the server. */
(function () {
  'use strict';
  var KEY = 'abrants_shop';
  var COLOURS = { gold: '#ffc72c', blue: '#1d4ed8', green: '#15803d', purple: '#6d28d9', red: '#c8102e', teal: '#0f766e', orange: '#c2410c', pink: '#be185d' };
  var m = /^\/s\/([A-Za-z0-9-]{1,40})\/?$/.exec(location.pathname);
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
  root.classList.add('in-shop'); // hides the store's own accounts and offers straight away
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

  // On the checker/AFA page and the order page: the shop's name in the header, and the way back to the shop.
  function brand(d) {
    var home = '/s/' + encodeURIComponent(d.slug);
    var b = document.querySelector('.site-header .brand');
    if (b) {
      b.href = home;
      b.setAttribute('aria-label', d.name);
      b.classList.add('shop-brand');
      b.innerHTML = '<span class="shop-brand-av" style="background:' + (COLOURS[d.theme] || COLOURS.gold) + '">' + window.abrantsShopAvatar(d) + '</span>' +
        '<span><strong>' + esc(d.name) + '</strong></span>';
    }
    Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
      var h = a.getAttribute('href');
      if (h === '/' || h === '/index.html') a.setAttribute('href', home);
      else if (/^\/(index\.html)?#/.test(h)) a.setAttribute('href', home + h.slice(h.indexOf('#')));
    });
    if (!/^\/s\//.test(location.pathname)) document.title = d.name + ' · ' + document.title;
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
