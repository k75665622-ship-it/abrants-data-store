/* "My shop" on the home page, for someone who has an agent shop (the agent page sets a note in this browser when
   they log in). The "Become an agent" card turns into their shop, and the bottom bar gets a shop button.
   One small request, answered from the server's memory (no database). */
(function () {
  'use strict';
  var flag = null;
  try { flag = localStorage.getItem('abrants_agent'); } catch (e) { return; }
  if (flag !== '1') return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var COLOURS = { gold: '#ffc72c', blue: '#1d4ed8', green: '#15803d', purple: '#6d28d9', red: '#c8102e', teal: '#0f766e', orange: '#c2410c', pink: '#be185d' };
  var STATE = { active: 'Your shop is open', pending: 'Waiting for approval', suspended: 'Your shop is paused', rejected: 'Your shop is closed' };

  fetch('/api/agent/whoami', { credentials: 'same-origin' }).then(function (r) {
    if (r.status === 401) { try { localStorage.removeItem('abrants_agent'); } catch (e) { /* private mode */ } return null; }
    return r.ok ? r.json() : null;
  }).then(function (me) {
    if (!me) return;
    var dark = me.theme === 'gold' || !COLOURS[me.theme];
    var face = me.logo ? '<img src="' + esc(me.logo) + '" alt="" />'
      : esc(String(me.shopName || '').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase());
    var waiting = (me.unread || 0) + (me.chats || 0); // messages from the store + customers' chats
    var news = waiting ? waiting + ' new message' + (waiting > 1 ? 's' : '') : '';

    var card = $('needAgent');
    if (card) {
      card.classList.add('need-myshop');
      card.innerHTML =
        '<span class="need-ico myshop-face" style="background:' + (COLOURS[me.theme] || COLOURS.gold) + ';color:' + (dark ? '#0b1020' : '#fff') + '" aria-hidden="true">' + face + '</span>' +
        '<b>' + esc(me.shopName) + '</b>' +
        '<span class="need-txt">' + esc(me.programmeOff ? 'All shops are closed for now' : (STATE[me.status] || 'My shop')) + '</span>' +
        (news ? '<span class="myshop-news">' + esc(news) + '</span>' : '') +
        '<span class="need-go">Manage my shop <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></span>';
      card.hidden = false;
    }
    var cta = $('agentCta');
    if (cta) { cta.textContent = 'My shop'; cta.hidden = false; }
    var bar = document.querySelector('.mobilebar');
    if (bar && !bar.querySelector('.bar-shop')) {
      var a = document.createElement('a');
      a.className = 'bar-icon bar-shop';
      a.href = '/agent.html';
      a.setAttribute('aria-label', 'My shop' + (news ? ', ' + news : ''));
      a.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9h18l-1.5-5h-15z"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>' +
        (news ? '<i class="bar-dot" aria-hidden="true"></i>' : '');
      var acct = bar.querySelector('.bar-icon[href="/account.html"]');
      bar.insertBefore(a, acct || null);
    }
    var pop = $('agentPop');
    if (pop) pop.hidden = true;
  }).catch(function () { /* the home page works without it */ });
})();
