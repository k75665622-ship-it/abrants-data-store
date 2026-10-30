/* Get-started page: shown once to new visitors (see the redirect at the top of index.html). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var remember = function () { try { localStorage.setItem('abrants-welcomed', '1'); } catch (e) { /* private mode */ } };

  // Seeing this page once is enough: the next visit to the home page goes straight to the store.
  remember();
  document.addEventListener('click', function (e) { if (e.target.closest('[data-enter]')) remember(); });
  $('year').textContent = new Date().getFullYear();

  // Show what is really on sale right now.
  fetch('/api/services').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d) return;
    var chk = d.checkers || [];
    if (chk.length) {
      var low = Math.min.apply(null, chk.map(function (c) { return c.price; }));
      $('wlChkText').textContent = chk.map(function (c) { return c.name; }).join(', ') + ' PINs from GH₵' + low.toFixed(2) + ', on screen as soon as you pay.';
    } else {
      $('wlChkText').textContent = 'WASSCE and BECE PINs. Coming soon.';
    }
    if (d.afa) {
      $('wlAfaFee').textContent = 'Fill in your Ghana Card details and pay the GH₵' + Number(d.afa.price).toFixed(2) + ' registration fee.';
    } else {
      $('wlAfaBtn').hidden = true;
      $('wlAfaSoon').hidden = false;
    }
  }).catch(function () {});
})();
