import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openStore } from './db.js';
import { createWorker, getCatalog } from './worker.js';
import { buildEmail } from './email.js';

const publicDir = new URL('../public/', import.meta.url);
const hash = (value) => createHash('sha256').update(value).digest();
const equals = (a, b) => timingSafeEqual(hash(a), hash(b));
const statuses = new Set(['waiting', 'queued', 'retrying', 'notified', 'attention']);
const assets = new Set(['styles.css', 'store.js', 'embed.js', 'admin.js', 'login.js', 'brand.svg']);
const sessionMs = 8 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Use Content-Type: application/json.');
  let size = 0;
  const chunks = [];
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      size += chunk.length;
      if (size > 8192) {
        req.off('data', onData);
        req.resume();
        reject(new HttpError(413, 'Request body is too large.'));
      } else chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', resolve);
    req.once('error', () => reject(new HttpError(400, 'The request could not be read.')));
    req.once('aborted', () => reject(new HttpError(400, 'The request was interrupted.')));
  });
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Body must be a JSON object.');
  return value;
}

function skuInput(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a valid product SKU.');
  const sku = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku)) throw new HttpError(400, 'SKU must be 1–64 letters, numbers, hyphens, underscores, or dots.');
  return sku;
}

function emailInput(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a valid email address.');
  const email = value.trim().toLowerCase();
  const [local] = email.split('@');
  if (email.length > 254 || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  return email;
}

export function createApplication(config) {
  const store = openStore(config.dataDir);
  const worker = createWorker(store, config);
  const buckets = new Map();
  let catalogCache;
  let catalogPending;

  function limit(req, scope, max, windowMs, increment = true) {
    const now = Date.now();
    if (buckets.size > 1000) for (const [key, value] of buckets) if (value.until < now) buckets.delete(key);
    const key = `${scope}:${req.socket.remoteAddress}`;
    let bucket = buckets.get(key);
    if (!bucket && buckets.size >= 10000) throw new HttpError(429, 'Too many attempts. Please try again later.');
    if (!bucket || bucket.until <= now) { bucket = { count: 0, until: now + windowMs }; buckets.set(key, bucket); }
    if (increment) bucket.count++;
    if (bucket.count > max) throw new HttpError(429, 'Too many attempts. Please try again later.');
  }

  function headers(res, embed = false) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors ${embed ? '*' : "'none'"}; base-uri 'none'; object-src 'none'; form-action 'self'`);
    if (!embed) res.setHeader('X-Frame-Options', 'DENY');
    if (config.publicUrl.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  async function page(res, file) {
    const content = await readFile(new URL(file, publicDir));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  }

  function token(req) {
    const match = /(?:^|;\s*)restock_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    return match?.[1] || '';
  }

  function authenticated(req) {
    const auth = req.headers.authorization;
    if (auth && /^Basic\s/i.test(auth)) {
      limit(req, 'basic-login', 10, 900000, false);
      const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const colon = credentials.indexOf(':');
      if (colon >= 0 && equals(credentials.slice(colon + 1), config.adminPassword)) return true;
      limit(req, 'basic-login', 10, 900000);
    }
    const value = token(req);
    return !!value && !!store.db.prepare('SELECT 1 FROM admin_sessions WHERE token_hash = ? AND expires_at > ?').get(hash(value).toString('hex'), Date.now());
  }

  function checkOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site admin actions are not allowed.');
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, 'Invalid request origin.'); }
      const expected = config.publicUrl ? new URL(config.publicUrl).origin : `http${req.socket.encrypted ? 's' : ''}://${req.headers.host}`;
      if (origin.origin !== expected) throw new HttpError(403, 'Invalid request origin.');
    }
  }

  function cookie(res, value, maxAge) {
    res.setHeader('Set-Cookie', `restock_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.publicUrl.startsWith('https:') ? '; Secure' : ''}`);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    headers(res, path === '/embed');
    if (req.method === 'GET' && path === '/healthz') {
      store.db.prepare('SELECT 1').get();
      return json(res, 200, { status: 'ok' });
    }
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      const file = path.slice(8);
      if (!assets.has(file)) throw new HttpError(404, 'Not found.');
      const types = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };
      const content = await readFile(new URL(file, publicDir));
      res.writeHead(200, { 'Content-Type': `${types[file.split('.').pop()]}; charset=utf-8`, 'Cache-Control': 'public, max-age=300' });
      return res.end(content);
    }
    if (req.method === 'GET' && path === '/') return page(res, 'index.html');
    if (req.method === 'GET' && path === '/embed') return page(res, 'embed.html');
    if (req.method === 'GET' && path === '/admin/login') return page(res, 'login.html');
    if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && path === '/api/catalog') {
      if (!catalogCache || catalogCache.expires < Date.now()) {
        catalogPending ??= getCatalog(config).then((products) => { catalogCache = { products, expires: Date.now() + 5000 }; }).finally(() => { catalogPending = undefined; });
        try { await catalogPending; } catch { throw new HttpError(503, 'The catalogue is temporarily unavailable. You can still request an alert using a SKU.'); }
      }
      return json(res, 200, { products: catalogCache.products });
    }
    if (req.method === 'POST' && path === '/api/requests') {
      limit(req, 'subscribe', 120, 60000);
      const input = await body(req);
      const result = store.subscribe(emailInput(input.email), skuInput(input.sku));
      json(res, result.duplicate ? 200 : 201, { ...result, message: result.duplicate ? 'You are already on the list for this item.' : 'You are on the list. We will email you when stock is confirmed.' });
      worker.wake();
      return;
    }
    if (req.method === 'POST' && path === '/webhooks/stock') {
      if (!equals(String(req.headers['x-webhook-secret'] || ''), config.webhookSecret)) throw new HttpError(401, 'Invalid webhook secret.');
      const input = await body(req);
      if (typeof input.event_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(input.event_id)) throw new HttpError(400, 'A valid event_id is required.');
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) throw new HttpError(400, 'Quantity must be a non-negative integer.');
      const result = store.acceptEvent({ event_id: input.event_id, sku: skuInput(input.sku), quantity: input.quantity });
      if (result === 'conflict') throw new HttpError(409, 'This event_id was already used for different stock data.');
      json(res, 200, { received: true, duplicate: result === 'duplicate' });
      worker.wake();
      return;
    }
    if (req.method === 'POST' && path === '/api/admin/login') {
      checkOrigin(req);
      limit(req, 'login', 10, 900000);
      const input = await body(req);
      if (typeof input.password !== 'string' || !equals(input.password, config.adminPassword)) throw new HttpError(401, 'That password is not correct.');
      const old = token(req);
      if (old) store.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hash(old).toString('hex'));
      const value = randomBytes(32).toString('hex');
      store.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(Date.now());
      store.db.prepare('INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)').run(hash(value).toString('hex'), Date.now() + sessionMs);
      cookie(res, value, sessionMs / 1000);
      return json(res, 200, { ok: true });
    }
    if (path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin/')) {
      if (!authenticated(req)) {
        if (path.startsWith('/api/')) throw new HttpError(401, 'Please sign in to continue.');
        res.writeHead(303, { Location: '/admin/login' }); return res.end();
      }
      if (req.method === 'POST') checkOrigin(req);
      if (req.method === 'GET' && path === '/admin') return page(res, 'admin.html');
      if (req.method === 'GET' && path === '/api/admin/requests') {
        const status = url.searchParams.get('status') || '';
        if (status && !statuses.has(status)) throw new HttpError(400, 'Unknown request status.');
        const pageNo = Number(url.searchParams.get('page') || 1);
        if (!Number.isSafeInteger(pageNo) || pageNo < 1 || pageNo > 1000000) throw new HttpError(400, 'Invalid page.');
        return json(res, 200, store.list({ status, query: (url.searchParams.get('q') || '').slice(0, 254), page: pageNo }));
      }
      if (req.method === 'GET' && path === '/api/admin/events') {
        const events = store.db.prepare('SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 50').all().map((event) => ({ ...event, received_at: new Date(event.received_at).toISOString() }));
        return json(res, 200, { events });
      }
      if (req.method === 'GET' && path === '/admin/email-preview') {
        const message = buildEmail({ email: 'preview@example.com', sku: 'MUG-STN-SAGE' }, { name: 'Stoneware Mug, Sage', price: 18, currency: 'GBP' }, config);
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-top-navigation-by-user-activation");
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(message.html);
      }
      if (req.method === 'POST' && path === '/api/admin/logout') {
        await body(req);
        const value = token(req);
        if (value) store.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hash(value).toString('hex'));
        cookie(res, '', 0);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/admin/retry') {
        const input = await body(req);
        if (typeof input.id !== 'string') throw new HttpError(400, 'Request ID is required.');
        const row = store.db.prepare('SELECT * FROM requests WHERE id = ?').get(input.id);
        if (!row) throw new HttpError(404, 'Request not found.');
        if (row.status !== 'attention') throw new HttpError(409, 'Only requests needing attention can be manually retried.');
        if (row.first_attempt_at && Date.now() - row.first_attempt_at >= config.idempotencyWindowMs) throw new HttpError(409, 'The idempotency window expired. Reconcile delivery in the provider inbox before taking action; automatic resend is unsafe.');
        store.db.prepare("UPDATE requests SET status = 'retrying', next_attempt_at = ?, last_error = NULL WHERE id = ? AND status = 'attention'").run(Date.now(), row.id);
        json(res, 200, { ok: true }); worker.wake(); return;
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, (req, res) => {
    route(req, res).catch((error) => {
      if (!res.headersSent && !res.destroyed) {
        if (error.status === 429) res.setHeader('Retry-After', '900');
        json(res, error.status || 500, { error: error.status ? error.message : 'An unexpected server error occurred. Please try again.' });
      } else if (!res.writableEnded) res.end();
      if (!error.status) console.error('Request failed:', error.code || error.name);
    });
  });
  server.keepAliveTimeout = 5000;

  return {
    server, store, worker,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      worker.start();
      return server.address();
    },
    async stop() {
      const closed = new Promise((resolve) => server.close(resolve));
      await worker.stop();
      server.closeIdleConnections();
      await closed;
      store.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const app = createApplication(config);
    const address = await app.start();
    console.log(`Restock listening on port ${address.port}; data directory: ${config.dataDir}`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.stop();
      process.exit(0);
    });
  } catch (error) { console.error(`Startup failed: ${error.message}`); process.exitCode = 1; }
}
