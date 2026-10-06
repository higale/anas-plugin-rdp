import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Integration uses the adjacent host's installed Electron and test driver.
const hostRequire = createRequire(resolve(root, '../Anas/package.json'));
const { _electron: electron } = hostRequire('playwright');
const config = JSON.parse(await readFile(resolve(root, '.local/rdp-test.json'), 'utf8'));
const trust = JSON.parse(await readFile(resolve(root, '.local/rdp-trust.json'), 'utf8'));
const targetKey = createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex');
assert.equal(trust.target_key, targetKey, 'Trust must match the test target.');
const routes = new Map([
  ['/', ['test/fixtures/desktop.html', 'text/html']],
  ['/driver.js', ['test/fixtures/driver.js', 'text/javascript']],
  ['/desktop.js', ['artifacts/upstream/iron-remote-desktop/iron-remote-desktop.js', 'text/javascript']],
  ['/rdp.js', ['artifacts/upstream/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js', 'text/javascript']],
  ['/ironrdp_web_bg.wasm', ['artifacts/upstream/iron-remote-desktop-rdp/ironrdp_web_bg.wasm', 'application/wasm']],
]);
const server = createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data: blob:");
  const route = routes.get(request.url);
  if (!route) { response.writeHead(404).end(); return; }
  try { response.setHeader('Content-Type', route[1]); response.end(await readFile(resolve(root, route[0]))); }
  catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const token = randomBytes(32).toString('hex');
const helper = spawn(resolve(root, `native/target/debug/anas-rdp-bridge${process.platform === 'win32' ? '.exe' : ''}`), ['--serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const events = [];
helper.stderr.resume();
let application;
const closed = new Promise(resolve => helper.on('close', resolve));
const lines = createInterface({ input: helper.stdout });
const ready = new Promise((resolve, reject) => {
  helper.on('error', reject);
  helper.on('close', () => reject(new Error('Bridge exited before becoming ready.')));
  lines.on('line', line => { const event = JSON.parse(line); events.push(event); if (event.status === 'ready') resolve(event); });
});
const deadline = setTimeout(() => helper.kill(), 90_000);
try {
  helper.stdin.write(JSON.stringify({ host: config.host, port: config.port ?? 3389, trusted_sha256: trust.certificate_sha256, origin, token }) + '\n');
  const { port } = await ready;
  const env = { ...process.env, RDP_TEST_URL: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: hostRequire('electron'), args: [resolve(root, 'test/fixtures/electron.cjs')], env, timeout: 30_000 });
  const page = await application.firstWindow();
  await page.waitForFunction(() => !!window.rdpTest, null, { timeout: 15_000 });
  const result = await page.evaluate(config => window.rdpTest.connect(config), { ...config, port: config.port ?? 3389, proxy: `ws://127.0.0.1:${port}/rdp`, token });
  assert.equal(result.connected, true, `Connection failed: ${result.kind}`);
  await page.waitForFunction(() => window.rdpTest.pixels() > 20, null, { timeout: 20_000 });
  const colors = await page.evaluate(() => window.rdpTest.pixels());
  // Move the pointer and press/release Shift without changing remote application content.
  const canvas = page.locator('iron-remote-desktop').locator('canvas');
  await canvas.hover();
  await page.keyboard.press('Shift');
  await page.evaluate(() => window.rdpTest.disconnect());
  await closed;
  await writeFile(resolve(root, '.local/live-result.json'), JSON.stringify({ connected: true, sampled_colors: colors, input_sent: ['pointer_move', 'shift'], events: events.map(event => event.status) }, null, 2) + '\n');
  console.log('Live Electron RDP passed: authenticated, desktop pixels received, pointer/Shift sent, disconnected and helper exited.');
} catch (error) {
  await writeFile(resolve(root, '.local/live-result.json'), JSON.stringify({ connected: false, error: String(error).replaceAll(config.host, '[target]').replaceAll(config.username, '[user]').replaceAll(config.password, '[secret]'), events: events.map(event => event.status) }, null, 2) + '\n');
  console.error('Live test failed. Redacted details saved to .local/live-result.json.');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await application?.close().catch(() => {});
  helper.stdin.end();
  helper.kill();
  await closed;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
