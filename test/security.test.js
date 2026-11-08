import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { fixture, SKU, EMAIL, PASSWORD, basic, childServer, eventually, remains } from './support.js';

test('configuration requires all six secrets/endpoints and never defaults to real Resend', async (t) => {
  const h = await fixture(t, { start: false });
  for (const name of ['STOCK_API_URL', 'STOCK_API_KEY', 'RESEND_API_KEY', 'RESEND_BASE_URL', 'WEBHOOK_SECRET', 'ADMIN_PASSWORD']) {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => loadConfig({ ...h.env, [name]: value }), new RegExp(`Missing required environment variable: ${name}`));
    }
  }
  assert.equal(loadConfig(h.env).resendUrl, h.mock.base);
  assert.equal(loadConfig(h.env).port, 0);
  assert.equal(loadConfig(h.env).host, '127.0.0.1');
  assert.equal(loadConfig(h.env).idempotencyWindowMs, 23 * 60 * 60 * 1000);
  assert.equal(h.mock.emailCalls.length, 0);
  for (const [name, value] of [
    ['PORT', '-1'], ['PORT', '65536'], ['PORT', 'abc'], ['PORT', '1.5'],
    ['NETWORK_TIMEOUT_MS', '49'], ['WORKER_LEASE_MS', '499'], ['WORKER_LEASE_MS', '500'],
    ['STOCK_API_URL', 'file:///private'], ['STOCK_API_URL', 'https://user:pass@example.com/stock'],
    ['RESEND_BASE_URL', '/relative'], ['RESEND_BASE_URL', 'https://example.com?key=secret'],
    ['RESEND_BASE_URL', 'https://example.com#fragment'], ['PUBLIC_URL', 'http://127.0.0.1/path'],
    ['FROM_EMAIL', 'Sender\r\nBcc: stolen@example.com'],
  ]) {
    const env = { ...h.env, [name]: value };
    if (name === 'WORKER_LEASE_MS' && value === '500') env.NETWORK_TIMEOUT_MS = '200';
    assert.throws(() => loadConfig(env), undefined, `${name}=${value} must be rejected`);
  }
});

test('CLI startup rejects every missing required environment variable before serving or contacting an upstream', async (t) => {
  const h = await fixture(t, { start: false });
  for (const name of ['STOCK_API_URL', 'STOCK_API_KEY', 'RESEND_API_KEY', 'RESEND_BASE_URL', 'WEBHOOK_SECRET', 'ADMIN_PASSWORD']) {
    const child = childServer(t, { ...h.env, [name]: '' });
    try {
      await eventually(() => child.child.exitCode !== null, `CLI should exit for missing ${name}`);
      const exit = await child.exited;
      assert.equal(exit.code, 1);
      assert.match(child.stderr, new RegExp(`Startup failed: Missing required environment variable: ${name}`));
      assert.doesNotMatch(child.stdout, /listening on port/);
    } finally { await child.kill(); }
  }
  assert.equal(h.mock.stockCalls.length, 0);
  assert.equal(h.mock.emailCalls.length, 0);
});

