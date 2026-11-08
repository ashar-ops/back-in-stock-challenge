import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, SKU, EMAIL, eventually, remains } from './support.js';

test('concurrent normalized subscriptions share one open row, enforced by SQLite in every open state', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  const responses = await Promise.all(Array.from({ length: 36 }, (_, i) => h.subscribe(
    i % 2 ? '  CUSTOMER@Example.COM  ' : EMAIL,
    i % 3 ? '  mug-stn-sage  ' : SKU,
  )));
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  assert.equal(responses.filter((r) => r.status === 200).length, 35);
  assert.equal(new Set(responses.map((r) => r.data.id)).size, 1);
  assert.equal(responses.filter((r) => r.data.duplicate === false).length, 1);
  const row = h.rows()[0];
  assert.equal(row.email, EMAIL);
  assert.equal(row.sku, SKU);
  assert.equal(h.rows().length, 1);
  assert.equal(h.app.store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(h.app.store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  for (const status of ['waiting', 'queued', 'retrying', 'attention']) {
    h.app.store.db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(status, row.id);
    assert.throws(() => h.app.store.db.prepare('INSERT INTO requests (id,email,sku,created_at,next_attempt_at) VALUES (?,?,?,?,?)')
      .run(randomUUID(), EMAIL, SKU, Date.now(), Date.now()), /UNIQUE constraint failed/, `database must reject duplicate in ${status}`);
    const duplicate = await h.subscribe();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.id, row.id);
    assert.equal(duplicate.data.status, status);
  }
  assert.equal((await h.subscribe('another@example.com')).status, 201);
  assert.equal((await h.subscribe(EMAIL, 'OTHER-SKU')).status, 201);
  assert.equal(h.rows().length, 3);
});

