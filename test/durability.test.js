import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, SKU, EMAIL, basic, request, childServer, eventually, remains } from './support.js';

function persistedRow(dataDir, id) {
  const db = new DatabaseSync(path.join(dataDir, 'restock.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT * FROM requests WHERE id = ?').get(id); }
  finally { db.close(); }
}

test('restart preserves waiting requests, retry schedule/payload, webhook receipts and completed history', async (t) => {
  const h = await fixture(t);
  let fail = true;
  h.mock.setStock(SKU, 5, { name: 'Before restart' });
  h.mock.setStock('WAITING-SKU', 0);
  h.mock.emailBehavior = () => fail ? { status: 429, headers: { 'Retry-After': '1' } } : {};
  const waiting = await h.subscribe('waiting@example.com', 'WAITING-SKU');
  const retrying = await h.subscribe();
  assert.equal((await h.webhook('persisted_receipt')).status, 200);
  const before = await h.status(retrying.data.id, 'retrying');
  await h.stop();
  const disk = persistedRow(h.dataDir, retrying.data.id);
  assert.equal(disk.status, 'retrying');
  assert.equal(disk.payload_json, before.payload_json);
  assert.equal(disk.first_attempt_at, before.first_attempt_at);
  assert.equal(disk.next_attempt_at, before.next_attempt_at);
  assert.equal(persistedRow(h.dataDir, waiting.data.id).status, 'waiting');
  fail = false;
  h.mock.setStock(SKU, 5, { name: 'After restart', price: 999 });
  h.env.FROM_EMAIL = 'Changed sender <changed@example.com>';
  await h.launch();
  assert.equal((await h.webhook('persisted_receipt')).data.duplicate, true);
  assert.equal((await h.webhook('persisted_receipt', SKU, 9)).status, 409);
  await h.status(retrying.data.id, 'notified');
  assert.equal(h.mock.emailCalls.length, 2);
  assert.equal(h.mock.emailCalls[0].raw, h.mock.emailCalls[1].raw);
  assert.equal(h.mock.emailCalls[0].key, h.mock.emailCalls[1].key);
  assert.ok(h.mock.emailCalls[1].at >= before.next_attempt_at - 5, 'restart must not discard Retry-After schedule');
  assert.equal(h.mock.accepted.size, 1);
  assert.equal(h.row(waiting.data.id).status, 'waiting');
  h.mock.setStock('WAITING-SKU', 3);
  await h.status(waiting.data.id, 'notified');
  const history = h.rows().map(({ id, provider_id, notified_at }) => ({ id, provider_id, notified_at }));
  await h.restart();
  assert.deepEqual(h.rows().map(({ id, provider_id, notified_at }) => ({ id, provider_id, notified_at })), history);
  await h.webhook('after_restart_history');
  await remains(() => h.mock.emailCalls.length === 3, 250, 'completed history must not be sent again after restart');
  assert.equal(h.mock.accepted.size, 2);
});

test('a real abrupt child-process kill after provider acceptance recovers a persisted lease and deduplicates delivery', async (t) => {
  const h = await fixture(t, { start: false, env: { NETWORK_TIMEOUT_MS: '200', WORKER_LEASE_MS: '600' } });
  h.mock.setStock(SKU, 5, { name: 'Before abrupt termination' });
  h.mock.emailBehavior = (_, mock) => mock.emailCalls.length === 1 ? { accept: true, hang: true } : {};
  const first = childServer(t, h.env);
  let second;
  try {
    const base = await first.ready();
    const sub = await request(base, '/api/requests', { method: 'POST', body: { email: EMAIL, sku: SKU } });
    assert.equal(sub.status, 201);
    await eventually(() => h.mock.accepted.size === 1, 'provider must accept before the crash');
    const before = persistedRow(h.dataDir, sub.data.id);
    assert.equal(before.status, 'queued');
    assert.equal(before.notified_at, null);
    assert.equal(before.provider_id, null);
    assert.ok(before.lease_token);
    assert.ok(before.lease_until > Date.now());
    assert.equal(before.payload_json, h.mock.emailCalls[0].raw);
    const exit = await first.kill();
    assert.notEqual(exit.code, 0, 'termination must not use graceful shutdown');
    const afterCrash = persistedRow(h.dataDir, sub.data.id);
    assert.equal(afterCrash.status, 'queued');
    assert.equal(afterCrash.payload_json, before.payload_json);
    assert.equal(afterCrash.first_attempt_at, before.first_attempt_at);
    h.mock.setStock(SKU, 4, { name: 'Changed during crash', price: 999 });
    second = childServer(t, h.env);
    const resumedBase = await second.ready();
    const result = await eventually(async () => {
      const response = await request(resumedBase, '/api/admin/requests', { headers: { Authorization: basic() } });
      assert.equal(response.status, 200);
      return response.data.requests.find((row) => row.id === sub.data.id && row.status === 'notified');
    }, 'restarted CLI must resume the orphaned lease without any new event');
    assert.ok(result.notified_at);
    assert.equal(h.mock.emailCalls.length, 2);
    assert.equal(h.mock.accepted.size, 1);
    assert.equal(h.mock.emailCalls[1].cached, true);
    assert.equal(h.mock.emailCalls[1].key, h.mock.emailCalls[0].key);
    assert.equal(h.mock.emailCalls[1].raw, h.mock.emailCalls[0].raw);
    assert.ok(h.mock.emailCalls[1].at >= before.lease_until - 5, 'orphaned work must wait for its persisted lease');
    assert.equal(persistedRow(h.dataDir, sub.data.id).provider_id, [...h.mock.accepted.values()][0].id);
  } finally {
    await first.kill();
    if (second) await second.kill();
  }
});

