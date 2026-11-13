/* Agent shops. A shop link (abrantsdata.com/s/kwame-data) opens the normal store with that agent's prices.
   The shop is remembered for this browser tab only, so the checker page and the return from Paystack keep it,
   while a later visit straight to the store shows the store's own prices. Prices are always decided by the server. */
(function () {
  'use strict';
  var KEY = 'abrants_shop';
  var m = /^\/s\/([A-Za-z0-9-]{1,40})\/?$/.exec(location.pathname);
  var slug = '';
  try {
    if (m) { slug = m[1].toLowerCase(); sessionStorage.setItem(KEY, slug); }
    else slug = sessionStorage.getItem(KEY) || '';
  } catch (e) { slug = m ? m[1].toLowerCase() : ''; }

  window.abrantsShop = function () { return slug; };
  window.abrantsShopQuery = function () { return slug ? '?shop=' + encodeURIComponent(slug) : ''; };
  if (!slug) { window.abrantsShopInfo = Promise.resolve(null); return; }

  var root = document.documentElement;
  root.classList.add('in-shop'); // hides the store's own promotions straight away
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function forget() {
    slug = '';
    root.classList.remove('in-shop');
    try { sessionStorage.removeItem(KEY); } catch (e) { /* private mode */ }
  }
  function render(d) {
    var bar = document.createElement('div');
    bar.className = 'shop-bar';
    var wa = String(d.whatsapp || '').replace(/\D/g, '').replace(/^0(\d{9})$/, '233$1');
    bar.innerHTML = '<div class="wrap shop-bar-in"><span class="shop-bar-name"><i aria-hidden="true">🛍</i>' + esc(d.name) + '</span>' +
      (wa ? '<a class="shop-bar-chat" href="https://wa.me/' + wa + '" target="_blank" rel="noopener">WhatsApp</a>' : '') + '</div>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.title = d.name + ' · ' + document.title;
  }
  window.abrantsShopInfo = fetch('/api/shop/' + encodeURIComponent(slug))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.open) { forget(); return null; }
      render(d);
      return d;
    })
    .catch(function () { return null; });
})();
