import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createApplication } from '../src/server.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const serverFile = fileURLToPath(new URL('../src/server.js', import.meta.url));
export const SKU = 'MUG-STN-SAGE';
export const EMAIL = 'customer@example.com';
export const PASSWORD = 'local:test:admin:password';
export const basic = (password = PASSWORD, username = 'reviewer') => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

// An accidental production URL must fail locally, never send a customer email.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.protocol, 'http:', `External network blocked in tests: ${url.origin}`);
  assert.equal(url.hostname, '127.0.0.1', `External network blocked in tests: ${url.origin}`);
  return originalFetch(input, init);
};

export async function eventually(check, message = 'condition was not reached', timeout = 6000) {
  const deadline = performance.now() + timeout;
  let lastError;
  do {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(15);
  } while (performance.now() < deadline);
  assert.fail(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function remains(check, duration = 350, message = 'invariant changed') {
  const deadline = performance.now() + duration;
  do {
    assert.ok(await check(), message);
    await delay(15);
  } while (performance.now() < deadline);
}

export async function request(base, route, { method = 'GET', body, raw, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(6000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { /* Static HTML is not JSON. */ }
  return { status: response.status, headers: response.headers, text, data };
}

function send(res, reply, fallback) {
  if (reply.drop) { res.destroy(); return; }
  if (reply.hang) return; // Client timeout or explicit teardown closes this connection.
  res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
  res.end(reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body !== undefined ? reply.body : fallback));
}

async function mockServer() {
  const mock = {
    products: new Map(), stockCalls: [], emailCalls: [], accepted: new Map(), errors: [],
    stockBehavior: undefined, emailBehavior: undefined,
    setStock(sku = SKU, quantity = 0, extra = {}) {
      const product = { sku, name: 'Stoneware Mug, Sage', price: 18, currency: 'GBP', quantity, in_stock: quantity > 0, ...extra };
      this.products.set(sku, product);
      return product;
    },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://mock');
      if (req.method === 'GET' && (url.pathname === '/stock' || url.pathname.startsWith('/stock/'))) {
        assert.equal(req.headers.authorization, 'Bearer local-stock-key', 'Stock checks must be authenticated');
        const sku = url.pathname === '/stock' ? null : decodeURIComponent(url.pathname.slice('/stock/'.length));
        const call = { sku, path: req.url, headers: req.headers, at: Date.now() };
        mock.stockCalls.push(call);
        const reply = await mock.stockBehavior?.(call, mock) || {};
        const product = sku === null ? { products: [...mock.products.values()] } : mock.products.get(sku) || { sku, name: sku, in_stock: false, quantity: 0 };
        send(res, reply, product);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/emails') {
        assert.equal(req.headers.authorization, 'Bearer local-resend-key', 'Email delivery must be authenticated');
        assert.match(req.headers['content-type'] || '', /^application\/json/);
        const payload = JSON.parse(raw);
        for (const field of ['from', 'subject', 'html', 'text']) assert.equal(typeof payload[field], 'string', `Resend ${field} field`);
        assert.equal(payload.to?.length, 1, 'One recipient per request-scoped email');
        const key = req.headers['idempotency-key'];
        assert.match(key || '', /^restock\/[a-f0-9-]+$/);
        const call = { raw, payload, key, headers: req.headers, at: Date.now(), cached: false };
        mock.emailCalls.push(call);
        const reply = await mock.emailBehavior?.(call, mock) || {};
        const accepts = reply.accept ?? ((reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300);
        let delivery;
        if (accepts) {
          delivery = mock.accepted.get(key);
          if (delivery && delivery.raw !== raw) {
            send(res, { status: 409, body: { message: 'Idempotency key reused with a different payload' } });
            return;
          }
          call.cached = !!delivery;
          if (!delivery) {
            delivery = { id: `mock-email-${mock.accepted.size + 1}`, key, raw, payload, at: Date.now() };
            mock.accepted.set(key, delivery);
          }
          call.providerId = delivery.id;
        }
        send(res, reply, delivery ? { id: delivery.id } : { message: 'Injected email failure' });
        return;
      }
      assert.fail(`Unexpected mock request: ${req.method} ${req.url}`);
    } catch (error) {
      mock.errors.push(error);
      if (!res.headersSent && !res.destroyed) send(res, { status: 500, body: { message: 'Mock contract assertion failed' } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  mock.base = `http://127.0.0.1:${server.address().port}`;
  mock.close = async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  };
  return mock;
}

export async function fixture(t, { env: overrides = {}, start = true } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restock-integration-'));
  let mock;
  const instances = new Set();
  t.after(async () => {
    try {
      for (const app of instances) await app.stop();
      instances.clear();
    } finally {
      if (mock) await mock.close();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    assert.deepEqual(mock?.errors || [], [], 'Local provider contract assertions failed');
  });
  mock = await mockServer();
  const env = {
    STOCK_API_URL: `${mock.base}/stock`, STOCK_API_KEY: 'local-stock-key',
    RESEND_BASE_URL: mock.base, RESEND_API_KEY: 'local-resend-key',
    WEBHOOK_SECRET: 'local-webhook-secret', ADMIN_PASSWORD: PASSWORD,
    DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: '0',
    NETWORK_TIMEOUT_MS: '150', WORKER_LEASE_MS: '500', WORKER_POLL_MS: '25',
    RETRY_BASE_MS: '50', RECONCILE_INTERVAL_MS: '125', ...overrides,
  };
  const h = {
    dataDir, mock, env, config: loadConfig(env), app: undefined, base: undefined,
    async launch() {
      const app = createApplication(loadConfig(env));
      instances.add(app);
      const address = await app.start();
      const base = `http://127.0.0.1:${address.port}`;
      h.app = app;
      h.base = base;
      return { app, base, address };
    },
    async stop(app = h.app) {
      if (instances.has(app)) { await app.stop(); instances.delete(app); }
    },
    async restart() { await h.stop(); return h.launch(); },
    api(route, options) { return request(h.base, route, options); },
    subscribe(email = EMAIL, sku = SKU) { return h.api('/api/requests', { method: 'POST', body: { email, sku } }); },
    webhook(event_id = 'evt_1', sku = SKU, quantity = 5, headers = {}) {
      return h.api('/webhooks/stock', { method: 'POST', body: { event_id, sku, quantity }, headers: { 'X-Webhook-Secret': env.WEBHOOK_SECRET, ...headers } });
    },
    admin(route = '/api/admin/requests', options = {}) {
      return h.api(route, { ...options, headers: { Authorization: basic(env.ADMIN_PASSWORD), ...options.headers } });
    },
    row(id) { return h.app.store.db.prepare('SELECT * FROM requests WHERE id = ?').get(id); },
    rows() { return h.app.store.db.prepare('SELECT * FROM requests ORDER BY created_at, id').all(); },
    async status(id, status, timeout) {
      return eventually(() => { const row = h.row(id); return row?.status === status && row; }, `request ${id} should become ${status}`, timeout);
    },
  };
  if (start) await h.launch();
  return h;
}

export function childServer(t, env) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let spawnError;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { spawnError = error; });
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    return exited;
  };
  t.after(kill);
  return {
    child, exited, kill, get stdout() { return stdout; }, get stderr() { return stderr; },
    async ready() {
      return eventually(() => {
        if (spawnError) throw spawnError;
        const match = /Restock listening on port (\d+)/.exec(stdout);
        return match && `http://127.0.0.1:${match[1]}`;
      }, 'CLI did not log a bound listening port', 6000);
    },
  };
}
