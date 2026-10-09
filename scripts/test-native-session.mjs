import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, '../Anas/package.json'));
const { _electron: electron } = require('playwright');
const config = JSON.parse(await readFile(resolve(root, '.local/rdp-test.json'), 'utf8'));
// Reuse an already recorded trust; never accept a newly observed certificate here.
let pin;
try {
  const trust = JSON.parse(await readFile(resolve(root, '.local/rdp-trust.json'), 'utf8'));
  const targetKey = createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex');
  if (trust.target_key === targetKey) pin = trust.certificate_sha256;
} catch {}
if (!pin) {
  try {
    const profiles = JSON.parse(await readFile(resolve(process.env.HOME, '.galeAnas/plugins_data/rdp/profiles.json'), 'utf8'));
    pin = profiles.certificate_trust?.find(item => item.host === config.host && item.port === (config.port ?? 3389))?.sha256;
  } catch {}
}
await mkdir(resolve(root, '.local/native-proof'), { recursive: true });
await build({ entryPoints: [resolve(root, 'src/ui/desktop.ts')], bundle: true, format: 'esm', platform: 'browser',
  outfile: resolve(root, '.local/native-proof/desktop.js') });
const html = `<!doctype html><html><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;height:100vh"><script type="module">
import { Desktop } from '/desktop.js';
let desktop;
window.proof = {
  async attach(connection) { desktop = new Desktop(document.body, connection, value => window.displayState = value); await desktop.ready; },
  release() { desktop.release(); },
  dispose() { desktop.dispose(); },
  colors() { const c = desktop.canvas; const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const values = new Set(); for (let n = 0; n < data.length; n += 400) values.add(data[n]+','+data[n+1]+','+data[n+2]); return values.size; }
};
</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url === '/desktop.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(resolve(root, '.local/native-proof/desktop.js'))); }
  else { response.setHeader('Content-Type', 'text/html'); response.end(html); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const token = randomBytes(32).toString('hex');
const helper = spawn(resolve(root, 'native/target/debug/anas-rdp-session' + (process.platform === 'win32' ? '.exe' : '')), ['--session'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
helper.stderr.resume();
helper.stdin.on('error', () => {});
const events = [];
const pending = new Map();
let application;
const closed = new Promise(resolve => helper.on('close', resolve));
let finished = false;
closed.then(() => { finished = true; for (const entry of pending.values()) entry.reject(new Error('RDP_HELPER_CLOSED')); pending.clear(); });
const lines = createInterface({ input: helper.stdout });
const ready = new Promise((resolve, reject) => {
  helper.once('error', () => reject(new Error('RDP_HELPER_START')));
  helper.once('close', () => reject(new Error('RDP_HELPER_CLOSED')));
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.request) {
      const entry = pending.get(message.request);
      if (entry) { pending.delete(message.request); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); }
    } else {
      events.push(message.status);
      if (message.status === 'ready') resolve(message.port);
    }
  });
});
const command = (method, fields) => new Promise((resolve, reject) => {
  const request = randomUUID();
  const timer = setTimeout(() => { pending.delete(request); reject(new Error('RDP_COMMAND_TIMEOUT')); }, 5000);
  pending.set(request, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  helper.stdin.write(JSON.stringify({ request, method, ...fields }) + '\n');
});
const deadline = setTimeout(() => helper.kill(), 150000);
let result;
try {
  helper.stdin.write(JSON.stringify({ host: config.host, port: config.port ?? 3389, username: config.username,
    password: config.password, domain: config.domain ?? '', trusted_sha256: pin, origin, token }) + '\n');
  const port = await ready;
  const env = { ...process.env, RDP_TEST_URL: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [resolve(root, 'test/fixtures/electron.cjs')], env, timeout: 30000 });
  let page = await application.firstWindow();
  let owner = randomUUID();
  let lease = { owner: null, epoch: 0 };
  const connection = pageId => ({ url: 'ws://127.0.0.1:' + port + '/display', token, pageId });
  await page.waitForFunction(() => !!window.proof);
  await page.evaluate(value => window.proof.attach(value), connection(owner));
  lease = await command('claim', { page: owner, expected: lease.owner, expectedEpoch: lease.epoch });
  await page.waitForFunction(() => window.proof.colors() > 20);
  const colors = [await page.evaluate(() => window.proof.colors())];
  for (let n = 0; n < 4; n++) {
    const nextOwner = randomUUID();
    const created = application.waitForEvent('window');
    await application.evaluate(({ BrowserWindow }, url) => {
      const window = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      void window.loadURL(url);
    }, origin);
    const target = await created;
    await target.waitForFunction(() => !!window.proof);
    await target.evaluate(value => window.proof.attach(value), connection(nextOwner));
    colors.push(await target.evaluate(() => window.proof.colors()));
    lease = await command('claim', { page: nextOwner, expected: owner, expectedEpoch: lease.epoch });
    await assert.rejects(command('claim', { page: owner, expected: owner, expectedEpoch: lease.epoch - 1 }), /OWNERSHIP_CHANGED/);
    await page.close();
    page = target; owner = nextOwner;
  }
  // Shift changes no remote application content.
  await page.locator('canvas').focus();
  await page.keyboard.press('Shift');
  lease = await command('release', { expected: owner, expectedEpoch: lease.epoch });
  await page.evaluate(() => window.proof.dispose());
  await new Promise(resolve => setTimeout(resolve, 1500));
  await page.reload();
  await page.waitForFunction(() => !!window.proof);
  owner = randomUUID();
  await page.evaluate(value => window.proof.attach(value), connection(owner));
  colors.push(await page.evaluate(() => window.proof.colors()));
  lease = await command('claim', { page: owner, expected: null, expectedEpoch: lease.epoch });
  assert.equal(events.filter(value => value === 'connected').length, 1);
  assert.equal(events.includes('connection_failed'), false);
  assert.equal(events.includes('closed'), false);
  assert.equal(colors.every(value => value > 20), true);
  result = { passed: true, authenticated_connections: 1, rebuilt_pages: 5, sampled_colors: colors, stale_claim_rejected: true, no_page_interval_ms: 1500, events };
  helper.stdin.end();
  await closed;
  console.log('Native RDP: one authentication, four cross-window replacements, one no-page reattachment, stale input claim rejected.');
} catch (error) {
  let message = String(error);
  for (const secret of [config.host, config.username, config.password, token]) if (secret) message = message.replaceAll(secret, '[redacted]');
  result = { passed: false, error: message, events };
  console.error('Native RDP verification failed; redacted result is in .local/native-proof/result.json.');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await application?.close().catch(() => {});
  if (!finished) { helper.stdin.end(); helper.kill(); }
  await closed;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(root, '.local/native-proof/result.json'), JSON.stringify(result, null, 2) + '\n');
}