test('admin pages, preview and APIs require authentication; Basic accepts colon-containing passwords', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  const sub = await h.subscribe();
  await h.webhook('private_event');
  for (const route of ['/api/admin/requests', '/api/admin/events']) {
    for (const authorization of [undefined, basic('wrong'), 'Basic invalid-base64', 'Bearer nonsense']) {
      const response = await h.api(route, { headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(response.status, 401, route);
      assert.doesNotMatch(response.text, /customer@example\.com|private_event/);
    }
  }
  for (const route of ['/admin', '/admin/email-preview']) {
    const response = await h.api(route);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin/login');
    assert.doesNotMatch(response.text, /customer@example\.com/);
  }
  for (const route of ['/api/admin/logout', '/api/admin/retry']) {
    assert.equal((await h.api(route, { method: 'POST', body: { id: sub.data.id } })).status, 401);
  }
  for (const username of ['reviewer', '', 'arbitrary-user']) {
    const response = await h.api('/api/admin/requests', { headers: { Authorization: basic(PASSWORD, username) } });
    assert.equal(response.status, 200);
    assert.equal(response.data.requests[0].email, EMAIL);
  }
  const preview = await h.admin('/admin/email-preview');
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /text\/html/);
  assert.match(preview.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(preview.headers.get('content-security-policy'), /sandbox/);
  for (const route of ['/.env', '/data/restock.sqlite', '/src/config.js', '/assets/config.js', '/assets/../../.env']) {
    const response = await h.api(route);
    assert.equal(response.status, 404, `${route} must not expose private files`);
    assert.doesNotMatch(response.text, /local-resend-key|local-stock-key|customer@example\.com/);
  }
});

test('session login, token rotation, hashed persistence, logout and CSRF origin checks protect admin actions', async (t) => {
  const h = await fixture(t);
  assert.equal((await h.api('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  for (const raw of ['null', '[]', '{', '"password"']) {
    assert.equal((await h.api('/api/admin/login', { method: 'POST', raw })).status, 400);
  }
  for (const headers of [{ Origin: 'http://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'not a URL' }]) {
    assert.equal((await h.api('/api/admin/login', { method: 'POST', body: { password: PASSWORD }, headers })).status, 403);
  }
  const login = await h.api('/api/admin/login', { method: 'POST', body: { password: PASSWORD }, headers: { Origin: h.base, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  const cookie = setCookie.split(';')[0];
  const token = cookie.split('=')[1];
  assert.match(token, /^[a-f0-9]{64}$/);
  const stored = h.app.store.db.prepare('SELECT * FROM admin_sessions').get();
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.ok(stored.expires_at > Date.now());
  assert.equal((await h.api('/api/admin/requests', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await h.api('/api/admin/requests', { headers: { Cookie: `restock_session=${'f'.repeat(64)}` } })).status, 401);
  const rotated = await h.api('/api/admin/login', { method: 'POST', body: { password: PASSWORD }, headers: { Cookie: cookie, Origin: h.base } });
  assert.equal(rotated.status, 200);
  const newCookie = rotated.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie, newCookie);
  assert.equal((await h.api('/api/admin/requests', { headers: { Cookie: cookie } })).status, 401);
  for (const headers of [{ Origin: 'http://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await h.api('/api/admin/logout', { method: 'POST', body: {}, headers: { Cookie: newCookie, ...headers } })).status, 403);
    assert.equal((await h.api('/api/admin/requests', { headers: { Cookie: newCookie } })).status, 200);
  }
  assert.equal((await h.api('/api/admin/logout', { method: 'POST', raw: 'null', headers: { Cookie: newCookie } })).status, 400);
  const logout = await h.api('/api/admin/logout', { method: 'POST', body: {}, headers: { Cookie: newCookie, Origin: h.base } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await h.api('/api/admin/requests', { headers: { Cookie: newCookie } })).status, 401);
  assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n, 0);
});

test('sessions survive restart, expire, and HTTPS PUBLIC_URL sets Secure cookies and rejects wrong origins', async (t) => {
  const h = await fixture(t, { env: { PUBLIC_URL: 'https://restock.example.invalid' } });
  assert.equal((await h.api('/api/admin/login', { method: 'POST', body: { password: PASSWORD }, headers: { Origin: h.base } })).status, 403);
  const login = await h.api('/api/admin/login', { method: 'POST', body: { password: PASSWORD }, headers: { Origin: h.env.PUBLIC_URL } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  assert.match(login.headers.get('strict-transport-security'), /max-age=/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await h.restart();
  assert.equal((await h.api('/api/admin/requests', { headers: { Cookie: cookie } })).status, 200);
  h.app.store.db.prepare('UPDATE admin_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await h.api('/api/admin/requests', { headers: { Cookie: cookie } })).status, 401);
});

test('embed permits cross-origin framing while admin and API responses prohibit framing and caching', async (t) => {
  const h = await fixture(t);
  const embed = await h.api('/embed?sku=%3Cscript%3Ealert(1)%3C/script%3E');
  assert.equal(embed.status, 200);
  assert.match(embed.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal(embed.headers.get('x-frame-options'), null);
  assert.equal(embed.headers.get('x-content-type-options'), 'nosniff');
  for (const route of ['/admin', '/api/admin/requests', '/healthz']) {
    const response = await h.api(route);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'no public cross-origin admin API access');
  }
  const health = await h.api('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(health.data, { status: 'ok' });
});

for (const status of [400, 401, 403, 422]) {
  test(`permanent email HTTP ${status} is visible as attention, blocks duplicates, and only authenticated manual retry recovers`, async (t) => {
    const h = await fixture(t);
    h.mock.setStock(SKU, 8);
    h.mock.emailBehavior = () => ({ status });
    const sub = await h.subscribe();
    const attention = await h.status(sub.data.id, 'attention');
    assert.equal(attention.attempts, 1);
    assert.equal(attention.notified_at, null);
    assert.match(attention.last_error, new RegExp(`HTTP ${status}`));
    const duplicate = await h.subscribe();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.id, sub.data.id);
    await h.webhook(`permanent_${status}`);
    await remains(() => h.mock.emailCalls.length === 1, 200, 'permanent failures must not auto-resend');
    const listing = await h.admin('/api/admin/requests?status=attention');
    assert.equal(listing.data.requests[0].id, sub.data.id);
    assert.match(listing.data.requests[0].last_error, new RegExp(`HTTP ${status}`));
    assert.equal((await h.api('/api/admin/retry', { method: 'POST', body: { id: sub.data.id } })).status, 401);
    assert.equal((await h.admin('/api/admin/retry', { method: 'POST', body: { id: sub.data.id }, headers: { Origin: 'http://attacker.invalid' } })).status, 403);
    assert.equal((await h.admin('/api/admin/retry', { method: 'POST', body: { id: sub.data.id }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal(h.row(sub.data.id).status, 'attention');
    h.mock.emailBehavior = undefined;
    assert.equal((await h.admin('/api/admin/retry', { method: 'POST', body: { id: sub.data.id }, headers: { Origin: h.base } })).status, 200);
    await h.status(sub.data.id, 'notified');
    assert.equal(h.mock.emailCalls.length, 2);
    assert.equal(h.mock.emailCalls[0].raw, h.mock.emailCalls[1].raw);
    assert.equal(h.mock.emailCalls[0].key, h.mock.emailCalls[1].key);
    assert.equal(h.mock.accepted.size, 1);
    assert.equal((await h.admin('/api/admin/retry', { method: 'POST', body: { id: sub.data.id } })).status, 409);
  });
}

test('admin list filtering, pagination, timestamps, events and retry validation are safe and accurate', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  for (let i = 0; i < 23; i++) await h.subscribe(`person-${String(i).padStart(2, '0')}@example.com`, i === 0 ? 'SPECIAL-SKU' : SKU);
  await h.webhook('list_event');
  const first = await h.admin();
  assert.equal(first.status, 200);
  assert.equal(first.data.total, 23);
  assert.equal(first.data.pageSize, 20);
  assert.equal(first.data.requests.length, 20);
  assert.equal(first.data.stats.waiting, 23);
  assert.equal(first.data.stats.total, 23);
  for (const row of first.data.requests) {
    assert.ok(Number.isFinite(Date.parse(row.created_at)));
    assert.equal(row.notified_at, null);
    assert.equal(row.payload_json, undefined, 'private delivery payload is not unnecessarily exposed');
    assert.equal(row.lease_token, undefined);
  }
  const second = await h.admin('/api/admin/requests?page=2');
  assert.equal(second.data.requests.length, 3);
  assert.equal(new Set([...first.data.requests, ...second.data.requests].map((row) => row.id)).size, 23);
  const filter = await h.admin('/api/admin/requests?status=waiting&q=SPECIAL-sku');
  assert.equal(filter.data.total, 1);
  assert.equal(filter.data.requests[0].sku, 'SPECIAL-SKU');
  const emailFilter = await h.admin('/api/admin/requests?q=PERSON-00');
  assert.equal(emailFilter.data.total, 1);
  const injection = await h.admin(`/api/admin/requests?q=${encodeURIComponent("' OR 1=1; DROP TABLE requests;--")}`);
  assert.equal(injection.status, 200);
  assert.equal(injection.data.total, 0);
  assert.equal(h.rows().length, 23);
  for (const query of ['status=bogus', 'page=0', 'page=-1', 'page=1.1', 'page=abc', 'page=1000001']) {
    assert.equal((await h.admin(`/api/admin/requests?${query}`)).status, 400);
  }
  const events = await h.admin('/api/admin/events');
  assert.equal(events.data.events.length, 1);
  assert.equal(events.data.events[0].event_id, 'list_event');
  assert.ok(Number.isFinite(Date.parse(events.data.events[0].received_at)));
  for (const body of [{}, { id: 42 }, { id: null }]) assert.equal((await h.admin('/api/admin/retry', { method: 'POST', body })).status, 400);
  assert.equal((await h.admin('/api/admin/retry', { method: 'POST', body: { id: 'unknown' } })).status, 404);
  assert.equal((await h.admin('/api/admin/retry', { method: 'POST', body: { id: first.data.requests[0].id } })).status, 409);
});

test('catalogue is fetched with stock credentials, sanitizes records, and never leaks configuration', async (t) => {
  const h = await fixture(t);
  h.mock.setStock(SKU, 4);
  h.mock.setStock('../bad-sku', 2);
  h.mock.setStock('OTHER-SKU', -1, { currency: '<script>', name: 'x'.repeat(250), price: -1 });
  const result = await h.api('/api/catalog');
  assert.equal(result.status, 200);
  assert.equal(result.data.products.length, 2);
  assert.equal(result.data.products.find((p) => p.sku === SKU).in_stock, true);
  const other = result.data.products.find((p) => p.sku === 'OTHER-SKU');
  assert.equal(other.quantity, 0);
  assert.equal(other.price, null);
  assert.equal(other.currency, 'GBP');
  assert.equal(other.name.length, 200);
  assert.doesNotMatch(result.text, /local-stock-key|local-resend-key|local-webhook-secret/);
  assert.equal(h.mock.stockCalls[0].headers.authorization, 'Bearer local-stock-key');
});
