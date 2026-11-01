/* Remembers which link a visitor came from (?from=kwame) for 30 days and hands it to checkout.
   It only stores a short word in this browser. Nothing is sent anywhere until the person buys. */
(function () {
  'use strict';
  var KEY = 'abrants_from';
  var DAYS = 30;

  function clean(v) {
    v = String(v == null ? '' : v).trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v) ? v : '';
  }

  try {
    var tag = clean(new URLSearchParams(window.location.search).get('from'));
    // A newer link replaces an older one: the last link someone used gets the credit.
    if (tag) window.localStorage.setItem(KEY, JSON.stringify({ c: tag, t: Date.now() }));
  } catch (e) { /* private mode or blocked storage: the sale simply is not tracked */ }

  window.abrantsFrom = function () {
    try {
      var saved = JSON.parse(window.localStorage.getItem(KEY) || 'null');
      if (saved && clean(saved.c) && Date.now() - Number(saved.t) < DAYS * 864e5) return saved.c;
    } catch (e) { /* ignore */ }
    return '';
  };
})();
