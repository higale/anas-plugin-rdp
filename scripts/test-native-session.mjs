import { homedir } from 'node:os';
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
    const profiles = JSON.parse(await readFile(resolve(homedir(), '.galeAnas/plugins_data/rdp/profiles.json'), 'utf8'));
    pin = profiles.certificate_trust?.find(item => item.host === config.host && item.port === (config.port ?? 3389))?.sha256;
  } catch {}
}
assert.ok(pin, 'A previously verified certificate is required.');
await mkdir(resolve(root, 'tmp/native-proof'), { recursive: true });
await build({ entryPoints: [resolve(root, 'src/ui/desktop.ts')], bundle: true, format: 'esm', platform: 'browser',
  outfile: resolve(root, 'tmp/native-proof/desktop.js') });
const html = `<!doctype html><html><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;height:100vh"><script type="module">
import { Desktop } from '/desktop.js';
let desktop;
window.proof = {
  async attach(connection) { desktop = new Desktop(document.body, connection, (value, locked) => { window.displayState = value; window.uiLocked = locked; }); await desktop.ready; },
  localState() { return { locked: desktop.uiLocked, revision: desktop.uiRevision }; },
  raw(message, revision) { desktop.socket.send(JSON.stringify({ ...message, epoch: desktop.epoch, uiRevision: revision ?? desktop.uiRevision })); },
  release() { desktop.release(); },
  dispose() { desktop.dispose(); },
  colors() { const c = desktop.canvas; const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const values = new Set(); for (let n = 0; n < data.length; n += 400) values.add(data[n]+','+data[n+1]+','+data[n+2]); return values.size; }
};
</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url === '/desktop.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(resolve(root, 'tmp/native-proof/desktop.js'))); }
  else { response.setHeader('Content-Type', 'text/html'); response.end(html); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const token = randomBytes(32).toString('hex');
const helper = spawn(resolve(root, 'dist/native', process.platform + '-' + process.arch, 'anas-rdp-session' + (process.platform === 'win32' ? '.exe' : '')), ['--session'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
  const capture = async (includeCursor = true) => {
    const deadline = Date.now() + 35000;
    while (true) {
      try {
        const blocks = await command('screenshot', { includeCursor });
        assert.equal(blocks[0].type, 'text');
        assert.equal(blocks[1].type, 'image');
        assert.equal(blocks[1].mimeType, 'image/png');
        const meta = JSON.parse(blocks[0].text), png = Buffer.from(blocks[1].data, 'base64');
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(png.readUInt32BE(16), meta.width);
        assert.equal(png.readUInt32BE(20), meta.height);
        assert.ok(meta.width > 0 && meta.height > 0 && meta.frame_revision > 0 && meta.frame_time > 0);
        assert.equal(meta.coordinate_system, 'desktop_pixels');
        assert.equal(meta.state, 'connected');
        assert.equal(meta.stale, false);
        if (!includeCursor) assert.equal(meta.cursor_drawn, false);
        return { meta, data: blocks[1].data };
      } catch (error) {
        if (error.message !== 'RDP_FRAME_UNAVAILABLE' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  };
  // Authenticate and capture the complete desktop before any display attaches.
  let initialShot = await capture(false);
  const env = { ...process.env, RDP_TEST_URL: origin };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: require('electron'), args: [resolve(root, 'test/fixtures/electron.cjs')], env, timeout: 30000 });
  const decode = base64 => application.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const pixels = image.toBitmap(), colors = new Set();
    for (let n = 0; n < pixels.length; n += 400) colors.add(pixels[n] + ',' + pixels[n + 1] + ',' + pixels[n + 2]);
    return { size: image.getSize(), colors: colors.size };
  }, base64);
  let decoded = await decode(initialShot.data);
  for (let n = 0; decoded.colors <= 20 && n < 100; n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    initialShot = await capture(false); decoded = await decode(initialShot.data);
  }
  assert.deepEqual(decoded.size, { width: initialShot.meta.width, height: initialShot.meta.height });
  assert.ok(decoded.colors > 20);
  let page = await application.firstWindow();
  let owner = randomUUID();
  let lease = { owner: null, epoch: 0 };
  const connection = pageId => ({ url: 'ws://127.0.0.1:' + port + '/display', token, pageId });
  await page.waitForFunction(() => !!window.proof);
  await page.evaluate(value => window.proof.attach(value), connection(owner));
  lease = await command('claim', { page: owner, expected: lease.owner, expectedEpoch: lease.epoch });
  await page.waitForFunction(() => window.proof.colors() > 20);
  const colors = [await page.evaluate(() => window.proof.colors())];
  const before = await capture(false);
  await assert.rejects(command('input', { actions: [{ type: 'move', x: before.meta.width, y: 0 }] }), /RDP_INVALID_INPUT/);
  assert.equal((await capture(false)).meta.input_revision, before.meta.input_revision);
  const inputResult = await command('input', { actions: [
    { type: 'move', x: 50, y: 50 }, { type: 'key', code: 42, down: true }
  ] });
  assert.equal(inputResult.accepted, true);
  assert.deepEqual(await command('lease', {}), lease, 'Tool input must not change the active display page.');
  assert.equal((await command('input', { actions: [{type:'move',x:51,y:51}] })).accepted, true);
  await page.waitForTimeout(250);
  const beforeUser = (await capture(false)).meta.input_revision;
  // A user can immediately enter input after a tool call, without a takeover click.
  await page.locator('canvas').focus();
  await page.keyboard.press('Shift');
  for (let n = 0; n < 50 && (await capture(false)).meta.input_revision <= beforeUser; n++) await page.waitForTimeout(50);
  assert.ok((await capture(false)).meta.input_revision > beforeUser);
  assert.equal((await command('input', { actions: [{type:'move',x:52,y:52}] })).accepted, true);
  assert.deepEqual(await command('lease', {}), lease);

  // Freeze the UI even when it sends directly, and reject queued input after unlock.
  const originalUi = await page.evaluate(() => window.proof.localState());
  assert.equal(originalUi.locked, false);
  await page.keyboard.down('Shift');
  await command('setUiLocked', { locked: true });
  await page.waitForFunction(() => window.uiLocked === true);
  const lockedRevision = await page.evaluate(() => window.proof.localState().revision);
  await command('setUiLocked', { locked: true });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.proof.localState().revision), lockedRevision, 'Repeated lock must be idempotent.');
  const beforeLocked = (await capture(false)).meta.input_revision;
  await page.evaluate(() => {
    window.proof.raw({ type: 'key', code: 42, down: true });
    window.proof.raw({ type: 'mouse', flags: 0x0800, wheel: 0, x: 42, y: 42 });
    window.proof.raw({ type: 'takeover' });
  });
  await page.keyboard.up('Shift');
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(150);
  assert.equal((await capture(false)).meta.input_revision, beforeLocked, 'Locked UI input must not reach RDP.');
  assert.equal((await command('input', { actions: [{type:'move',x:53,y:53}] })).accepted, true);
  assert.equal((await capture(false)).meta.ui_locked, true);
  await command('setUiLocked', { locked: false });
  await page.waitForFunction(() => window.uiLocked === false);
  const beforeStale = (await capture(false)).meta.input_revision;
  await page.evaluate(revisions => { for (const revision of revisions) window.proof.raw({ type: 'key', code: 42, down: true }, revision); }, [originalUi.revision, lockedRevision]);
  await page.waitForTimeout(150);
  assert.equal((await capture(false)).meta.input_revision, beforeStale, 'Unlock must not replay events from before/during the lock.');
  await page.keyboard.press('Shift');
  await page.waitForTimeout(150);
  assert.ok((await capture(false)).meta.input_revision > beforeStale);
  assert.deepEqual(await command('lease', {}), lease, 'Lock changes must not change page ownership.');
  await command('setUiLocked', { locked: true });

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
    await target.waitForFunction(() => window.uiLocked === true);
    colors.push(await target.evaluate(() => window.proof.colors()));
    lease = await command('claim', { page: nextOwner, expected: owner, expectedEpoch: lease.epoch });
    await assert.rejects(command('claim', { page: owner, expected: owner, expectedEpoch: lease.epoch - 1 }), /OWNERSHIP_CHANGED/);
    await page.close();
    page = target; owner = nextOwner;
  }
  await command('setUiLocked', { locked: false });
  await page.waitForFunction(() => window.uiLocked === false);
  // Shift changes no remote application content.
  await page.locator('canvas').focus();
  await page.locator('canvas').hover();
  await page.keyboard.press('Shift');
  const afterInput = await capture();
  assert.ok(afterInput.meta.input_revision > initialShot.meta.input_revision);
  assert.ok(afterInput.meta.cursor_position);
  assert.ok(afterInput.meta.cursor_revision > 0);
  lease = await command('release', { expected: owner, expectedEpoch: lease.epoch });
  await page.evaluate(() => window.proof.dispose());
  await new Promise(resolve => setTimeout(resolve, 1500));
  const detachedShot = await capture(false);
  assert.ok(detachedShot.meta.frame_revision >= initialShot.meta.frame_revision);
  await page.reload();
  await page.waitForFunction(() => !!window.proof);
  owner = randomUUID();
  await page.evaluate(value => window.proof.attach(value), connection(owner));
  colors.push(await page.evaluate(() => window.proof.colors()));
  lease = await command('claim', { page: owner, expected: null, expectedEpoch: lease.epoch });
  assert.equal(events.filter(value => value === 'connected').length, 1);
  assert.equal(events.includes('connection_failed'), false);
  assert.equal(events.includes('closed'), false);
  assert.equal(colors.every(value => value > 20), true, `Every attached display must show the desktop: ${colors.join(', ')}`);
  result = { passed: true, authenticated_connections: 1, rebuilt_pages: 5, sampled_colors: colors, stale_claim_rejected: true,
    no_page_interval_ms: 1500, no_page_screenshots: 2, screenshot_dimensions: decoded.size, screenshot_colors: decoded.colors, input_metadata_verified: true, independent_tool_and_page_input_verified: true, local_input_lock_verified: true, events };
  helper.stdin.end();
  await closed;
  console.log('Native RDP: one authentication, four cross-window replacements, two no-page screenshots, one reattachment, independent tool/page input and stale page claims verified.');
} catch (error) {
  let message = error instanceof Error ? error.stack ?? String(error) : String(error);
  for (const secret of [config.host, config.username, config.password, token]) if (secret) message = message.replaceAll(secret, '[redacted]');
  result = { passed: false, error: message, events };
  console.error('Native RDP verification failed; redacted result is in tmp/native-proof/result.json.');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await application?.close().catch(() => {});
  if (!finished) { helper.stdin.end(); helper.kill(); }
  await closed;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(root, 'tmp/native-proof/result.json'), JSON.stringify(result, null, 2) + '\n');
}
