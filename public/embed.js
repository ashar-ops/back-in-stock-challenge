'use strict';

(() => {
  // Reading window.top's identity is safe even in a cross-origin iframe.
  if (window.self !== window.top) document.body.classList.add('is-embedded');
  const form = document.getElementById('notification-form');
  const email = document.getElementById('email');
  const sku = document.getElementById('sku');
  const submit = document.getElementById('notify-submit');
  const label = document.getElementById('notify-label');
  const spinner = submit.querySelector('.loading-ring');
  const reset = document.getElementById('form-reset');
  const feedback = document.getElementById('form-feedback');
  const feedbackTitle = document.getElementById('feedback-title');
  const feedbackMessage = document.getElementById('feedback-message');
  let pending = false;
  sku.value = new URLSearchParams(window.location.search).get('sku') || '';

  function showFeedback(kind, title, message) {
    feedback.className = `feedback feedback-${kind}`;
    feedbackTitle.textContent = title;
    feedbackMessage.textContent = message;
    feedback.hidden = false;
  }

  function setPending(value) {
    pending = value;
    submit.disabled = value;
    reset.disabled = value;
    email.readOnly = value;
    sku.readOnly = value;
    spinner.hidden = !value;
    label.textContent = value ? 'Saving your request…' : 'Notify me when it’s back';
    form.setAttribute('aria-busy', String(value));
  }

  [email, sku].forEach(input => input.addEventListener('input', () => {
    input.setCustomValidity('');
    if (!pending) {
      feedback.hidden = true;
      reset.textContent = 'Clear email';
    }
  }));

  form.addEventListener('reset', event => {
    event.preventDefault();
    if (pending) return;
    // Reset only the email. The current SKU, including a manual edit, stays put.
    email.value = '';
    email.setCustomValidity('');
    sku.setCustomValidity('');
    feedback.hidden = true;
    reset.textContent = 'Clear email';
    email.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    email.value = email.value.trim();
    sku.value = sku.value.trim();
    if (!sku.value) sku.setCustomValidity('Enter the product SKU you want an alert for.');
    else if (sku.value.length > sku.maxLength) sku.setCustomValidity(`Use a SKU with no more than ${sku.maxLength} characters.`);
    if (!form.reportValidity()) return;

    setPending(true);
    showFeedback('pending', 'Making a little room for your favorite.', 'Saving your stock alert request. Please keep this page open.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: email.value, sku: sku.value }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        showFeedback('error', 'We couldn’t save that request.', typeof data?.error === 'string' ? data.error : 'Please check your email and product SKU, then try again.');
        return;
      }
      if (!data || typeof data.duplicate !== 'boolean') {
        showFeedback('error', 'We couldn’t confirm your request.', 'Try again with the same email and SKU. If your request was saved, it won’t create a second open request.');
        return;
      }
      if (data.duplicate) {
        showFeedback('duplicate', 'You’re already on the list for this one.', typeof data.message === 'string' ? data.message : 'An open request already exists for this email and SKU. There’s no need to sign up again.');
      } else {
        showFeedback('success', 'Your request is in. Carry on with your day.', typeof data.message === 'string' ? data.message : 'We’ll aim to send one email when this product’s stock is confirmed. Your alert doesn’t reserve an item.');
      }
      reset.textContent = 'Use another email';
    } catch {
      showFeedback('error', 'The connection took a little detour.', 'We couldn’t confirm your request. Please try again with the same email and SKU; an existing open request won’t be duplicated.');
    } finally {
      clearTimeout(timeout);
      setPending(false);
    }
  });
})();
