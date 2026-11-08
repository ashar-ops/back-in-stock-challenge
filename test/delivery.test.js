import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, SKU, EMAIL, eventually, remains } from './support.js';

test('already-in-stock subscription delivers automatically and notified history permits multiple new subscriptions', async (t) => {
  const h = await fixture(t);
  h.mock.setStock(SKU, 10);
  const ids = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const sub = await h.subscribe();
    assert.equal(sub.status, 201);
    assert.equal(sub.data.duplicate, false);
    ids.push(sub.data.id);
    const row = await h.status(sub.data.id, 'notified');
    assert.ok(row.notified_at >= row.created_at);
    assert.ok(row.first_attempt_at <= row.notified_at);
    assert.equal(row.provider_id, h.mock.accepted.get(`restock/${sub.data.id}`).id);
    assert.equal(row.attempts, 1);
  }
  assert.equal(new Set(ids).size, 3);
  assert.equal(h.rows().length, 3);
  assert.equal(h.mock.accepted.size, 3);
  assert.equal(h.mock.emailCalls.length, 3);
  assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 0);
});

test('reconciliation catches a missed webhook without another subscription or event', async (t) => {
  const h = await fixture(t);
  h.mock.setStock(SKU, 0);
  const sub = await h.subscribe();
  await eventually(() => h.mock.stockCalls.length >= 2);
  assert.equal(h.row(sub.data.id).status, 'waiting');
  h.mock.setStock(SKU, 4);
  await h.status(sub.data.id, 'notified');
  assert.equal(h.mock.accepted.size, 1);
  assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 0);
});

test('concurrent identical and different webhook IDs deliver exactly one provider acceptance per open request', async (t) => {
  const h = await fixture(t);
  h.mock.setStock(SKU, 0);
  const recipients = ['one@example.com', 'two@example.com', 'three@example.com', 'four@example.com'];
  const subs = await Promise.all(recipients.map((email) => h.subscribe(email)));
  h.mock.setStock(SKU, 20);
  const results = await Promise.all(Array.from({ length: 48 }, (_, i) => h.webhook(i < 24 ? 'same_event' : `different_event_${i}`)));
  assert.ok(results.every((result) => result.status === 200));
  await eventually(() => h.rows().every((row) => row.status === 'notified'));
  assert.equal(h.mock.accepted.size, recipients.length);
  assert.equal(h.mock.emailCalls.length, recipients.length);
  assert.deepEqual([...h.mock.accepted.values()].map((email) => email.payload.to[0]).sort(), recipients.sort());
  assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 25);
  for (const sub of subs) assert.ok(h.mock.accepted.has(`restock/${sub.data.id}`));
  await Promise.all(Array.from({ length: 12 }, (_, i) => h.webhook(`after_notified_${i}`)));
  await remains(() => h.mock.emailCalls.length === recipients.length, 300, 'later webhooks must not re-deliver completed requests');
});

test('quantity-zero webhook is a hint: verified positive stock still delivers', async (t) => {
  const h = await fixture(t);
  await h.app.worker.stop();
  const sub = await h.subscribe();
  h.app.store.db.prepare('UPDATE requests SET next_attempt_at = ? WHERE id = ?').run(Date.now() + 60000, sub.data.id);
  h.mock.setStock(SKU, 4);
  assert.equal((await h.webhook('zero_hint', SKU, 0)).status, 200);
  h.app.worker.start();
  await h.status(sub.data.id, 'notified');
  assert.equal(h.mock.accepted.size, 1);
});

const stockFailures = [
  ['HTTP 500', { status: 500 }],
  ['invalid JSON', { raw: '{not JSON' }],
  ['network timeout', { hang: true }],
  ['invalid stock schema', { body: { sku: SKU, quantity: '10', in_stock: true } }],
  ['mismatched product SKU', { body: { sku: 'OTHER-SKU', quantity: 10, in_stock: true } }],
  ['non-object stock record', { body: null }],
];
for (const [name, failure] of stockFailures) {
  test(`stock ${name} retains the request and automatically recovers without another event`, async (t) => {
    const h = await fixture(t);
    h.mock.setStock(SKU, 6);
    h.mock.stockBehavior = () => failure;
    const sub = await h.subscribe();
    const row = await eventually(() => { const row = h.row(sub.data.id); return row.check_failures >= 2 && row; }, 'stock failures must remain scheduled');
    assert.equal(row.status, 'waiting');
    assert.equal(row.notified_at, null);
    assert.equal(row.first_attempt_at, null);
    assert.equal(row.payload_json, null);
    assert.equal(row.attempts, 0);
    assert.match(row.last_error, /Stock API/);
    assert.equal(h.mock.emailCalls.length, 0);
    h.mock.stockBehavior = undefined;
    const notified = await h.status(sub.data.id, 'notified');
    assert.equal(notified.check_failures, 0);
    assert.equal(notified.last_error, null);
    assert.equal(h.mock.accepted.size, 1);
    assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 0);
  });
}

