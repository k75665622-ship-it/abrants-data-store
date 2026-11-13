/* Abrants Data Store — agent page: join (with the SMS code and the terms), log in, and the helpers the dashboard
   (js/agent-dash.js) uses. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var money = function (v) { var n = Number(v || 0); return (n < 0 ? '−GH₵' : 'GH₵') + Math.abs(n).toFixed(2); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var NET = { MTN: 'MTN MoMo', Telecel: 'Telecel Cash', AirtelTigo: 'AirtelTigo Money' };
  var st = { data: null };

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }
  function api(url, method, body) {
    return fetch(url, { method: method || 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var e = new Error(d.error || 'Something went wrong. Please try again.'); e.status = r.status; e.field = d.field; e.key = d.key; throw e; }
          return d;
        });
      });
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + esc(label); }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
  function formError(form, err) {
    var box = form.querySelector('.ck-error') || $(form.id.replace('Form', 'Error'));
    if (box) { box.textContent = err ? err.message : ''; box.hidden = !err; }
    if (err && err.field && form.elements[err.field] && form.elements[err.field].focus) form.elements[err.field].focus();
  }
  function date(v) {
    try { return new Date(v).toLocaleString('en-GH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function slugPreview(name) {
    var s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
    return s.length >= 3 ? location.host + '/s/' + s : '';
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy')); } catch (e) { reject(e); } finally { ta.remove(); }
    });
  }

  /* ------------------------------------------------------------ views */
  function show(view) {
    ['loadingView', 'authView', 'dashView', 'goneView'].forEach(function (v) { $(v).hidden = v !== view; });
    document.body.classList.toggle('ag-dash', view === 'dashView');
  }

  function setAuthTab(which) {
    $('tabJoin').classList.toggle('active', which === 'join'); $('tabJoin').setAttribute('aria-selected', which === 'join');
    $('tabLogin').classList.toggle('active', which === 'login'); $('tabLogin').setAttribute('aria-selected', which === 'login');
    $('joinForm').hidden = which !== 'join' || st.closed;
    $('joinClosed').hidden = which !== 'join' || !st.closed;
    $('loginForm').hidden = which !== 'login';
  }

  /* ------------------------------------------------------------ load */
  // Someone with a shop sees "My shop" on the store's home page (js/myshop.js).
  function remember(on) { try { if (on) localStorage.setItem('abrants_agent', '1'); else localStorage.removeItem('abrants_agent'); } catch (e) { /* private mode */ } }
  function load() {
    return api('/api/agent/me').then(function (d) { remember(true); window.AgDash.render(d); show('dashView'); })
      .catch(function (err) {
        if (err.status === 401) remember(false);
        else toast(err.message, 'error');
        return api('/api/agent/programme').then(function (p) {
          st.closed = !p.open;
          setAuthTab(st.closed || location.hash === '#login' ? 'login' : 'join');
          show('authView');
        }).catch(function () { setAuthTab('login'); show('authView'); });
      });
  }

  /* ------------------------------------------------------------ events */
  $('tabJoin').addEventListener('click', function () { setAuthTab('join'); });
  $('tabLogin').addEventListener('click', function () { setAuthTab('login'); });
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-pw]');
    if (t) { var inp = t.parentNode.querySelector('input'); var vis = inp.type === 'password'; inp.type = vis ? 'text' : 'password'; t.textContent = vis ? 'Hide' : 'Show'; return; }
  });
  $('joinForm').shopName.addEventListener('input', function () { $('linkPreview').textContent = slugPreview(this.value); });
  $('joinForm').phone.addEventListener('input', function () { $('joinForm').momoNumber.placeholder = this.value || 'Same as phone'; });

  /* Sign-up: the details, then (when SMS is set up) a 6-digit code sent to the phone. */
  function joinBody(f) {
    return { name: f.name.value, shopName: f.shopName.value, phone: f.phone.value, password: f.password.value,
      momoNumber: f.momoNumber.value || f.phone.value, momoNetwork: f.momoNetwork.value, momoName: f.momoName.value, agree: f.agree.checked };
  }
  function codeMode(on, sentTo) {
    var f = $('joinForm');
    f.classList.toggle('coding', on);
    $('codeStep').hidden = !on;
    if (on) {
      $('codeLabel').textContent = 'Enter the code we sent to ' + sentTo;
      f.code.value = '';
      f.code.focus();
    } else { st.codeToken = null; }
  }
  function createShop(f, body) {
    busy($('joinBtn'), true, 'Creating your shop…');
    return api('/api/agent/register', 'POST', body).then(function () { return load(); });
  }
  function joinFailed(f, err) {
    // A problem with a detail typed earlier: show the details again so it can be fixed.
    if (err.field && err.field !== 'code' && f.classList.contains('coding')) codeMode(false);
    if (err.field === 'agree') { openTerms(); return; }
    formError(f, err);
  }
  $('joinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target; formError(f, null);
    var body = joinBody(f);
    if (st.codeToken) {
      if (!/^\d{6}$/.test(f.code.value.trim())) { formError(f, { message: 'Enter the 6-digit code from the SMS.', field: 'code' }); return; }
      body.code = f.code.value.trim(); body.codeToken = st.codeToken;
      createShop(f, body).catch(function (err) { joinFailed(f, err); }).then(function () { busy($('joinBtn'), false); });
      return;
    }
    if (!body.agree) { openTerms(); return; }
    busy($('joinBtn'), true, 'Checking your details…');
    api('/api/agent/register/code', 'POST', body).then(function (d) {
      if (!d.codeNeeded) return createShop(f, body);
      st.codeToken = d.codeToken;
      codeMode(true, d.sentTo);
    }).catch(function (err) { joinFailed(f, err); }).then(function () { busy($('joinBtn'), false); });
  });
  $('joinForm').code.addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 6);
    if (this.value.length === 6 && !$('joinBtn').disabled) $('joinForm').requestSubmit ? $('joinForm').requestSubmit($('joinBtn')) : $('joinBtn').click();
  });
  $('resendCode').addEventListener('click', function () {
    var f = $('joinForm'), btn = this; formError(f, null);
    btn.disabled = true;
    api('/api/agent/register/code', 'POST', joinBody(f)).then(function (d) {
      if (!d.codeNeeded) { codeMode(false); return; }
      st.codeToken = d.codeToken;
      codeMode(true, d.sentTo);
      toast('New code sent.', 'success');
    }).catch(function (err) { joinFailed(f, err); }).then(function () { btn.disabled = false; });
  });
  $('editDetails').addEventListener('click', function () { formError($('joinForm'), null); codeMode(false); $('joinForm').name.focus(); });

  /* Agent terms: a pop-up that has to be read to the end before "I agree" works. */
  var terms = { loaded: false, read: false, update: false, back: null };
  function termsAtEnd() {
    var b = $('termsBody');
    return b.scrollHeight - b.scrollTop - b.clientHeight < 24;
  }
  function termsCheck() {
    if (!terms.loaded || !termsAtEnd()) return;
    terms.read = true;
    $('termsAgree').disabled = false;
    $('termsAgree').textContent = 'I agree';
  }
  function loadTerms() {
    if (terms.loaded) return;
    $('termsBody').innerHTML = '<div class="skeleton" style="min-height:240px"></div>';
    fetch('/agent-terms.html', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(); return r.text(); }).then(function (html) {
      var art = new DOMParser().parseFromString(html, 'text/html').getElementById('terms');
      if (!art) throw new Error();
      $('termsBody').innerHTML = '';
      $('termsBody').appendChild(document.importNode(art, true));
      terms.loaded = true;
      $('termsBody').scrollTop = 0;
      termsCheck();
    }).catch(function () {
      $('termsBody').innerHTML = '<p class="ck-error">Could not load the terms. <button type="button" class="ag-linkbtn" id="termsRetry">Try again</button></p>';
      $('termsRetry').addEventListener('click', loadTerms);
    });
  }
  function openTerms() {
    terms.back = document.activeElement;
    $('termsModal').hidden = false;
    document.body.style.overflow = 'hidden';
    if (!terms.read) { $('termsAgree').disabled = true; $('termsAgree').textContent = 'Scroll to the end'; $('termsBody').scrollTop = 0; }
    loadTerms();
    $('termsBody').focus();
    termsCheck();
  }
  function closeTerms() {
    terms.update = false;
    $('termsModal').hidden = true;
    document.body.style.overflow = '';
    if (terms.back && terms.back.focus) terms.back.focus();
  }
  $('termsBody').addEventListener('scroll', termsCheck, { passive: true });
  window.addEventListener('resize', function () { if (!$('termsModal').hidden) termsCheck(); });
  $('openTerms').addEventListener('click', function (e) { e.preventDefault(); openTerms(); });
  $('agreeBox').addEventListener('click', function (e) {
    if (this.checked && !terms.read) { e.preventDefault(); openTerms(); }
  });
  $('termsAgree').addEventListener('click', function () {
    if (!terms.read) return;
    if (terms.update) {
      var btn = this; btn.disabled = true;
      api('/api/agent/terms', 'POST').then(function () { terms.update = false; $('termsNotice').hidden = true; closeTerms(); toast('Thank you.', 'success'); })
        .catch(function (err) { toast(err.message, 'error'); }).then(function () { btn.disabled = false; });
      return;
    }
    $('agreeBox').checked = true;
    terms.back = $('joinBtn');
    closeTerms();
  });
  $('termsClose').addEventListener('click', closeTerms);
  // Terms changed since this agent signed up: read them, then "I agree" records it.
  $('readNewTerms').addEventListener('click', function () { terms.read = false; terms.update = true; openTerms(); });
  $('termsModal').addEventListener('click', function (e) { if (e.target === this) closeTerms(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('termsModal').hidden) closeTerms(); });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target; formError(f, null);
    busy($('loginBtn'), true, 'Logging in…');
    api('/api/agent/login', 'POST', { phone: f.phone.value, password: f.password.value }).then(function () { f.password.value = ''; return load(); })
      .catch(function (err) { formError(f, err); }).then(function () { busy($('loginBtn'), false); });
  });

  window.Ag = { $: $, money: money, esc: esc, toast: toast, api: api, busy: busy, formError: formError, date: date, copy: copy,
    show: show, load: load, remember: remember, openTerms: openTerms, st: st, NET: NET, DAYS: DAYS };
  $('year').textContent = new Date().getFullYear();
})();
