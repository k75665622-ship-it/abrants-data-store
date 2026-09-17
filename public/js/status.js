/* Abrants Data Store — order tracking page */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(window.location.search);
  var reference = params.get('reference') || params.get('trxref') || params.get('txref');

  var form = $('historyForm');
  var phoneInput = $('historyPhone');
  var referenceInput = $('historyReference');
  var errorEl = $('lookupError');
  var statusCard = $('currentStatus');
  var titleEl = $('statusTitle');
  var bodyEl = $('statusBody');
  var historyCard = $('historyCard');
  var historyList = $('historyList');
  var historyCount = $('historyCount');
  var stepper = $('stepper');
  var statusRef = $('statusRef');
  var statusRefValue = $('statusRefValue');
  var lookupBtn = $('lookupBtn');
  var pollTimer = null;

  var MESSAGES = {
    pending: ['Confirming your payment…', 'Your payment is being verified. This usually takes a few seconds.'],
    paid: ['Payment confirmed — placing your order…', 'We are sending your bundle to the provider right now.'],
    processing: ['Sending your data…', 'The provider has accepted your order. This page updates automatically.'],
    fulfilled: ['Data delivered 🎉', 'Your bundle has been sent to your phone. Enjoy!'],
    delivery_failed: ['Payment received, delivery failed', 'Your payment went through but the provider reported a delivery failure. A refund is being arranged where possible. Keep your reference for support.'],
    delivery_review: ['We are double-checking your delivery', 'The provider result was not confirmed, so we are verifying it manually before acting. Please do not pay again.'],
    refunding: ['Refund in progress', 'Your refund has been started with Paystack. It can take a little while to reflect.'],
    refunded: ['Refund completed', 'Your payment has been refunded. Please allow your bank or wallet some time to show it.'],
    not_found: ['Order not found', 'Double-check the reference and phone number, then try again.']
  };

  var STEP_ORDER = ['paid', 'processing', 'fulfilled'];

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function date(value) {
    try {
      return new Date(value).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) { return String(value || ''); }
  }

  function money(value) {
    return 'GH₵' + Number(value || 0).toFixed(2);
  }

  function toast(message, kind) {
    var stack = $('toastStack');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div>' + esc(message) + '</div>';
    stack.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function renderStepper(status) {
    var index = STEP_ORDER.indexOf(status);
    var failed = ['delivery_failed', 'refunded', 'refunding', 'delivery_review'].indexOf(status) !== -1;
    stepper.hidden = !(index !== -1 || failed);
    Array.prototype.forEach.call(stepper.querySelectorAll('.step'), function (step, i) {
      step.classList.remove('done', 'active');
      if (failed) return;
      if (index === -1) { if (i === 0) step.classList.add('active'); return; }
      if (i < index) step.classList.add('done');
      else if (i === index) step.classList.add(i === STEP_ORDER.length - 1 ? 'done' : 'active');
    });
  }

  function renderStatus(status, ref) {
    var msg = MESSAGES[status] || MESSAGES.pending;
    statusCard.hidden = false;
    titleEl.textContent = msg[0];
    bodyEl.textContent = msg[1];
    if (ref) {
      statusRef.hidden = false;
      statusRefValue.textContent = ref;
    }
    renderStepper(status);
  }

  function poll() {
    if (!reference) return;
    fetch('/api/order/' + encodeURIComponent(reference))
      .then(function (res) {
        if (!res.ok) { renderStatus('not_found', reference); return null; }
        return res.json();
      })
      .then(function (order) {
        if (!order) return;
        renderStatus(order.status, reference);
        if (['pending', 'paid', 'processing'].indexOf(order.status) !== -1) {
          clearTimeout(pollTimer);
          pollTimer = setTimeout(poll, 3000);
        }
      })
      .catch(function () {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, 4000);
      });
  }

  function renderHistory(rows) {
    historyCard.hidden = false;
    historyCount.textContent = rows.length + (rows.length === 1 ? ' order' : ' orders');
    if (!rows.length) {
      historyList.innerHTML = '<div class="empty-state"><strong>No order found</strong>Check the reference and phone number and try again.</div>';
      return;
    }
    historyList.innerHTML = rows.map(function (o) {
      return '<div class="history-order"><div>' +
        '<strong>' + esc(o.label) + ' · ' + esc(o.network) + '</strong>' +
        '<div class="history-meta">' + esc(o.reference) + '<br>' + date(o.createdAt) + '</div>' +
        '<span class="status-pill ' + esc(o.status) + '">' + esc(String(o.status).replace(/_/g, ' ')) + '</span>' +
        '</div><div class="history-price">' + money(o.priceGHS) + '</div></div>';
    }).join('');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    errorEl.textContent = '';

    var phone = phoneInput.value.replace(/\D/g, '');
    var ref = (referenceInput.value || '').trim().toUpperCase();

    if (!/^0\d{9}$/.test(phone)) {
      errorEl.textContent = 'Enter a valid 10-digit Ghana phone number, e.g. 0551234567.';
      phoneInput.focus();
      return;
    }
    if (ref && !/^DB-[A-Za-z0-9-]+$/.test(ref)) {
      errorEl.textContent = 'Enter a valid order reference, e.g. DB-1234567890-ab12cd.';
      referenceInput.focus();
      return;
    }

    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Checking…';

    var historyUrl = '/api/history?phone=' + encodeURIComponent(phone);
    if (ref) historyUrl += '&reference=' + encodeURIComponent(ref);
    fetch(historyUrl)
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || 'Could not check that order.');
        renderHistory(result.data);
        if (!result.data.length) toast('No order matched those details.', 'error');
      })
      .catch(function (err) {
        errorEl.textContent = err.message;
        historyCard.hidden = true;
      })
      .finally(function () {
        lookupBtn.disabled = false;
        lookupBtn.textContent = 'Check my order';
      });
  });

  phoneInput.addEventListener('input', function () {
    phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, 10);
  });

  $('copyRef').addEventListener('click', function () {
    var text = statusRefValue.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Reference copied.', 'success'); });
    } else {
      toast(text, 'success');
    }
  });

  $('year').textContent = String(new Date().getFullYear());

  if (reference) {
    referenceInput.value = reference;
    poll();
    try {
      var savedPhone = localStorage.getItem('abrants_phone');
      if (savedPhone) phoneInput.value = savedPhone;
    } catch (e) { /* private mode */ }
  }
})();
