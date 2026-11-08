import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const base = process.env.BROWSER_TEST_URL || 'http://localhost:3000';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Browser checks only create sandbox data on localhost.');
const moduleDir = (process.env.PATH || process.env.Path || '').split(path.delimiter).map((p) => path.resolve(p, '../playwright')).find((p) => existsSync(path.join(p, 'package.json')));
if (!moduleDir) throw new Error('Run with: npm exec --yes --package=playwright -- node tools/browser-check.js');
const { chromium } = createRequire(import.meta.url)(moduleDir);
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const email = `browser-${Date.now()}@example.com`;

async function noOverflow(label) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, `${label} overflow: ${JSON.stringify(dimensions)}`);
}
async function expectText(locator, pattern) {
  await locator.filter({ hasText: pattern }).first().waitFor({ state: 'visible' });
}

try {
  await page.goto(base);
  await page.locator('.product-card').first().waitFor();
  assert.equal(await page.locator('.product-card').count(), 20);
  await noOverflow('Desktop storefront');
  await page.screenshot({ path: 'artifacts/storefront-desktop.png', fullPage: true });
  await page.getByRole('button', { name: /^Set a stock alert for/ }).first().click();
  const embedded = page.frameLocator('iframe');
  assert.ok(await embedded.locator('input[name="sku"]').inputValue());
  await embedded.locator('input[name="sku"]').fill('BROWSER-CHECK');
  await embedded.getByRole('textbox', { name: /Email address/i }).fill(email);
  const firstResponse = page.waitForResponse((r) => r.url().endsWith('/api/requests') && r.request().method() === 'POST');
  await embedded.getByRole('button', { name: /Notify me/i }).click();
  assert.equal((await firstResponse).status(), 201);
  await expectText(embedded.locator('body'), /on the list|request.*saved|all set/i);
  assert.equal(await embedded.locator('input[name="sku"]').inputValue(), 'BROWSER-CHECK');
  await embedded.getByRole('textbox', { name: /Email address/i }).fill(email);
  const duplicateResponse = page.waitForResponse((r) => r.url().endsWith('/api/requests'));
  await embedded.getByRole('button', { name: /Notify me/i }).click();
  assert.equal((await duplicateResponse).status(), 200);
  await expectText(embedded.locator('body'), /already/i);

  await page.goto(`${base}/embed?sku=BROWSER-CHECK`);
  await page.getByRole('textbox', { name: /Email address/i }).fill(email);
  await page.route('**/api/requests', (route) => route.abort('failed'));
  await page.getByRole('button', { name: /Notify me/i }).click();
  await expectText(page.locator('body'), /connect|connection|network|reach/i);
  assert.equal(await page.getByRole('button', { name: /Notify me/i }).isEnabled(), true);
  await page.unroute('**/api/requests');
  await page.route('**/api/requests', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many attempts. Please try again later.' }) }));
  await page.getByRole('button', { name: /Notify me/i }).click();
  await expectText(page.locator('body'), /Too many attempts/);
  await page.unroute('**/api/requests');
  await page.goto(`${base}/embed?sku=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.ok((await page.locator('input[name="sku"]').inputValue()).includes('<img'));

  await page.goto('http://127.0.0.1:3001');
  await page.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.id = 'cross-origin-check';
    frame.src = src;
    frame.width = '320';
    frame.height = '650';
    document.body.replaceChildren(frame);
  }, `${base}/embed?sku=BROWSER-CHECK`);
  const externalEmbed = page.frameLocator('#cross-origin-check');
  await externalEmbed.getByRole('textbox', { name: /Email address/i }).fill(email);
  const framedResponse = page.waitForResponse((r) => r.url().endsWith('/api/requests'));
  await externalEmbed.getByRole('button', { name: /Notify me/i }).click();
  assert.equal((await framedResponse).status(), 200);
  await expectText(externalEmbed.locator('body'), /already/i);

  await page.goto(`${base}/admin`);
  assert.ok(page.url().endsWith('/admin/login'));
  await page.getByRole('textbox', { name: 'Admin password', exact: true }).fill('incorrect');
  await page.getByRole('button', { name: /Sign in to dashboard/ }).click();
  await expectText(page.locator('body'), /not correct|incorrect/i);
  await page.getByRole('textbox', { name: 'Admin password', exact: true }).fill(process.env.DEMO_ADMIN_PASSWORD || 'restock-demo');
  await page.getByRole('button', { name: /Sign in to dashboard/ }).click();
  await page.waitForURL(`${base}/admin`);
  await page.getByRole('heading', { name: 'Your restock overview.' }).waitFor();
  await page.getByRole('searchbox', { name: 'Search email or product SKU' }).fill(email);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expectText(page.locator('tbody'), new RegExp(email.replace(/[.]/g, '\\.')));
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('notified');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expectText(page.locator('body'), /No .*requests|Nothing .*yet|No matches/i);
  await page.getByRole('searchbox', { name: 'Search email or product SKU' }).fill('');
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expectText(page.locator('tbody'), /example\.com/);
  await noOverflow('Desktop admin');
  await page.screenshot({ path: 'artifacts/admin-desktop.png', fullPage: true });

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflow(`Admin ${width}px`);
    await page.screenshot({ path: `artifacts/admin-${width}.png`, fullPage: true });
    for (const [route, name] of [['/', 'storefront'], ['/embed?sku=MUG-STN-SAGE', 'embed'], ['/admin/email-preview', 'email']]) {
      await page.goto(`${base}${route}`);
      if (route === '/') await page.locator('.product-card').first().waitFor();
      await noOverflow(`${name} ${width}px`);
      await page.screenshot({ path: `artifacts/${name}-${width}.png`, fullPage: true });
    }
    await page.goto(`${base}/admin`);
    await page.getByRole('heading', { name: 'Your restock overview.' }).waitFor();
  }
  let retryState = 'attention';
  let retryCalls = 0;
  await page.route('**/api/admin/requests?*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      requests: [{ id: 'browser-attention', email: 'review@example.com', sku: 'BROWSER-CHECK', status: retryState, attempts: 1, created_at: new Date().toISOString(), notified_at: null, next_attempt_at: new Date().toISOString(), last_error: 'Email provider returned HTTP 422' }],
      total: 1, page: 1, pageSize: 20, stats: { total: 1, waiting: 0, queued: 0, retrying: retryState === 'retrying' ? 1 : 0, notified: 0, attention: retryState === 'attention' ? 1 : 0 },
    }),
  }));
  await page.route('**/api/admin/retry', (route) => {
    retryCalls++;
    retryState = 'retrying';
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await page.getByRole('button', { name: /Review and retry request/ }).click();
  await page.getByRole('dialog').waitFor();
  await noOverflow('Mobile retry dialog');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(retryCalls, 0);
  await page.getByRole('button', { name: /Review and retry request/ }).click();
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await expectText(page.locator('tbody'), /Automatic retry/);
  assert.equal(retryCalls, 1);
  await page.unroute('**/api/admin/requests?*');
  await page.unroute('**/api/admin/retry');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(`${base}/admin/login`);
  assert.equal((await page.request.get(`${base}/api/admin/requests`)).status(), 401);

  await page.route('**/api/catalog', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The catalogue is temporarily unavailable.' }) }));
  await page.goto(base);
  await expectText(page.locator('body'), /brief pause in browsing|couldn’t load the collection/i);
  await page.frameLocator('iframe').locator('input[name="sku"]').waitFor();
  await page.unroute('**/api/catalog');
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: real signup and duplicate, cross-origin iframe, form network/rate errors, product selection, login/logout, filters, retry confirmation/cancellation, catalogue outage, XSS input, and desktop/390px/320px layouts.');
} finally {
  await browser.close();
}
