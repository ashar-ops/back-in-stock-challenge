import { buildEmail } from './email.js';

class UpstreamError extends Error {
  constructor(message, { permanent = false, retryAfter = 0 } = {}) {
    super(message);
    this.permanent = permanent;
    this.retryAfter = retryAfter;
  }
}

function retryAfter(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 3600000)) : 0;
}

async function fetchJson(url, options, config, service) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(config.networkTimeout) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(`${service} returned HTTP ${response.status}`, {
        permanent: service === 'Email provider' && response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status),
        retryAfter: retryAfter(response),
      });
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1048576) throw new UpstreamError(`${service} returned an oversized response`);
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(`${service} timed out, was unreachable, or returned invalid JSON`);
  }
}

export async function getStock(config, sku) {
  const product = await fetchJson(`${config.stockUrl}/${encodeURIComponent(sku)}`, { headers: { Authorization: `Bearer ${config.stockKey}` } }, config, 'Stock API');
  if (!product || typeof product !== 'object' || typeof product.in_stock !== 'boolean' || !Number.isSafeInteger(product.quantity) || product.quantity < 0 || (product.sku && String(product.sku).toUpperCase() !== sku)) {
    throw new UpstreamError('Stock API returned an invalid stock record');
  }
  return product;
}

export async function getCatalog(config) {
  const data = await fetchJson(config.stockUrl, { headers: { Authorization: `Bearer ${config.stockKey}` } }, config, 'Stock API');
  if (!data || !Array.isArray(data.products)) throw new UpstreamError('Stock API returned an invalid catalogue');
  return data.products.slice(0, 500).filter((p) => p && typeof p.sku === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.sku)).map((p) => ({
    sku: p.sku.toUpperCase(), name: String(p.name || p.sku).slice(0, 200), category: String(p.category || 'Essentials').slice(0, 80),
    price: typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0 ? p.price : null,
    currency: /^[A-Z]{3}$/.test(p.currency || '') ? p.currency : 'GBP',
    quantity: Number.isSafeInteger(p.quantity) && p.quantity > 0 ? p.quantity : 0,
    in_stock: p.in_stock === true && p.quantity > 0,
  }));
}

export function createWorker(store, config) {
  let timer;
  let active;
  let stopped = false;

  const backoff = (n) => Math.min(300000, config.retryBaseMs * 2 ** Math.min(n, 8)) * (0.85 + Math.random() * 0.3);
  const release = (row, values) => store.updateClaim(row, { ...values, lease_token: null, lease_until: 0 });

  async function processRequest(row) {
    if (row.first_attempt_at && Date.now() - row.first_attempt_at >= config.idempotencyWindowMs) {
      release(row, { status: 'attention', last_error: 'Delivery outcome requires review: the safe provider idempotency window has expired. Do not blindly resend.' });
      return;
    }
    let product;
    try { product = await getStock(config, row.sku); }
    catch (error) {
      release(row, { check_failures: row.check_failures + 1, last_error: error.message, next_attempt_at: Math.round(Date.now() + Math.max(backoff(row.check_failures), error.retryAfter || 0)) });
      return;
    }
    if (!product.in_stock || product.quantity <= 0) {
      release(row, { next_attempt_at: Date.now() + config.reconcileMs, check_failures: 0, last_error: row.payload_json ? 'Waiting for verified stock before retrying the same notification.' : null });
      return;
    }
    const payload = row.payload_json || JSON.stringify(buildEmail(row, product, config));
    const started = Date.now();
    if (!store.updateClaim(row, {
      payload_json: payload, first_attempt_at: row.first_attempt_at ?? started, status: 'queued',
      attempts: row.attempts + 1, check_failures: 0, lease_until: started + config.leaseMs,
    })) return;
    try {
      const result = await fetchJson(`${config.resendUrl}/emails`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.resendKey}`, 'Idempotency-Key': `restock/${row.id}` }, body: payload,
      }, config, 'Email provider');
      if (!result || typeof result.id !== 'string' || !result.id || result.id.length > 200) throw new UpstreamError('Email provider returned an ambiguous acknowledgement');
      release(row, { status: 'notified', provider_id: result.id, notified_at: Date.now(), last_error: null });
    } catch (error) {
      release(row, {
        status: error.permanent ? 'attention' : 'retrying', last_error: error.message,
        next_attempt_at: Math.round(Date.now() + Math.max(backoff(row.attempts), error.retryAfter || 0)),
      });
    }
  }

  async function tick() {
    if (stopped || active) return active;
    active = (async () => {
      for (let i = 0; i < 20 && !stopped; i++) {
        const row = store.claim(config.leaseMs);
        if (!row) break;
        await processRequest(row);
      }
    })();
    try { await active; }
    catch (error) { console.error('Queue worker failed; leased work will be recovered:', error.code || error.name); }
    finally { active = undefined; }
  }

  return {
    start() { stopped = false; timer = setInterval(tick, config.pollMs); timer.unref(); void tick(); },
    wake() { void tick(); },
    async stop() { stopped = true; clearInterval(timer); await active; },
  };
}