test('subscription body, field, size, content-type, and hostile SKU validation never persists bad input', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  const cases = [
    ['malformed JSON', { raw: '{"email":' }, 400],
    ['empty JSON', { raw: '' }, 400],
    ...['null', '[]', '"value"', '123', 'true'].map((raw) => [`non-object ${raw}`, { raw }, 400]),
    ['missing fields', { body: {} }, 400],
    ['missing email', { body: { sku: SKU } }, 400],
    ['missing SKU', { body: { email: EMAIL } }, 400],
    ...[null, [], {}, 12, true, '', 'no-at', 'a@localhost', '.a@example.com', 'a..b@example.com', 'a.@example.com', 'a@-example.com', 'a@example-.com', 'a\r\nb@example.com', `${'x'.repeat(65)}@example.com`, `${'x'.repeat(64)}@${'x'.repeat(190)}.com`]
      .map((email) => [`invalid email ${JSON.stringify(email)}`, { body: { email, sku: SKU } }, 400]),
    ...[null, [], {}, 12, true, '', '../secret', '/etc/passwd', 'A/B', 'A\\B', 'A?x=1', 'A#x', 'A%2fB', 'A\u0000B', 'A\r\nB', 'DROP TABLE requests;', "A' OR 1=1--", '<script>alert(1)</script>', '☃', 'A'.repeat(65)]
      .map((sku) => [`hostile/invalid SKU ${JSON.stringify(sku)}`, { body: { email: EMAIL, sku } }, 400]),
    ['text content type', { body: { email: EMAIL, sku: SKU }, headers: { 'Content-Type': 'text/plain' } }, 415],
    ['similar but invalid content type', { body: { email: EMAIL, sku: SKU }, headers: { 'Content-Type': 'application/jsonp' } }, 415],
    ['missing content type', { body: { email: EMAIL, sku: SKU }, headers: { 'Content-Type': '' } }, 415],
    ['oversized body', { body: { email: EMAIL, sku: SKU, padding: 'x'.repeat(9000) } }, 413],
  ];
  for (const [label, options, status] of cases) {
    const result = await h.api('/api/requests', { method: 'POST', ...options });
    assert.equal(result.status, status, label);
    assert.equal(typeof result.data?.error, 'string', `${label}: useful JSON error`);
  }
  assert.equal(h.rows().length, 0);
  assert.equal(h.mock.stockCalls.length, 0);
  assert.equal(h.mock.emailCalls.length, 0);
  const valid = await h.api('/api/requests', { method: 'POST', body: { email: 'o\'hara+alerts@example.com', sku: `A${'b'.repeat(63)}` }, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(valid.status, 201, 'valid plus/apostrophe email and 64-character SKU');
  assert.equal(h.rows()[0].sku, `A${'B'.repeat(63)}`);
});

test('webhook authentication and malformed events cannot create receipts or queued email', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  const body = { event_id: 'evt_valid', sku: SKU, quantity: 3 };
  for (const secret of ['', 'wrong', `${h.env.WEBHOOK_SECRET}extra`]) {
    const result = await h.api('/webhooks/stock', { method: 'POST', body, headers: { 'X-Webhook-Secret': secret } });
    assert.equal(result.status, 401);
  }
  const unauthorizedMalformed = await h.api('/webhooks/stock', { method: 'POST', raw: '{' });
  assert.equal(unauthorizedMalformed.status, 401, 'authenticate before parsing');
  const cases = [
    ['{', 400], ['null', 400], ['[]', 400], ['"hello"', 400], ['0', 400], ['false', 400],
    ...[undefined, null, [], 5, '', 'bad id', '../x', 'x'.repeat(129)].map((event_id) => [JSON.stringify({ ...body, event_id }), 400]),
    ...[undefined, null, [], '3', -1, 1.2, Number.MAX_SAFE_INTEGER + 1].map((quantity) => [JSON.stringify({ ...body, quantity }), 400]),
    ...[undefined, null, 2, '../x', "SKU'; DROP TABLE requests;--"].map((sku) => [JSON.stringify({ ...body, sku }), 400]),
  ];
  for (const [raw, status] of cases) {
    const result = await h.api('/webhooks/stock', { method: 'POST', raw, headers: { 'X-Webhook-Secret': h.env.WEBHOOK_SECRET } });
    assert.equal(result.status, status, raw);
  }
  assert.equal((await h.api('/webhooks/stock', { method: 'POST', body, headers: { 'X-Webhook-Secret': h.env.WEBHOOK_SECRET, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 0);
  assert.equal(h.mock.emailCalls.length, 0);
  const valid = await h.webhook('evt:valid_1.0', ' mug-stn-sage ', 0);
  assert.equal(valid.status, 200);
  assert.equal(h.app.store.db.prepare('SELECT sku FROM webhook_events').get().sku, SKU);
});

test('webhook receipts are durable before response; same event is idempotent and conflicting reuse is 409', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  const subscription = await h.subscribe();
  h.app.store.db.prepare('UPDATE requests SET next_attempt_at = ? WHERE id = ?').run(Date.now() + 60000, subscription.data.id);
  const before = Date.now();
  const responses = await Promise.all(Array.from({ length: 24 }, () => h.webhook('evt_concurrent')));
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(responses.filter((r) => r.data.duplicate === false).length, 1);
  assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 1);
  assert.ok(h.row(subscription.data.id).next_attempt_at >= before);
  assert.ok(h.row(subscription.data.id).next_attempt_at <= Date.now());
  assert.equal((await h.webhook('evt_concurrent', SKU, 6)).status, 409);
  assert.equal((await h.webhook('evt_concurrent', 'OTHER-SKU', 5)).status, 409);
  assert.equal((await h.webhook('evt_different', SKU, 5)).status, 200);
  assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 2);
  assert.equal(h.mock.emailCalls.length, 0, 'receipts do not claim that email already happened');
});

test('phantom restocks and inconsistent stock flags never send, even after repeated reconciliation', async (t) => {
  const h = await fixture(t);
  const subscription = await h.subscribe();
  for (const product of [{ quantity: 0, in_stock: false }, { quantity: 0, in_stock: true }, { quantity: 9, in_stock: false }]) {
    h.mock.setStock(SKU, product.quantity, product);
    const checks = h.mock.stockCalls.length;
    assert.equal((await h.webhook(`phantom_${checks}`, SKU, 1000)).status, 200);
    await eventually(() => h.mock.stockCalls.length >= checks + 2, 'phantom must still be checked against stock API');
    await remains(() => h.mock.emailCalls.length === 0, 200, 'unverified webhook quantity must never drive delivery');
    assert.equal(h.row(subscription.data.id).status, 'waiting');
    assert.equal(h.row(subscription.data.id).notified_at, null);
    assert.equal(h.row(subscription.data.id).attempts, 0);
  }
});

test('unknown SKU remains waiting and an event without subscribers never creates a delivery', async (t) => {
  const h = await fixture(t);
  const sub = await h.subscribe(EMAIL, 'UNKNOWN-SKU');
  assert.equal(sub.status, 201);
  h.mock.setStock('UNSUBSCRIBED-SKU', 10);
  assert.equal((await h.webhook('no_subscribers', 'UNSUBSCRIBED-SKU')).status, 200);
  await eventually(() => h.mock.stockCalls.filter((call) => call.sku === 'UNKNOWN-SKU').length >= 3);
  assert.equal(h.rows().length, 1);
  assert.equal(h.row(sub.data.id).status, 'waiting');
  assert.equal(h.mock.emailCalls.length, 0);
});