test('multiple worker instances sharing one SQLite database atomically claim each recipient once', async (t) => {
  const h = await fixture(t);
  const first = h.app;
  await first.worker.stop();
  const second = (await h.launch()).app;
  await second.worker.stop();
  const subscriptions = await Promise.all(Array.from({ length: 20 }, (_, i) => h.subscribe(`shared-${i}@example.com`)));
  assert.ok(subscriptions.every((sub) => sub.status === 201));
  h.mock.setStock(SKU, 100);
  await Promise.all(Array.from({ length: 10 }, (_, i) => h.webhook(`multi_worker_${i}`)));
  first.worker.start();
  second.worker.start();
  await eventually(() => h.rows().length === 20 && h.rows().every((row) => row.status === 'notified'));
  assert.equal(h.mock.accepted.size, 20);
  assert.equal(h.mock.emailCalls.length, 20);
  assert.equal(new Set(h.mock.emailCalls.map((call) => call.key)).size, 20);
  assert.ok(h.rows().every((row) => row.attempts === 1 && row.notified_at !== null));
});

test('stale workers cannot acknowledge or overwrite a row after their SQLite lease is reclaimed', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  const sub = await h.subscribe();
  const now = Date.now();
  const oldClaim = h.app.store.claim(500, now);
  assert.equal(oldClaim.id, sub.data.id);
  assert.equal(h.app.store.claim(500, now + 100), undefined);
  const newClaim = h.app.store.claim(500, now + 501);
  assert.equal(newClaim.id, sub.data.id);
  assert.notEqual(newClaim.lease_token, oldClaim.lease_token);
  assert.equal(h.app.store.updateClaim(oldClaim, { status: 'notified', notified_at: now }), false);
  assert.equal(h.app.store.updateClaim(newClaim, { status: 'retrying', lease_token: null, lease_until: 0 }), true);
  assert.equal(h.row(sub.data.id).status, 'retrying');
  assert.equal(h.row(sub.data.id).notified_at, null);
});

test('persisted delivery older than 23 hours enters attention on restart and cannot be blindly manually retried', async (t) => {
  const h = await fixture(t);
  h.mock.setStock(SKU, 5);
  h.mock.emailBehavior = () => ({ status: 500 });
  const sub = await h.subscribe();
  await h.status(sub.data.id, 'retrying');
  await h.app.worker.stop();
  const payload = h.row(sub.data.id).payload_json;
  const expired = Date.now() - 23 * 60 * 60 * 1000 - 60000;
  h.app.store.db.prepare('UPDATE requests SET first_attempt_at = ?, next_attempt_at = ?, lease_until = 0, lease_token = NULL WHERE id = ?')
    .run(expired, Date.now(), sub.data.id);
  const attempts = h.mock.emailCalls.length;
  h.mock.emailBehavior = undefined;
  await h.restart();
  const attention = await h.status(sub.data.id, 'attention');
  assert.equal(attention.first_attempt_at, expired);
  assert.equal(attention.payload_json, payload);
  assert.equal(attention.notified_at, null);
  assert.match(attention.last_error, /idempotency window.*expired/i);
  const duplicate = await h.subscribe();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.id, sub.data.id);
  const retry = await h.admin('/api/admin/retry', { method: 'POST', body: { id: sub.data.id } });
  assert.equal(retry.status, 409);
  assert.match(retry.data.error, /expired|unsafe/i);
  await h.webhook('expired_retry_hint');
  await remains(() => h.mock.emailCalls.length === attempts, 300, 'expired keys cannot be resent by admin, webhook or reconciliation');
  await h.restart();
  assert.equal(h.row(sub.data.id).status, 'attention');
  assert.equal(h.row(sub.data.id).first_attempt_at, expired);
  assert.equal(h.mock.accepted.size, 0);
});

test('old waiting requests with no delivery attempt are not incorrectly blocked by the provider window', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  const sub = await h.subscribe();
  h.app.store.db.prepare('UPDATE requests SET created_at = ? WHERE id = ?').run(Date.now() - 48 * 60 * 60 * 1000, sub.data.id);
  h.mock.setStock(SKU, 3);
  await h.restart();
  await h.status(sub.data.id, 'notified');
  assert.equal(h.mock.accepted.size, 1);
  assert.equal(h.row(sub.data.id).attempts, 1);
});
