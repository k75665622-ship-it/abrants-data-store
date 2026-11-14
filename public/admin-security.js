/* Abrants Admin — Settings → Sign-in security: two-step sign-in with an authenticator app, the server settings that
   keep Admin safe, and "Sign out other devices" (services/adminAuth.js). */
(function () {
  'use strict';
  var $ = function (sel) { return document.querySelector(sel); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div>';
    $('#toastStack').appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }
  function api(url, method, body) {
    return fetch(url, { method: method || 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        if (res.status === 401) { location.reload(); throw new Error('Session expired.'); }
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok) { var e = new Error(d.error || 'Request failed.'); e.field = d.field; throw e; }
          return d;
        });
      });
  }
  function busy(btn, on, text) {
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = text; }
    else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  }
  function day(v) { try { return new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; } }
  var digits = function (v) { return String(v || '').replace(/\D/g, '').slice(0, 6); };

  var CHECKS = {
    password: ['Admin password is long', '<b>Admin password is short.</b> Make <code>ADMIN_PASSWORD</code> in Render at least 16 characters, and use it nowhere else.'],
    secret: ['Session key is strong', '<b>Session key is weak.</b> Make <code>ADMIN_SECRET</code> in Render at least 32 random characters, different from the password.'],
    proxy: ['Visitor addresses are read correctly', '<b>Every visitor looks like the same person.</b> Add <code>TRUST_PROXY</code> = <code>true</code> in Render, or one person’s wrong tries lock everyone out.'],
    https: ['Sign-in cookies are HTTPS-only', '<b>Sign-in cookies can travel without HTTPS.</b> Add <code>NODE_ENV</code> = <code>production</code> in Render.'],
  };
  var row = function (ok, html) { return '<li class="' + (ok ? 'ok' : 'bad') + '"><span class="mark" aria-hidden="true">' + (ok ? '✓' : '!') + '</span><span>' + html + '</span></li>'; };

  var info = null;

  function render() {
    var t = info.twoStep;
    var two = t.on ? row(true, 'Two-step sign-in is on' + (t.since ? ' since ' + esc(day(t.since)) : ''))
      : t.forcedOff && t.saved ? row(false, '<b>Two-step sign-in is switched off in Render</b> (<code>ADMIN_TWO_STEP</code> = <code>off</code>). Delete that setting in Render to switch it back on.')
        : row(false, '<b>Two-step sign-in is off.</b> Anyone with the password can open Admin.');
    $('#secChecks').innerHTML = two + info.checks.map(function (c) { var w = CHECKS[c.key]; return w ? row(c.ok, c.ok ? esc(w[0]) : w[1]) : ''; }).join('');

    var box = $('#secTwoStep');
    if (!t.saved) {
      box.innerHTML = '<button class="btn btn-primary btn-sm" type="button" id="secStart">Set up two-step sign-in</button>';
      $('#secStart').addEventListener('click', start);
    } else {
      box.innerHTML = '<button class="btn btn-ghost btn-sm" type="button" id="secOffOpen">Turn off two-step sign-in</button>' +
        '<form class="sec-off" id="secOffForm" hidden>' +
          '<label class="field"><span>Admin password</span><input type="password" id="secOffPw" autocomplete="current-password" /></label>' +
          (t.forcedOff ? '' : '<label class="field"><span>Code from your authenticator app</span><input type="text" id="secOffCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" /></label>') +
          '<div class="drawer-actions"><button class="btn btn-danger btn-sm" type="submit" id="secOffBtn">Turn off</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" id="secOffCancel">Cancel</button></div>' +
        '</form>';
      $('#secOffOpen').addEventListener('click', function () { $('#secOffForm').hidden = false; this.hidden = true; $('#secOffPw').focus(); });
      $('#secOffCancel').addEventListener('click', function () { $('#secOffForm').hidden = true; $('#secOffOpen').hidden = false; });
      $('#secOffForm').addEventListener('submit', turnOff);
    }
  }

  function start() {
    var btn = $('#secStart');
    busy(btn, true, 'Preparing…');
    api('/api/admin/security/two-step/start', 'POST').then(function (d) {
      $('#secTwoStep').innerHTML =
        '<div class="sec-setup">' +
          '<img class="sec-qr" src="' + esc(d.qr) + '" alt="QR code for your authenticator app" width="184" height="184" />' +
          '<ol>' +
            '<li>On your phone, install <b>Google Authenticator</b> or <b>Microsoft Authenticator</b>.</li>' +
            '<li>In the app, tap <b>+</b> and scan this QR code. If you cannot scan it, choose “Enter a setup key” and type:' +
              '<p class="sec-key" id="secKey">' + esc(d.key) + '</p>' +
              '<small class="muted">Keep a copy of this key somewhere safe. It sets up the app again on a new phone.</small></li>' +
            '<li>Type the 6-digit code the app shows:' +
              '<form class="sec-code-row" id="secConfirm" style="margin-top:8px">' +
                '<input type="text" id="secCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" aria-label="6-digit code" />' +
                '<button class="btn btn-primary btn-sm" type="submit" id="secConfirmBtn">Turn on</button>' +
                '<button class="btn btn-ghost btn-sm" type="button" id="secCancel">Cancel</button>' +
              '</form></li>' +
          '</ol>' +
        '</div>';
      $('#secCode').focus();
      $('#secCancel').addEventListener('click', render);
      $('#secConfirm').addEventListener('submit', function (e) {
        e.preventDefault();
        var b = $('#secConfirmBtn');
        busy(b, true, 'Checking…');
        api('/api/admin/security/two-step/confirm', 'POST', { code: digits($('#secCode').value) }).then(function (r) {
          info = r; render();
          toast('Two-step sign-in is on. Other devices were signed out.', 'success');
        }).catch(function (err) { toast(err.message, 'error'); $('#secCode').select(); busy(b, false); });
      });
    }).catch(function (err) { toast(err.message, 'error'); busy(btn, false); });
  }

  function turnOff(e) {
    e.preventDefault();
    var btn = $('#secOffBtn');
    busy(btn, true, 'Turning off…');
    var code = $('#secOffCode');
    api('/api/admin/security/two-step/off', 'POST', { password: $('#secOffPw').value, code: code ? digits(code.value) : '' }).then(function (r) {
      info = r; render();
      toast('Two-step sign-in is off.', 'success');
    }).catch(function (err) {
      toast(err.message, 'error');
      var f = err.field === 'code' ? code : $('#secOffPw');
      if (f) f.select();
      busy(btn, false);
    });
  }

  $('#secOthersBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, true, 'Signing out…');
    api('/api/admin/security/sign-out-others', 'POST').then(function (r) {
      info = r; render();
      toast('Every other device was signed out of Admin.', 'success');
    }).catch(function (err) { toast(err.message, 'error'); }).finally(function () { busy(btn, false); });
  });

  function load() {
    return api('/api/admin/security').then(function (d) { info = d; render(); })
      .catch(function (err) { $('#secChecks').innerHTML = '<li class="bad"><span class="mark">!</span><span>' + esc(err.message) + '</span></li>'; });
  }

  window.AbrantsSecurity = { load: load };
})();