for (const status of [500, 429, 408, 409, 425]) {
  test(`email HTTP ${status} automatically retries${status === 429 ? ' respecting Retry-After' : ''} without a new event`, async (t) => {
    const h = await fixture(t);
    h.mock.setStock(SKU, 8);
    h.mock.emailBehavior = (_, mock) => mock.emailCalls.length === 1 ? { status, headers: status === 429 ? { 'Retry-After': '1' } : {} } : {};
    const sub = await h.subscribe();
    const retrying = await h.status(sub.data.id, 'retrying');
    assert.equal(retrying.notified_at, null);
    assert.equal(retrying.provider_id, null);
    assert.equal(retrying.attempts, 1);
    assert.ok(retrying.payload_json);
    const notified = await h.status(sub.data.id, 'notified');
    assert.equal(notified.attempts, 2);
    assert.equal(h.mock.emailCalls.length, 2);
    assert.equal(h.mock.accepted.size, 1);
    const [first, second] = h.mock.emailCalls;
    assert.equal(first.key, second.key);
    assert.equal(first.raw, second.raw);
    if (status === 429) assert.ok(second.at - first.at >= 990, 'provider Retry-After must not be shortened by backoff or polling');
    assert.equal(h.app.store.db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n, 0);
  });
}

test('a webhook storm cannot bypass an email provider Retry-After delay', async (t) => {
  const h = await fixture(t);
  h.mock.setStock(SKU, 8);
  h.mock.emailBehavior = (_, mock) => mock.emailCalls.length === 1 ? { status: 429, headers: { 'Retry-After': '1' } } : {};
  const sub = await h.subscribe();
  await h.status(sub.data.id, 'retrying');
  await Promise.all(Array.from({ length: 30 }, (_, i) => h.webhook(`rate_limit_hint_${i}`)));
  await h.status(sub.data.id, 'notified');
  assert.equal(h.mock.emailCalls.length, 2);
  assert.ok(h.mock.emailCalls[1].at - h.mock.emailCalls[0].at >= 990);
});

test('webhook hints preserve the stock provider Retry-After backoff', async (t) => {
  const h = await fixture(t);
  h.mock.setStock(SKU, 8);
  h.mock.stockBehavior = (_, mock) => mock.stockCalls.length === 1 ? { status: 429, headers: { 'Retry-After': '1' } } : {};
  const sub = await h.subscribe();
  await eventually(() => h.row(sub.data.id).check_failures === 1);
  await Promise.all(Array.from({ length: 20 }, (_, i) => h.webhook(`stock_rate_limit_${i}`)));
  await h.status(sub.data.id, 'notified');
  assert.ok(h.mock.stockCalls[1].at - h.mock.stockCalls[0].at >= 990);
  assert.equal(h.mock.accepted.size, 1);
});

test('one failing recipient does not lose or block other recipients, and later recovers automatically', async (t) => {
  const h = await fixture(t);
  let fail = true;
  h.mock.emailBehavior = (call) => fail && call.payload.to[0] === 'failing@example.com' ? { status: 500 } : {};
  const failed = await h.subscribe('failing@example.com');
  const others = await Promise.all(['healthy-a@example.com', 'healthy-b@example.com'].map((email) => h.subscribe(email)));
  h.mock.setStock(SKU, 20);
  await h.webhook('recipient_isolation');
  for (const other of others) await h.status(other.data.id, 'notified');
  assert.equal(h.mock.accepted.size, 2);
  assert.notEqual(h.row(failed.data.id).status, 'notified');
  assert.equal(h.row(failed.data.id).notified_at, null);
  assert.equal((await h.subscribe('failing@example.com')).data.id, failed.data.id);
  fail = false;
  await h.status(failed.data.id, 'notified');
  assert.equal(h.mock.accepted.size, 3);
  for (const email of ['healthy-a@example.com', 'healthy-b@example.com']) assert.equal(h.mock.emailCalls.filter((call) => call.payload.to[0] === email).length, 1);
});

