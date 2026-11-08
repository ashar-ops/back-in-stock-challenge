import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const demoDir = path.join(root, '.demo');
const appPort = Number(process.env.DEMO_PORT || 3000);
const harnessPort = Number(process.env.DEMO_HARNESS_PORT || 3001);
const appUrl = `http://localhost:${appPort}`;
const harnessUrl = `http://localhost:${harnessPort}`;
await mkdir(demoDir, { recursive: true });
const harness = spawn(process.execPath, [path.join(root, 'tools/harness.cjs')], {
  env: { ...process.env, PORT: String(harnessPort), PUBLIC_URL: harnessUrl, DATA_DIR: path.join(demoDir, 'harness'), SIM_INTERVAL_SECONDS: '15', ADMIN_PASSWORD: '', INVITE_CODE: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let app;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app?.stop();
  if (harness.exitCode === null) { const exited = once(harness, 'exit'); harness.kill(); await exited; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close().then(() => process.exit(0)));

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local harness did not start in time')), 10000);
    harness.once('error', reject);
    harness.once('exit', (code) => { clearTimeout(timeout); if (!closing) reject(new Error(`Local harness exited (${code})`)); });
    harness.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Harness on')) { clearTimeout(timeout); resolve(); }
    });
  });
  let session;
  try { session = JSON.parse(await readFile(path.join(demoDir, 'session.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let response = session ? await fetch(`${harnessUrl}${session.dashboard}`) : null;
  const fresh = !response?.ok;
  if (fresh) {
    response = await fetch(`${harnessUrl}/signup`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ name: 'Restock local demo' }) });
    if (response.status !== 303) throw new Error('Could not create a local sandbox candidate');
    session = { dashboard: response.headers.get('location') };
    response = await fetch(`${harnessUrl}${session.dashboard}`);
    const html = await response.text();
    for (const key of ['STOCK_API_KEY', 'RESEND_API_KEY', 'WEBHOOK_SECRET']) {
      const value = new RegExp(`${key}=([^\\s<]+)`).exec(html)?.[1];
      if (!value) throw new Error(`Local sandbox did not provide ${key}`);
      session[key] = value;
    }
    await writeFile(path.join(demoDir, 'session.json'), JSON.stringify(session, null, 2));
  }
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD || 'restock-demo';
  app = createApplication(loadConfig({
    ...session, PORT: String(appPort), HOST: '0.0.0.0', PUBLIC_URL: appUrl,
    STOCK_API_URL: `${harnessUrl}/api/stock`, RESEND_BASE_URL: harnessUrl,
    ADMIN_PASSWORD: adminPassword, DATA_DIR: path.join(demoDir, 'app'), RECONCILE_INTERVAL_MS: '10000',
  }));
  await app.start();
  const form = async (route, values) => {
    const response = await fetch(`${harnessUrl}${session.dashboard}/${route}`, { method: 'POST', body: new URLSearchParams(values) });
    if (!response.ok) throw new Error(`Sandbox action ${route} failed`);
  };
  await form('baseurl', { baseUrl: appUrl });
  if (fresh) {
    const items = ['MUG-STN-SAGE', 'KTL-GSN-BLK', 'THRW-WOL-OAT', 'TOTE-CNV-NAT', 'TEE-ORG-WHT-M', 'LAMP-DSK-BRS'];
    for (const [i, sku] of items.entries()) {
      await form('stock', { sku, quantity: i < 2 ? '5' : '0' });
      await fetch(`${appUrl}/api/requests`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${['alex', 'sam', 'robin', 'jamie', 'taylor', 'morgan'][i]}@example.com`, sku }),
      });
    }
  }
  console.log(`\nRestock demo is ready. All email stays in the local sandbox.\nApp: ${appUrl}\nEmbed: ${appUrl}/embed\nAdmin: ${appUrl}/admin\nLocal-only admin password: ${adminPassword}\nSandbox inbox and controls: ${harnessUrl}${session.dashboard}\nPersistent local demo data: ${demoDir}\nPress Ctrl+C to stop both services.\n`);
  harness.once('exit', () => { if (!closing) { console.error('Local sandbox stopped unexpectedly.'); void close().then(() => { process.exitCode = 1; }); } });
} catch (error) {
  console.error(`Demo startup failed: ${error.message}`);
  await close();
  process.exitCode = 1;
}
