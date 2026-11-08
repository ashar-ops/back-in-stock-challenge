'use strict';

(() => {
  const form = document.getElementById('login-form');
  const password = document.getElementById('password');
  const toggle = document.getElementById('toggle-password');
  const submit = document.getElementById('login-submit');
  const label = document.getElementById('login-submit-label');
  const feedback = document.getElementById('login-feedback');
  let pending = false;

  if (new URLSearchParams(window.location.search).get('expired') === '1') {
    feedback.textContent = 'Your session has ended. Sign in again to return to your workspace.';
    feedback.hidden = false;
  }

  toggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(show));
  });

  password.addEventListener('input', () => { feedback.hidden = true; });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    pending = true;
    submit.disabled = true;
    password.readOnly = true;
    label.textContent = 'Signing you in…';
    feedback.hidden = true;
    form.setAttribute('aria-busy', 'true');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let navigating = false;
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: password.value }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) {
        feedback.textContent = typeof data?.error === 'string' ? data.error : 'We couldn’t sign you in. Check your admin password and try again.';
        feedback.hidden = false;
        password.focus();
        password.select();
        return;
      }
      navigating = true;
      password.value = '';
      window.location.assign('/admin');
    } catch {
      feedback.textContent = 'We couldn’t reach the store. Check your connection and try signing in again.';
      feedback.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (!navigating) {
        pending = false;
        submit.disabled = false;
        password.readOnly = false;
        label.textContent = 'Sign in to dashboard';
        form.setAttribute('aria-busy', 'false');
      }
    }
  });
})();
