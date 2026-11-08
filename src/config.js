import path from 'node:path';

function integer(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}

function endpoint(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  return url.href.replace(/\/+$/, '');
}

export function loadConfig(env = process.env) {
  for (const name of ['STOCK_API_URL', 'STOCK_API_KEY', 'RESEND_API_KEY', 'RESEND_BASE_URL', 'WEBHOOK_SECRET', 'ADMIN_PASSWORD']) {
    if (!env[name]?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  }
  const networkTimeout = integer(env, 'NETWORK_TIMEOUT_MS', 5000, 50, 30000);
  const leaseMs = integer(env, 'WORKER_LEASE_MS', 30000, 500, 180000);
  if (leaseMs < networkTimeout * 3) throw new Error('WORKER_LEASE_MS must be at least three times NETWORK_TIMEOUT_MS');
  const publicUrl = env.PUBLIC_URL ? endpoint(env.PUBLIC_URL, 'PUBLIC_URL') : '';
  if (publicUrl && new URL(publicUrl).pathname !== '/') throw new Error('PUBLIC_URL must be an origin, without a path');
  const fromEmail = env.FROM_EMAIL || 'Restock <onboarding@resend.dev>';
  if (fromEmail.length > 254 || /[\r\n]/.test(fromEmail)) throw new Error('Invalid FROM_EMAIL');
  return {
    port: integer(env, 'PORT', 3000, 0, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    stockUrl: endpoint(env.STOCK_API_URL, 'STOCK_API_URL'),
    stockKey: env.STOCK_API_KEY,
    resendUrl: endpoint(env.RESEND_BASE_URL, 'RESEND_BASE_URL'),
    resendKey: env.RESEND_API_KEY,
    webhookSecret: env.WEBHOOK_SECRET,
    adminPassword: env.ADMIN_PASSWORD,
    publicUrl,
    fromEmail,
    networkTimeout,
    leaseMs,
    pollMs: integer(env, 'WORKER_POLL_MS', 250, 25, 10000),
    reconcileMs: integer(env, 'RECONCILE_INTERVAL_MS', 60000, 100, 3600000),
    retryBaseMs: integer(env, 'RETRY_BASE_MS', 1000, 50, 60000),
    idempotencyWindowMs: 23 * 60 * 60 * 1000,
  };
}
