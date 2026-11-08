'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const body = byId('requests-body');
  const eventsList = byId('events-list');
  const filters = byId('filters-form');
  const search = byId('request-search');
  const statusFilter = byId('status-filter');
  const clearFilters = byId('clear-filters');
  const refresh = byId('refresh');
  const refreshLabel = byId('refresh-label');
  const refreshStatus = byId('refresh-status');
  const autoRefresh = byId('auto-refresh');
  const previous = byId('previous-page');
  const next = byId('next-page');
  const feedback = byId('admin-feedback');
  const dialog = byId('retry-dialog');
  const confirmRetry = byId('confirm-retry');
  const cancelRetry = byId('cancel-retry');
  const retryFeedback = byId('retry-feedback');
  const logout = byId('logout');
  const statusLabels = { waiting: 'Waiting for stock', queued: 'Queued', retrying: 'Retrying', notified: 'Notified', attention: 'Needs attention' };
  const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const numberFormatter = new Intl.NumberFormat();
  const params = new URLSearchParams(window.location.search);
  let query = params.get('q') || '';
  let status = Object.hasOwn(statusLabels, params.get('status')) ? params.get('status') : '';
  let page = 1;
  let pageSize = 20;
  let total = 0;
  let requestsLoaded = false;
  let eventsLoaded = false;
  let busy = false;
  let expired = false;
  let generation = 0;
  let activeController;
  let searchTimer;
  let pollTimer;
  let lastUpdate;
  let retryRequest = null;
  let retryPending = false;
  let feedbackSource = '';
  search.value = query;
  statusFilter.value = status;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/assets/brand.svg#${name}`);
    svg.append(use);
    return svg;
  }

  function timestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    const normalized = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function appendDate(container, value) {
    const date = timestamp(value);
    if (!date) { container.append(element('span', 'muted', 'Not available')); return; }
    const time = element('time', '', dateFormatter.format(date));
    time.dateTime = date.toISOString();
    time.title = date.toLocaleString();
    time.append(element('span', 'cell-secondary', timeFormatter.format(date)));
    container.append(time);
  }

  function showFeedback(kind, text, source = 'action') {
    feedback.className = `feedback feedback-${kind}`;
    feedback.textContent = text;
    feedback.hidden = false;
    feedbackSource = source;
  }

  function clearPrivateData() {
    body.replaceChildren();
    eventsList.replaceChildren();
    for (const key of ['total', 'waiting', 'progress', 'notified', 'attention']) byId(`stat-${key}`).textContent = '—';
    byId('requests-total').textContent = '—';
    byId('stat-progress-detail').textContent = 'Queued and retrying';
    byId('retry-customer').textContent = '';
    byId('retry-sku').textContent = '';
    byId('retry-error-detail').textContent = '';
    retryFeedback.textContent = '';
    feedback.textContent = '';
    if (dialog.open) dialog.close();
    retryRequest = null;
  }

  function endSession() {
    if (expired) return;
    expired = true;
    clearInterval(pollTimer);
    clearTimeout(searchTimer);
    activeController?.abort();
    clearPrivateData();
    window.location.replace('/admin/login?expired=1');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
    if (response.status === 401) { endSession(); throw new Error('Your session has ended.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `The server couldn’t complete this request (${response.status}).`);
    if (!data) throw new Error('The server returned an unreadable response.');
    return data;
  }

  function renderStats(stats = {}) {
    const value = key => typeof stats?.[key] === 'number' && Number.isFinite(stats[key]) && stats[key] >= 0 ? stats[key] : null;
    for (const key of ['total', 'waiting', 'notified', 'attention']) byId(`stat-${key}`).textContent = value(key) === null ? '—' : numberFormatter.format(value(key));
    const queued = value('queued');
    const retrying = value('retrying');
    byId('stat-progress').textContent = queued === null || retrying === null ? '—' : numberFormatter.format(queued + retrying);
    byId('stat-progress-detail').textContent = queued === null || retrying === null ? 'Queued and retrying' : `${numberFormatter.format(queued)} queued · ${numberFormatter.format(retrying)} retrying`;
  }

  function emptyTable(title, description, symbol = 'box') {
    body.closest('table').classList.add('is-empty');
    const row = element('tr');
    const cell = element('td');
    cell.colSpan = 5;
    const content = element('div', 'table-empty');
    content.append(icon(symbol), element('h3', '', title), element('p', '', description));
    cell.append(content);
    row.append(cell);
    body.replaceChildren(row);
  }

  function openRetry(request) {
    if (retryPending || expired) return;
    retryRequest = request;
    byId('retry-customer').textContent = request.email || 'Customer email unavailable';
    byId('retry-sku').textContent = `SKU: ${request.sku || 'Not available'} · Request ${request.id}`;
    byId('retry-error-detail').textContent = request.last_error || 'No delivery error detail was provided. Review this request before retrying.';
    retryFeedback.hidden = true;
    confirmRetry.disabled = false;
    cancelRetry.disabled = false;
    confirmRetry.textContent = 'Confirm retry';
    dialog.showModal();
    // Put initial focus on the non-destructive choice.
    cancelRetry.focus();
  }

  function requestRow(request) {
    const row = element('tr');
    const customer = element('td');
    const customerCell = element('div', 'customer-cell');
    const address = String(request.email || 'Email unavailable');
    const avatar = element('span', 'customer-avatar', address.charAt(0).toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    const customerInfo = element('div', 'customer-info');
    customerInfo.append(element('span', 'customer-email', address), element('span', 'cell-secondary', `Request ${request.id}`));
    customerCell.append(avatar, customerInfo);
    customer.append(customerCell);
    const sku = element('td');
    sku.append(element('span', 'sku-code', request.sku || 'Not available'));
    const state = element('td');
    const knownStatus = Object.hasOwn(statusLabels, request.status);
    state.append(element('span', `status-badge${knownStatus ? ` status-${request.status}` : ''}`, knownStatus ? statusLabels[request.status] : 'Unknown status'));
    if (typeof request.attempts === 'number') state.append(element('span', 'cell-secondary', `${request.attempts} ${request.attempts === 1 ? 'attempt' : 'attempts'}`));
    const created = element('td');
    appendDate(created, request.created_at);
    const delivery = element('td');
    if (request.status === 'notified') {
      appendDate(delivery, request.notified_at);
      delivery.append(element('span', 'cell-secondary', 'Provider acknowledged'));
    } else if (request.status === 'waiting') {
      delivery.append(element('span', 'muted', 'Watching for stock'));
    } else if (request.status === 'queued') {
      delivery.append(element('span', 'muted', 'Stock check / delivery queued'));
    } else if (request.status === 'retrying') {
      delivery.append(element('span', 'muted', 'Automatic retry'));
      if (request.next_attempt_at) {
        const date = timestamp(request.next_attempt_at);
        delivery.append(element('span', 'cell-secondary', date ? `${dateFormatter.format(date)} · ${timeFormatter.format(date)}` : 'Retry time unavailable'));
      } else delivery.append(element('span', 'cell-secondary', 'Awaiting a scheduled attempt'));
    } else if (request.status === 'attention') {
      delivery.append(element('span', 'muted', 'Review delivery issue'));
    } else delivery.append(element('span', 'muted', 'Status details unavailable'));
    if (request.last_error) {
      const details = element('details', 'error-detail');
      details.append(element('summary', '', 'View delivery issue'), element('p', '', request.last_error));
      delivery.append(details);
    }
    if (request.status === 'attention') {
      const button = element('button', 'retry-request');
      button.type = 'button';
      button.setAttribute('aria-label', `Review and retry request for ${address}, SKU ${request.sku}`);
      button.append(icon('refresh'), document.createTextNode('Review & retry'));
      button.addEventListener('click', () => openRetry(request));
      delivery.append(button);
    }
    row.append(customer, sku, state, created, delivery);
    return row;
  }

  function renderRequests(data) {
    const fragment = document.createDocumentFragment();
    for (const request of data.requests) fragment.append(requestRow(request));
    if (data.requests.length) {
      body.closest('table').classList.remove('is-empty');
      body.replaceChildren(fragment);
    } else emptyTable(query || status ? 'No requests match this view.' : 'Your first connection starts here.', query || status ? 'Try a different email, SKU, or status — or clear your filters.' : 'When a customer requests a stock alert, it will appear here. Share the storefront or alert form to get started.');
    byId('requests-total').textContent = numberFormatter.format(total);
    renderStats(data.stats);
    const start = total && data.requests.length ? (page - 1) * pageSize + 1 : 0;
    const end = Math.min((page - 1) * pageSize + data.requests.length, total);
    byId('pagination-summary').textContent = total ? `Showing ${start}–${end} of ${numberFormatter.format(total)} requests` : 'No requests to display';
    byId('page-number').textContent = `Page ${page} of ${Math.max(1, Math.ceil(total / pageSize))}`;
  }

  function renderEvents(events) {
    const recent = [...events].sort((a, b) => (timestamp(b.received_at)?.getTime() || 0) - (timestamp(a.received_at)?.getTime() || 0)).slice(0, 5);
    const fragment = document.createDocumentFragment();
    for (const event of recent) {
      const item = element('li', 'event-item');
      const symbol = element('span', 'event-icon');
      symbol.append(icon('box'));
      const content = element('div', 'event-content');
      content.append(element('strong', '', event.sku || 'SKU unavailable'), element('p', '', `Reported quantity: ${event.quantity ?? 'not available'} · Event ${event.event_id}`));
      const time = element('div', 'event-time');
      appendDate(time, event.received_at);
      item.append(symbol, content, time);
      fragment.append(item);
    }
    if (!recent.length) {
      const empty = element('li', 'activity-empty');
      empty.append(element('strong', '', 'Quiet for now.'), document.createTextNode('Stock events will appear here when they arrive.'));
      fragment.append(empty);
    }
    eventsList.replaceChildren(fragment);
  }

  function updateButtons() {
    previous.disabled = busy || !requestsLoaded || page <= 1;
    next.disabled = busy || !requestsLoaded || page * pageSize >= total;
    refresh.disabled = busy || expired;
    refreshLabel.textContent = busy ? 'Refreshing…' : 'Refresh data';
    clearFilters.hidden = !search.value && !statusFilter.value;
  }

  function updateRefreshStatus() {
    if (document.hidden) { refreshStatus.textContent = 'Auto-refresh paused while away'; return; }
    refreshStatus.textContent = lastUpdate ? `Updated ${timeFormatter.format(lastUpdate)}${autoRefresh.checked ? '' : ' · auto-refresh off'}` : 'Waiting for first update';
  }

  function reviewingRequest() {
    return dialog.open || retryPending || body.contains(document.activeElement) || Boolean(body.querySelector('details[open]'));
  }

  async function loadData(mode = 'manual') {
    if (expired || dialog.open || retryPending) return;
    if (mode === 'auto' && (busy || document.hidden || reviewingRequest() || !autoRefresh.checked)) {
      if (reviewingRequest()) refreshStatus.textContent = 'Auto-refresh paused while you review';
      return;
    }
    const currentGeneration = ++generation;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    busy = true;
    updateButtons();
    body.setAttribute('aria-busy', 'true');
    eventsList.setAttribute('aria-busy', 'true');
    const requestParams = new URLSearchParams({ page: String(page) });
    if (query) requestParams.set('q', query);
    if (status) requestParams.set('status', status);
    let correctionNeeded = false;
    try {
      const [requestsResult, eventsResult] = await Promise.allSettled([
        api(`/api/admin/requests?${requestParams}`, { signal: controller.signal }),
        api('/api/admin/events', { signal: controller.signal })
      ]);
      if (expired || currentGeneration !== generation) return;
      // Focus or a detail disclosure may have changed while the network was busy.
      if (mode === 'auto' && (document.hidden || reviewingRequest())) {
        refreshStatus.textContent = document.hidden ? 'Auto-refresh paused while away' : 'Auto-refresh paused while you review';
        return;
      }
      const data = requestsResult.status === 'fulfilled' ? requestsResult.value : null;
      const valid = data && Array.isArray(data.requests) && Number.isInteger(data.total) && data.total >= 0 && data.requests.every(request => request && typeof request === 'object');
      if (valid) {
        total = data.total;
        pageSize = Number.isInteger(data.pageSize) && data.pageSize > 0 ? data.pageSize : 20;
        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        page = Number.isInteger(data.page) && data.page > 0 ? data.page : page;
        if (page > maxPage) { page = maxPage; correctionNeeded = true; }
        else {
          requestsLoaded = true;
          renderRequests(data);
          lastUpdate = new Date();
          updateRefreshStatus();
          if (feedbackSource === 'refresh') feedback.hidden = true;
        }
      } else {
        const reason = controller.signal.aborted ? 'The connection timed out.' : requestsResult.status === 'rejected' ? requestsResult.reason.message : 'The response was incomplete.';
        showFeedback('error', `Couldn’t refresh requests. ${reason} ${requestsLoaded ? 'Previously loaded data is still shown and may be out of date.' : 'Use Refresh data to try again.'}`, 'refresh');
        refreshStatus.textContent = 'Refresh failed · data may be out of date';
        if (!requestsLoaded) {
          emptyTable('Your workspace is temporarily unavailable.', 'We couldn’t load stock requests. Please use Refresh data to try again.', 'info');
          byId('pagination-summary').textContent = 'Requests unavailable';
        }
      }
      const eventData = eventsResult.status === 'fulfilled' ? eventsResult.value : null;
      if (Array.isArray(eventData?.events) && eventData.events.every(event => event && typeof event === 'object')) {
        renderEvents(eventData.events);
        eventsLoaded = true;
      } else {
        if (!eventsLoaded) eventsList.replaceChildren(element('li', 'activity-empty', 'Stock activity couldn’t be loaded. Use Refresh data to try again.'));
        else {
          const oldNotice = eventsList.querySelector('.activity-stale');
          if (!oldNotice) eventsList.prepend(element('li', 'activity-empty activity-stale', 'This activity may be out of date. The last refresh didn’t complete.'));
        }
      }
    } finally {
      clearTimeout(timeout);
      if (currentGeneration === generation && !expired) {
        busy = false;
        body.setAttribute('aria-busy', 'false');
        eventsList.setAttribute('aria-busy', 'false');
        updateButtons();
        if (correctionNeeded) loadData('filter');
      }
    }
  }

  function applyFilters() {
    clearTimeout(searchTimer);
    query = search.value.trim();
    status = statusFilter.value;
    page = 1;
    loadData('filter');
  }

  filters.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    clearFilters.hidden = !search.value && !statusFilter.value;
    searchTimer = setTimeout(applyFilters, 350);
  });
  statusFilter.addEventListener('change', applyFilters);
  clearFilters.addEventListener('click', () => { search.value = ''; statusFilter.value = ''; applyFilters(); search.focus(); });
  previous.addEventListener('click', () => { if (page > 1 && !busy) { page--; loadData('page'); } });
  next.addEventListener('click', () => { if (page * pageSize < total && !busy) { page++; loadData('page'); } });
  refresh.addEventListener('click', () => loadData('manual'));
  autoRefresh.addEventListener('change', () => { updateRefreshStatus(); if (autoRefresh.checked) loadData('auto'); });
  document.addEventListener('visibilitychange', () => { updateRefreshStatus(); if (!document.hidden) loadData('auto'); });

  cancelRetry.addEventListener('click', () => { if (!retryPending) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (retryPending) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (!retryPending) retryRequest = null; });
  confirmRetry.addEventListener('click', async () => {
    if (!retryRequest || retryPending || expired) return;
    retryPending = true;
    confirmRetry.disabled = true;
    cancelRetry.disabled = true;
    confirmRetry.textContent = 'Requesting retry…';
    retryFeedback.hidden = true;
    dialog.setAttribute('aria-busy', 'true');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let succeeded = false;
    let uncertain = false;
    try {
      const data = await api('/api/admin/retry', { method: 'POST', body: JSON.stringify({ id: retryRequest.id }), signal: controller.signal });
      if (data.ok !== true) {
        uncertain = true;
        throw new Error('The retry wasn’t confirmed.');
      }
      succeeded = true;
      dialog.close();
      showFeedback('success', 'Retry requested. The dashboard will show the next stock check or delivery attempt.');
    } catch (error) {
      if (!expired) {
        uncertain = uncertain || controller.signal.aborted || error instanceof TypeError;
        retryFeedback.textContent = uncertain ? 'We couldn’t confirm the outcome. Close this dialog and refresh the dashboard before requesting another retry.' : error.message;
        retryFeedback.hidden = false;
      }
    } finally {
      clearTimeout(timeout);
      retryPending = false;
      dialog.setAttribute('aria-busy', 'false');
      confirmRetry.disabled = uncertain || succeeded;
      cancelRetry.disabled = false;
      confirmRetry.textContent = 'Confirm retry';
      if (succeeded) { retryRequest = null; loadData('manual'); }
    }
  });

  logout.addEventListener('click', async () => {
    if (logout.disabled) return;
    logout.disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const data = await api('/api/admin/logout', { method: 'POST', body: '{}', signal: controller.signal });
      if (data.ok !== true) throw new Error('Sign out wasn’t confirmed. Please try again.');
      expired = true;
      clearInterval(pollTimer);
      clearTimeout(searchTimer);
      activeController?.abort();
      clearPrivateData();
      window.location.replace('/admin/login');
    } catch (error) {
      if (!expired) { showFeedback('error', `Couldn’t sign out. ${controller.signal.aborted ? 'Check your connection and try again.' : error.message}`); logout.disabled = false; }
    } finally { clearTimeout(timeout); }
  });

  window.addEventListener('pagehide', () => {
    expired = true;
    clearInterval(pollTimer);
    clearTimeout(searchTimer);
    activeController?.abort();
    clearPrivateData();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  updateButtons();
  loadData('initial');
  pollTimer = setInterval(() => loadData('auto'), 15000);
})();
