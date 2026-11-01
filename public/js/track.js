/* Remembers which link a visitor came from for 30 days and hands it to checkout.
   A short link (abrantsdata.com/k7m2x) leaves a short-lived "abrants_from" cookie before sending the visitor to the
   home page; an old link (/?from=kwame) carries the word in the address. Either way only a short word is stored in
   this browser. Nothing is sent anywhere until the person buys. */
(function () {
  'use strict';
  var KEY = 'abrants_from';
  var DAYS = 30;

  function clean(v) {
    v = String(v == null ? '' : v).trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v) ? v : '';
  }

  function takeCookie() {
    var m = /(?:^|;\s*)abrants_from=([^;]*)/.exec(document.cookie || '');
    if (!m) return '';
    document.cookie = 'abrants_from=; Max-Age=0; path=/; SameSite=Lax';
    return clean(decodeURIComponent(m[1]));
  }

  try {
    var params = new URLSearchParams(window.location.search);
    var tag = clean(params.get('from')) || takeCookie();
    // A newer link replaces an older one: the last link someone used gets the credit.
    if (tag) window.localStorage.setItem(KEY, JSON.stringify({ c: tag, t: Date.now() }));
    // Old-style links: tidy the address so it reads like a normal link.
    if (params.has('from') && window.history && window.history.replaceState) {
      params.delete('from');
      var q = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (q ? '?' + q : '') + window.location.hash);
    }
  } catch (e) { /* private mode or blocked storage: the sale simply is not tracked */ }

  window.abrantsFrom = function () {
    try {
      var saved = JSON.parse(window.localStorage.getItem(KEY) || 'null');
      if (saved && clean(saved.c) && Date.now() - Number(saved.t) < DAYS * 864e5) return saved.c;
    } catch (e) { /* ignore */ }
    return '';
  };
})();
