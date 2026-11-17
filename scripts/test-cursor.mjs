import { execFileSync } from 'node:child_process';
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
assert.equal(process.platform, 'darwin', 'This regression test inspects the native macOS cursor.');
await mkdir(join(root, 'tmp/cursor-proof'), { recursive: true });
const probe = join(root, 'tmp/cursor-proof/native');
execFileSync('swiftc', [join(root, 'scripts/macos-cursor-probe.swift'), '-o', probe]);
const nativeCursor = (...position) => JSON.parse(execFileSync(probe, position.map(String), { encoding: 'utf8' }));
const originalPointer = nativeCursor();
const directory = await mkdtemp(join(tmpdir(), 'anas-rdp-cursor-'));
let app;
try {
  await mkdir(join(directory, 'documents'));
  await symlink(join(host, 'data'), join(directory, 'data'), 'junction');
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'anas-rdp-cursor', version: '1.0.0', main: 'main.cjs' }));
  await writeFile(join(directory, 'main.cjs'), `const {app,dialog}=require('electron');app.setAppPath(${JSON.stringify(host)});app.setPath('documents',${JSON.stringify(join(directory, 'documents'))});dialog.showErrorBox=()=>app.exit(1);require(${JSON.stringify(join(host, 'out/main/index.js'))});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  app = await electron.launch({ executablePath: require('electron'), args: [directory, '--data-dir', join(directory, 'profile')], cwd: host, env, timeout: 45000 });
  const main = await app.firstWindow();
  await main.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  await main.evaluate(() => gale.config.updateSettings({ language: 'en' }));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, join(root, 'dist/PLUGIN.json'));
  await main.evaluate(() => gale.plugins.install());
  const backend = (method, params) => main.evaluate(({ method, params }) => gale.plugins.invoke('rdp', 'backend.call', { method, params }), { method, params });
  const profile = await backend('profiles.save', { ...config, name: 'Cursor verification', desktopWidth: 1280, desktopHeight: 800, adaptiveWindow: false, adaptiveSidebar: false, passwordAction: 'set', openMode: 'window' });
  await backend('trusts.save', { host: config.host, port: config.port ?? 3389, sha256: trust.certificate_sha256 });
  await backend('profiles.launch', { id: profile.id, revision: profile.revision });
  await main.evaluate(id => gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location: 'window' }), profile.id);
  let frame = await pluginPage(app, 'rdp', profile.id, 'window');

  await expect(frame.locator('#status')).toHaveText('Connected', { timeout: 40000 });
  assert.equal(await frame.evaluate(() => typeof anas.onPointerLeave), 'function', 'Build the host with the native pointer-leave API first');
  const originalSession = await backend('find', { owner: profile.id });
  const exercise = async (frame, location) => {
    const page = frame.page(), win = await app.browserWindow(page);
    await app.evaluate(({ app }) => app.focus({ steal: true }));
    await page.bringToFront();
    await win.evaluate(w => w.focus());
    const bounds = await win.evaluate(w => w.getContentBounds());
    const canvas = frame.locator('canvas'), box = await canvas.boundingBox();
    const inside = [bounds.x + box.x + box.width / 2, bounds.y + box.y + box.height / 2];
    const outside = [bounds.x - 30, bounds.y + 100];
    for (let round = 0; round < 3; round++) {
      assert.equal(nativeCursor(...inside).opaquePixels, 0, `${location}: remote desktop hides the native cursor`);
      await expect(canvas).toHaveCSS('cursor', 'none');
      assert.ok(nativeCursor(...outside).opaquePixels > 0, `${location}: outside must restore the native cursor`);
      await expect(canvas).toHaveCSS('cursor', 'default');
      assert.equal(nativeCursor(...inside).opaquePixels, 0, `${location}: re-entry must hide the native cursor again`);
      assert.equal(nativeCursor(inside[0] + 15, inside[1] + 10).opaquePixels, 0, `${location}: continuing to move must keep it hidden`);
    }
    assert.equal(nativeCursor(...outside, ...inside, inside[0] + 15, inside[1] + 10).opaquePixels, 0,
      `${location}: a rapid exit/re-entry must not leave a stale native cursor`);
    // Titlebar/header controls must keep an ordinary visible cursor.
    assert.ok(nativeCursor(bounds.x + 100, bounds.y + 12).opaquePixels > 0);
    assert.equal(nativeCursor(...inside).opaquePixels, 0);
    assert.equal((await backend('find', { owner: profile.id })).id, originalSession.id);
    console.log(`${location}: native cursor hides after three exits/re-entries and continued motion; controls restore it.`);
  };
  await exercise(frame, 'window');
  await frame.page().evaluate(() => panelWindow.invokeToolbarAction('ui-lock'));
  await expect(frame.locator('canvas')).toHaveCSS('cursor', 'not-allowed');
  const lockedBox = await frame.locator('canvas').boundingBox();
  const lockedWin = await app.browserWindow(frame.page());
  const lockedBounds = await lockedWin.evaluate(w => w.getContentBounds());
  assert.ok(nativeCursor(lockedBounds.x + lockedBox.x + 100, lockedBounds.y + lockedBox.y + 100).opaquePixels > 0);
  await frame.page().evaluate(() => panelWindow.invokeToolbarAction('ui-lock'));
  await expect(frame.locator('canvas')).toHaveCSS('cursor', 'none');
  await frame.evaluate(id => { void anas.moveView({ instanceId: id, location: 'sidebar' }); }, profile.id);
  frame = await pluginPage(app, 'rdp', profile.id, 'sidebar');
  await expect(frame.locator('#status')).toHaveText('Connected');
  await exercise(frame, 'sidebar');
  await main.evaluate(() => gale.plugins.stopBackend('rdp'));
  await expect.poll(() => backend('find', { owner: profile.id })).toBe(null);
  console.log('Input lock, same-session handoff and backend stop passed.');
} catch (error) {
  let message = String(error?.stack ?? error);
  for (const value of [config.host, config.username, config.password]) if (value) message = message.split(value).join('[redacted]');
  console.error(message); process.exitCode = 1;
} finally {
  await closeElectronTestApplication(app);
  nativeCursor(originalPointer.x, originalPointer.y);
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}