test('exact payload and request-scoped idempotency key are persisted before sending and immutable when the product changes', async (t) => {
  const h = await fixture(t);
  const snapshots = [];
  h.mock.setStock(SKU, 10, { name: 'Original product', price: 18 });
  h.mock.emailBehavior = (call, mock) => {
    const row = h.rows()[0];
    snapshots.push({ ...row });
    if (mock.emailCalls.length === 1) {
      mock.setStock(SKU, 10, { name: 'Changed product', price: 999, currency: 'USD' });
      return { status: 500 };
    }
    return {};
  };
  const sub = await h.subscribe();
  const row = await h.status(sub.data.id, 'notified');
  assert.equal(h.mock.emailCalls.length, 2);
  for (const [i, call] of h.mock.emailCalls.entries()) {
    assert.equal(call.key, `restock/${sub.data.id}`);
    assert.equal(call.raw, row.payload_json);
    assert.equal(snapshots[i].payload_json, call.raw, 'payload is durable before HTTP delivery');
    assert.equal(snapshots[i].status, 'queued');
    assert.equal(snapshots[i].notified_at, null, 'do not mark success before acknowledgement');
    assert.ok(snapshots[i].first_attempt_at <= call.at);
    assert.equal(snapshots[i].first_attempt_at, row.first_attempt_at);
    assert.match(call.payload.subject, /Original product/);
    assert.doesNotMatch(call.payload.html, /Changed product|999/);
  }
  assert.equal(row.attempts, 2);
  assert.ok(h.mock.stockCalls.length >= 2, 'every retry must verify stock again');
});

for (const [name, reply] of [
  ['missing acknowledgement ID', { body: {} }],
  ['invalid acknowledgement ID', { body: { id: 42 } }],
  ['invalid JSON success response', { raw: '{' }],
  ['socket loss after acceptance', { drop: true }],
  ['timeout after acceptance', { hang: true }],
]) {
  test(`ambiguous provider success (${name}) retries the original key and is deduplicated by the provider`, async (t) => {
    const h = await fixture(t);
    h.mock.setStock(SKU, 9);
    h.mock.emailBehavior = (_, mock) => mock.emailCalls.length === 1 ? reply : {};
    const sub = await h.subscribe();
    await h.status(sub.data.id, 'notified');
    assert.equal(h.mock.emailCalls.length, 2);
    assert.equal(h.mock.accepted.size, 1, 'one provider acceptance, not an unconditional inbox-delivery guarantee');
    assert.equal(h.mock.emailCalls[1].cached, true);
    assert.equal(h.mock.emailCalls[0].raw, h.mock.emailCalls[1].raw);
    assert.equal(h.mock.emailCalls[0].key, h.mock.emailCalls[1].key);
    assert.equal(h.row(sub.data.id).provider_id, [...h.mock.accepted.values()][0].id);
  });
}

test('sold-out stock pauses ambiguous delivery retry until stock returns, without changing its payload', async (t) => {
  const h = await fixture(t);
  h.mock.setStock(SKU, 3);
  h.mock.emailBehavior = (_, mock) => {
    if (mock.emailCalls.length === 1) { mock.setStock(SKU, 0); return { drop: true }; }
    return {};
  };
  const sub = await h.subscribe();
  await h.status(sub.data.id, 'retrying');
  await eventually(() => h.mock.stockCalls.length >= 3);
  await remains(() => h.mock.emailCalls.length === 1, 250, 'must independently reconfirm stock before every resend');
  assert.equal(h.row(sub.data.id).notified_at, null, 'lost acknowledgement is not known success');
  h.mock.setStock(SKU, 4, { name: 'New metadata' });
  await h.status(sub.data.id, 'notified');
  assert.equal(h.mock.accepted.size, 1);
  assert.equal(h.mock.emailCalls.length, 2);
  assert.equal(h.mock.emailCalls[0].raw, h.mock.emailCalls[1].raw);
});

test('email contract includes safe HTML, plain text, sender and recipient, with escaped hostile product metadata', async (t) => {
  const h = await fixture(t, { env: { PUBLIC_URL: 'http://127.0.0.1:12345', FROM_EMAIL: 'Local Store <sender@example.com>' } });
  const name = `<img src=x onerror="alert('x')"> & \"quoted\"\r\nHeader: injected`;
  h.mock.setStock(SKU, 2, { name, currency: 'GBP', price: 18.5, url: 'javascript:alert(1)' });
  const sub = await h.subscribe("o'hara+alert@example.com");
  await h.status(sub.data.id, 'notified');
  const { payload } = h.mock.emailCalls[0];
  assert.equal(payload.from, 'Local Store <sender@example.com>');
  assert.deepEqual(payload.to, ["o'hara+alert@example.com"]);
  assert.equal(typeof payload.html, 'string');
  assert.equal(typeof payload.text, 'string');
  assert.match(payload.html, /&lt;img src=x onerror=&quot;alert\(&#39;x&#39;\)&quot;&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(payload.html, /<img src=x|javascript:/);
  assert.doesNotMatch(payload.subject, /[\r\n]/);
  assert.match(payload.text, /SKU: MUG-STN-SAGE/);
  assert.match(payload.text, /£18\.50/);
  assert.match(payload.html, /name="viewport"/);
  assert.match(payload.html, /width:100%;max-width:/);
  assert.match(payload.html, /http:\/\/127\.0\.0\.1:12345\/\?sku=MUG-STN-SAGE/);
  assert.match(payload.text, /does not reserve an item/);
});
