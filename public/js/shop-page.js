/* An agent's shop page (shop.html): the signboard, the agent's note, checkers and AFA, sharing, and what the shop's
   owner sees. Data bundles and the checkout are the store's own code (js/app.js). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var money = function (v) { return 'GH₵' + Number(v || 0).toFixed(2); };
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = message;
    $('toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); } finally { ta.remove(); }
    });
  }
  function initials(name) {
    return String(name || '').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || 'S';
  }

  function closed(d) {
    $('spClosed').hidden = false;
    $('spHeadName').textContent = 'Abrants Data Store';
    $('spAvatar').innerHTML = '<img src="/icon.svg" alt="" width="34" height="34" />';
    $('spId').href = '/';
    var off = d && d.programmeOff;
    var MONTHS_AT = function (iso) { var p = iso.split('-'); return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1]; };
    if (off && !(d && d.owner)) {
      $('spClosedText').textContent = (off.back === 'date' && off.backOn ? 'It opens again on ' + MONTHS_AT(off.backOn) + '.'
        : off.back === 'soon' ? 'It will be back soon.' : '') + ' Until then, you can buy data, result checkers and MTN AFA from Abrants Data Store.';
    }
    if (off && d && d.owner) {
      $('spClosedTitle').textContent = 'All shops are closed for now';
      $('spClosedText').textContent = (off.reason ? off.reason + ' ' : '') +
        (off.back === 'never' ? 'The agent programme is ending.' : off.back === 'date' && off.backOn ? 'Shops open again on ' + MONTHS_AT(off.backOn) + '.' : 'Shops will be back soon.');
      $('spClosedGo').textContent = 'Manage my shop';
      $('spClosedGo').href = '/agent.html';
    } else if (d && d.owner) {
      var waiting = d.status === 'pending';
      $('spClosedTitle').textContent = waiting ? 'Your shop opens once it is approved' : 'Your shop is closed right now';
      $('spClosedText').textContent = waiting
        ? 'Customers see this page until then. You can already set your prices and make the shop yours.'
        : 'Customers see this page until your shop is open again. Your inbox says why.';
      $('spClosedGo').textContent = 'Manage my shop';
      $('spClosedGo').href = '/agent.html';
    }
  }

  function open(d) {
    var url = location.origin + '/s/' + d.slug;
    // Everything stays in the shop: its own order page and checker/AFA page.
    $('spTrack').href = $('spTrack2').href = '/s/' + d.slug + '/order';
    $('spAfaGo').href = '/s/' + d.slug + '/services#afa';
    $('spOpen').hidden = false;
    var face = d.logo ? '<img src="' + esc(d.logo) + '" alt="" />' : '<span>' + esc(initials(d.name)) + '</span>';
    $('spAvatar').innerHTML = face;
    $('spStamp').innerHTML = face;
    $('spHeadName').textContent = d.name;
    $('spFootName').textContent = d.name;
    var name = $('spName');
    name.textContent = d.name;
    name.classList.toggle('long', d.name.length > 16);
    name.classList.toggle('longer', d.name.length > 26);
    if (d.bio) { $('spBio').textContent = d.bio; $('spBio').hidden = false; }
    if (d.announcement) { $('spNote').textContent = d.announcement; $('spNote').hidden = false; }

    var facts = [];
    if (d.delivered) facts.push('<li><b>' + d.delivered.toLocaleString('en-GH') + '</b> orders delivered</li>');
    if (d.since) { var p = d.since.split('-'); facts.push('<li>Selling since <b>' + MONTHS[Number(p[1]) - 1] + ' ' + p[0] + '</b></li>'); }
    if (facts.length) { $('spFacts').innerHTML = facts.join(''); $('spFacts').hidden = false; }

    if (d.owner) {
      // The shop's own agent: manage instead of messaging themselves.
      $('spManage').hidden = false;
      $('spHeadManage').hidden = false;
      $('spOwnerBar').hidden = false;
      document.body.classList.add('sp-is-owner');
    } else if (d.whatsapp) {
      var wa = String(d.whatsapp).replace(/\D/g, '').replace(/^0(\d{9})$/, '233$1');
      $('spWa').href = 'https://wa.me/' + wa + '?text=' + encodeURIComponent('Hello ' + d.name + ', I found your shop: ' + url);
      $('spWa').hidden = false;
    }

    $('spShare').addEventListener('click', function () {
      var text = 'Buy data, result checkers and MTN AFA from ' + d.name + '.';
      if (navigator.share) {
        navigator.share({ title: d.name, text: text, url: url }).catch(function () { /* closed */ });
        return;
      }
      copy(url).then(function () { toast('Shop link copied.', 'success'); }, function () { toast(url); });
    });

    services(d);
  }

  /* Result checkers and AFA, at this shop's prices. */
  function services(d) {
    fetch('/api/services?shop=' + encodeURIComponent(d.slug)).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (!s) return;
      var chk = s.checkers || [];
      if (chk.length) {
        $('spCheckers').innerHTML = chk.map(function (c) {
          return '<a class="sp-line" href="/s/' + encodeURIComponent(d.slug) + '/services#checkers">' +
            '<span class="sp-line-name">' + esc(c.name) + (c.popular ? ' <i class="plan-tag popular">Popular</i>' : '') + '</span>' +
            '<span class="sp-line-price">' + money(c.price) + '</span><span class="sp-buy">Buy</span></a>';
        }).join('');
        document.querySelector('[data-pane="checkers"]').hidden = false;
      }
      if (s.afa) {
        $('spAfaPrice').textContent = money(s.afa.price);
        document.querySelector('[data-pane="afa"]').hidden = false;
      }
      if (chk.length || s.afa) $('spSwitch').hidden = false;
      var want = location.hash.replace('#', '');
      if (want === 'checkers' || want === 'afa') pick(want);
    }).catch(function () { /* data still works */ });
  }

  function pick(pane) {
    var btn = document.querySelector('.sp-switch-btn[data-pane="' + pane + '"]');
    if (!btn || btn.hidden) return;
    Array.prototype.forEach.call(document.querySelectorAll('.sp-switch-btn'), function (b) {
      var on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('paneData').hidden = pane !== 'data';
    $('paneCheckers').hidden = pane !== 'checkers';
    $('paneAfa').hidden = pane !== 'afa';
  }
  $('spSwitch').addEventListener('click', function (e) {
    var b = e.target.closest('.sp-switch-btn');
    if (!b) return;
    pick(b.dataset.pane);
    try { history.replaceState(null, '', b.dataset.pane === 'data' ? location.pathname : '#' + b.dataset.pane); } catch (err) { /* old browser */ }
  });

  (window.abrantsShopInfo || Promise.resolve(null)).then(function (d) {
    var inline = null;
    try { inline = JSON.parse(($('shopData') || {}).textContent || 'null'); } catch (e) { inline = null; }
    if (d && d.open) open(d); else closed(inline);
  });
})();
