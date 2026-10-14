import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
const root = process.cwd(), host = resolve(root, '../Anas');
const require = createRequire(join(host, 'package.json'));
const { _electron: electron } = require('playwright');
const { expect } = require('playwright/test');
const { pluginPage } = require('./scripts/electron-plugin-helpers.cjs');
const { closeElectronTestApplication } = require('./scripts/electron-test-close.cjs');
const config = JSON.parse(await readFile(join(root, '.local/rdp-test.json'), 'utf8'));
const trust = JSON.parse(await readFile(join(root, '.local/rdp-trust.json'), 'utf8'));
assert.equal(trust.target_key, createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex'));
const directory = await mkdtemp(join(tmpdir(), 'anas-rdp-sizing-'));
let app;
try {
  await mkdir(join(directory, 'documents'));
  await symlink(join(host, 'data'), join(directory, 'data'), 'junction');
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'anas-rdp-sizing', version: '1.0.0', main: 'main.cjs' }));
  await writeFile(join(directory, 'main.cjs'), `const {app,dialog}=require('electron');app.setAppPath(${JSON.stringify(host)});app.setPath('documents',${JSON.stringify(join(directory, 'documents'))});dialog.showErrorBox=()=>app.exit(1);app.on('browser-window-created',(_,w)=>w.once('show',()=>{w.firstShownSize=w.getContentSize()}));require(${JSON.stringify(join(host, 'out/main/index.js'))});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  app = await electron.launch({ executablePath: require('electron'), args: [directory, '--data-dir', join(directory, 'profile')], cwd: host, env, timeout: 45000 });
  const main = await app.firstWindow();
  await main.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  await main.evaluate(() => gale.config.updateSettings({ language: 'en' }));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, join(root, 'dist/PLUGIN.json'));
  await main.evaluate(() => gale.plugins.install());
  const backend = (method, params) => main.evaluate(({ method, params }) => gale.plugins.invoke('rdp', 'backend.call', { method, params }), { method, params });
  const profile = await backend('profiles.save', { ...config, name: 'Resolution verification', desktopWidth: 1280, desktopHeight: 800, adaptiveWindow: true, adaptiveSidebar: false, passwordAction: 'set', openMode: 'window' });
  await backend('trusts.save', { host: config.host, port: config.port ?? 3389, sha256: trust.certificate_sha256 });
  await backend('profiles.launch', { id: profile.id, revision: profile.revision });
  await main.evaluate(id => gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location: 'window' }), profile.id);
  const frame = await pluginPage(app, 'rdp', profile.id, 'window'), page = frame.page(), win = await app.browserWindow(page);
  const firstShown = await win.evaluate(w => w.firstShownSize);
  assert.equal(firstShown[0], 1280, 'Initial connection window is fitted while hidden');
  assert.ok(firstShown[1] >= 800);
  await expect(frame.locator('#status')).toHaveText('Connected', { timeout: 40000 });
  const remote = () => frame.locator('canvas').evaluate(c => [c.width, c.height]);
  const geometry = () => frame.evaluate(async () => {
    const context = await anas.getContext(), canvas = document.querySelector('canvas');
    const bounds = canvas.getBoundingClientRect();
    return { viewport: context.viewport, revision: context.windowResizeRevision,
      canvas: [bounds.width, bounds.height], devicePixelRatio };
  });
  await expect.poll(remote, { timeout: 15000 }).toEqual([1280, 800]);
  for (const zoom of [1, 1.1, 1.25, 1.5]) {
    await win.evaluate((w, zoom) => w.webContents.setZoomFactor(zoom), zoom);
    await page.waitForTimeout(500);
    for (const [width, height] of [[1600, 900], [1280, 800], [1600, 900]]) {
      await page.evaluate(id => panelWindow.invokeToolbarAction(id), `resolution-${width}-${height}`);
      await expect.poll(remote, { timeout: 15000 }).toEqual([width, height]);
      await page.waitForTimeout(800);
      assert.deepEqual(await remote(), [width, height]);
      const before = await geometry();
      assert.ok(Math.abs(before.canvas[0] - width) < 1 / 64 && Math.abs(before.canvas[1] - height) < 1 / 64,
        'Fitting must preserve the natural CSS canvas size, not shrink the selected desktop');
      await win.evaluate(w => { const [x, y] = w.getPosition(); w.setPosition(x + 1, y + 1); });
      await page.waitForTimeout(800);
      assert.deepEqual(await remote(), [width, height], 'Movement must not change resolution');
      assert.equal((await geometry()).revision, before.revision);
      console.log(JSON.stringify({ zoom, selected: [width, height], remote: await remote(), ...await geometry() }));
    }
  }
  for (const fullscreen of [false, true]) {
    await win.evaluate((w, full) => full ? w.setFullScreen(true) : w.maximize(), fullscreen);
    await page.waitForTimeout(800);
    await page.evaluate(() => panelWindow.invokeToolbarAction('resolution-1600-900'));
    await expect.poll(remote, { timeout: 15000 }).toEqual([1600, 900]);
    await page.waitForTimeout(800);
    assert.deepEqual(await remote(), [1600, 900]);
    console.log(JSON.stringify({ restoredFrom: fullscreen ? 'fullscreen' : 'maximized', remote: await remote() }));
  }
  if (process.platform === 'win32') {
    // Exercise Electron's real WM_SIZING -> WM_EXITSIZEMOVE path, without
    // synthesizing Electron events or moving the user's mouse.
    const koffi = require('koffi'), user32 = koffi.load('user32.dll');
    const getRect = user32.func('bool __stdcall GetWindowRect(uintptr_t, void*)');
    const send = user32.func('intptr_t __stdcall SendMessageW(uintptr_t, uint32_t, uintptr_t, void*)');
    const position = user32.func('bool __stdcall SetWindowPos(uintptr_t, uintptr_t, int, int, int, int, uint32_t)');
    const handle = BigInt(await win.evaluate(w => w.getNativeWindowHandle().readBigUInt64LE().toString()));
    const rect = Buffer.alloc(16);
    assert.ok(getRect(handle, rect));
    const beforeMove = await geometry(), beforeRemote = await remote();
    send(handle, 0x231, 0, null);
    send(handle, 0x216, 0, rect);
    assert.ok(position(handle, 0, rect.readInt32LE(0) + 2, rect.readInt32LE(4) + 2, 0, 0, 0x15));
    send(handle, 0x232, 0, null);
    await page.waitForTimeout(500);
    assert.deepEqual(await remote(), beforeRemote);
    assert.equal((await geometry()).revision, beforeMove.revision);
    assert.ok(getRect(handle, rect));
    rect.writeInt32LE(rect.readInt32LE(0) + 1200, 8); rect.writeInt32LE(rect.readInt32LE(4) + 800, 12);
    send(handle, 0x231, 0, null);
    send(handle, 0x214, 8, rect);
    assert.ok(position(handle, 0, rect.readInt32LE(0), rect.readInt32LE(4), 1200, 800, 0x14));
    send(handle, 0x232, 0, null);
  } else {
    // Native border dragging must additionally be verified on macOS.
    await win.evaluate(w => w.maximize());
  }
  await expect.poll(remote, { timeout: 15000 }).not.toEqual([1600, 900]);
  console.log(JSON.stringify({ resized: await remote(), ...await geometry() }));
  // Saving a fitted viewport must preserve its logical dimensions, not native
  // rounding: closing and restoring a live connection must not reintroduce +1.
  await page.evaluate(() => panelWindow.invokeToolbarAction('resolution-1600-900'));
  await expect.poll(remote, { timeout: 15000 }).toEqual([1600, 900]);
  const viewId = await frame.evaluate(async () => (await anas.getContext()).panelId);
  await main.evaluate(id => gale.panels.close(id), viewId);
  await main.evaluate(id => gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location: 'window' }), profile.id);
  const restored = await pluginPage(app, 'rdp', profile.id, 'window');
  await expect.poll(() => restored.locator('canvas').evaluate(c => [c.width, c.height]), { timeout: 15000 }).toEqual([1600, 900]);
  await expect(restored.page().getByRole('button', { name: 'Resize window (current 1600 × 900)', exact: true })).toBeEnabled();
  await restored.page().waitForTimeout(800);
  assert.deepEqual(await restored.locator('canvas').evaluate(c => [c.width, c.height]), [1600, 900]);
  const restoredWindow = await app.browserWindow(restored.page());
  await restoredWindow.evaluate(w => { w.webContents.setZoomFactor(1); w.setContentSize(900, 700); });
  await restored.page().waitForTimeout(500);
  const identity = await restored.evaluate(async () => (await anas.getContext()).pageId);
  await restored.page().getByRole('button', { name: 'Enter full screen', exact: true }).click();
  const grip = restored.page().locator('.panel-toolbar-grip');
  await expect(grip).toBeVisible();
  const beforeDrag = await restored.page().locator('.panel-window-titlebar').boundingBox();
  const gripBounds = await grip.boundingBox();
  const protocol = await restored.page().context().newCDPSession(restored);
  await protocol.send('Network.enable');
  const inputs = [];
  protocol.on('Network.webSocketFrameSent', event => {
    if (event.response.opcode === 1 && /"type":"input"/.test(event.response.payloadData)) inputs.push(event.response.payloadData);
  });
  await restored.page().mouse.move(gripBounds.x + gripBounds.width / 2, gripBounds.y + gripBounds.height / 2);
  await restored.page().mouse.down();
  await restored.page().mouse.move(gripBounds.x + 160, gripBounds.y + gripBounds.height / 2, { steps: 8 });
  await restored.page().mouse.up();
  assert.ok((await restored.page().locator('.panel-window-titlebar').boundingBox()).x > beforeDrag.x + 50);
  assert.equal(inputs.length, 0, 'Toolbar dragging must not send desktop input');
  await protocol.detach();
  await restored.page().getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await expect(grip).toHaveCount(0);
  assert.equal(await restored.evaluate(async () => (await anas.getContext()).pageId), identity);
  await restored.page().evaluate(() => panelWindow.invokeToolbarAction('input-text'));
  await expect(restored.locator('#text-input-dialog')).toBeVisible();
  await expect(restored.locator('#text-input-content')).toBeFocused();
  await restored.locator('#text-input-content').fill('中文输入 🐟\nDraft stays local until sent.');
  await mkdir(join(root, 'tmp'), { recursive: true });
  await restored.locator('#text-input-dialog').screenshot({ path: join(root, 'tmp/text-input-dialog.png') });
  await restored.getByRole('button', { name: 'Close', exact: true }).click();
  await restored.page().evaluate(() => panelWindow.invokeToolbarAction('input-text'));
  await expect(restored.locator('#text-input-content')).toHaveValue('中文输入 🐟\nDraft stays local until sent.');
  await restored.getByRole('button', { name: 'Close', exact: true }).click();
  console.log('Resolution sizing verification passed, including CSS canvas sizing and reopening.');
} catch (error) {
  let message = String(error?.stack ?? error);
  for (const value of [config.host, config.username, config.password]) if (value) message = message.split(value).join('[redacted]');
  console.error(message);
  process.exitCode = 1;
} finally {
  if (app) await closeElectronTestApplication(app);
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}
