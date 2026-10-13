import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, appendFile, mkdir, cp, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { verifyToolCalls } from './test-tool-calls.mjs';

const root = process.cwd(), host = resolve(root, '../Anas');
const require = createRequire(join(host, 'package.json'));
const { _electron: electron } = require('playwright');
const { expect } = require('playwright/test');
const { closeElectronTestApplication } = require('./scripts/electron-test-close.cjs');
const config = JSON.parse(await readFile(join(root, '.local/rdp-test.json'), 'utf8'));
let pin;
try {
  const trust = JSON.parse(await readFile(join(root, '.local/rdp-trust.json'), 'utf8'));
  if (trust.target_key === createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex')) pin = trust.certificate_sha256;
} catch {}
if (!pin) {
  const data = JSON.parse(await readFile(resolve(homedir(), '.galeAnas/plugins_data/rdp/profiles.json'), 'utf8'));
  pin = data.certificate_trust?.find(item => item.host === config.host && item.port === (config.port ?? 3389))?.sha256;
}
assert.ok(pin, 'A previously verified certificate is required.');
await mkdir(join(root, 'tmp/host-proof'), { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'anas-rdp-handoff-'));
let app, phase = 'prepare';
try {
  const pkg = join(directory, 'package');
  await mkdir(pkg);
  await build({ entryPoints: [join(root, 'src/ui/app.ts')], bundle: true, format: 'esm', platform: 'browser', outfile: join(pkg, 'app.js') });
  await build({ entryPoints: [join(root, 'src/backend.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: join(pkg, 'backend.cjs') });
  const inputEventsFile = join(directory, 'input-events.jsonl');
  await writeFile(inputEventsFile, '');
  // Observe the real handler's cancellation and receipt, without changing its execution.
  await appendFile(join(pkg, 'backend.cjs'), `
const originalInput = module.exports.tools.input;
module.exports.tools.input = async (params, context) => {
  const record = event => require('node:fs').appendFileSync(${JSON.stringify(inputEventsFile)}, JSON.stringify({ ...event, at: Date.now() }) + '\\n');
  const abort = () => record({ event: 'cancelled' });
  context.signal.addEventListener('abort', abort, { once: true });
  record({ event: 'started' });
  try {
    const result = await originalInput(params, context);
    record({ event: 'completed', accepted: result.accepted });
    return result;
  } catch (error) {
    record({ event: 'failed', error: String(error.message) });
    throw error;
  } finally { context.signal.removeEventListener('abort', abort); }
};
`);
  for (const file of ['index.html', 'style.css']) await cp(join(root, 'src/ui', file), join(pkg, file));
  await cp(join(root, 'lang'), join(pkg, 'lang'), { recursive: true });
  await cp(join(root, 'skills'), join(pkg, 'skills'), { recursive: true });
  await cp(join(root, 'assets'), join(pkg, 'assets'), { recursive: true });
  const native = join(pkg, 'native', process.platform + '-' + process.arch);
  await mkdir(native, { recursive: true });
  const binary = 'anas-rdp-session' + (process.platform === 'win32' ? '.exe' : '');
  await cp(join(root, 'dist/native', process.platform + '-' + process.arch, binary), join(native, binary));
  if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--sign', '-', join(native, binary)], { stdio: 'ignore' });
  await writeFile(join(pkg, 'PLUGIN.json'), JSON.stringify({ ...JSON.parse(await readFile(join(root, 'dist/PLUGIN.json'), 'utf8')),
    tools: JSON.parse(await readFile(join(root, 'tools.json'), 'utf8')) }));
  await mkdir(join(directory, 'documents'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'anas-rdp-test', version: '1.0.0', main: 'main.cjs' }));
  await cp(join(host, 'data'), join(directory, 'data'), { recursive: true });
  await writeFile(join(directory, 'main.cjs'), `const {app,dialog}=require('electron'); app.setAppPath(${JSON.stringify(host)}); app.setPath('documents',${JSON.stringify(join(directory, 'documents'))}); dialog.showErrorBox=()=>app.exit(1); require(${JSON.stringify(join(host, 'out/main/index.js'))});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  app = await electron.launch({ executablePath: require('electron'), args: [directory, '--data-dir', join(directory, 'data-profile')], cwd: host, env, timeout: 45000 });
  const main = await app.firstWindow();
  await main.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  await main.evaluate(() => gale.config.updateSettings({ language: 'en', theme: 'dark' }));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, join(pkg, 'PLUGIN.json'));
  await main.evaluate(() => gale.plugins.install());
  const backend = (method, params) => main.evaluate(({ method, params }) => gale.plugins.invoke('rdp', 'backend.call', { method, params }), { method, params });
  phase = 'connect';
  const profile = await backend('profiles.save', { ...config, name: 'Handoff verification', clipboardSupport: true, passwordAction: 'set', openMode: 'sidebar', runInBackground: true });
  await backend('trusts.save', { host: config.host, port: config.port ?? 3389, sha256: pin });
  await backend('profiles.launch', { id: profile.id, revision: profile.revision });
  await main.evaluate(id => gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location: 'sidebar', title: 'Handoff verification' }), profile.id);
  const frameIn = page => page.frames().find(frame => frame.url().startsWith('anas-plugin://rdp/'));
  let frame = frameIn(main);
  await expect(frame.locator('#status')).toHaveText('Connected', { timeout: 40000 });
  const original = await backend('find', { owner: profile.id });
  assert.ok(original);
  const view = (await main.evaluate(() => gale.panels.list())).find(item => item.content.kind === 'plugin' && item.content.instanceId === profile.id);
  const colors = async page => {
    await expect.poll(() => frameIn(page).locator('canvas').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const values = new Set(); for (let i = 0; i < pixels.length; i += 400) values.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]); return values.size;
    }), { timeout: 15000 }).toBeGreaterThan(4);
  };
  await colors(main);
  await app.evaluate(({ app }) => app.focus({ steal: true }));
  await main.bringToFront();
  await expect(frame.locator('#clipboard')).toHaveAttribute('aria-pressed', 'false');
  await frame.locator('#clipboard').click();
  await expect(frame.locator('#clipboard')).toHaveAttribute('aria-pressed', 'true');
  await expect(frame.locator('#ui-lock')).toHaveAttribute('aria-pressed', 'false');
  await expect(frame.getByRole('button', {name:'Reset keyboard',exact:true})).toBeEnabled();
  await frame.getByRole('button', {name:'Reset keyboard',exact:true}).click();
  await frame.locator('#ui-lock').click();
  await expect(frame.locator('#ui-lock')).toHaveAttribute('aria-pressed', 'true');
  for (const theme of ['light', 'dark']) {
    await main.evaluate(theme => gale.config.updateSettings({ theme }), theme);
    await expect.poll(() => frame.evaluate(() => anas.getInfo().then(info => info.theme))).toBe(theme);
    // The plugin refreshes appearance every five seconds; allow the next poll
    // and its IPC to complete instead of racing the default five-second timeout.
    await expect(frame.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 15000 });
    const button = frame.locator('#ui-lock');
    const visible = await button.screenshot();
    await button.locator('.action-icon').evaluate(icon => { icon.style.opacity = '0'; });
    const hidden = await button.screenshot();
    await button.locator('.action-icon').evaluate(icon => { icon.style.opacity = ''; });
    assert.notDeepEqual(visible, hidden, 'Sidebar package icon must paint in both themes');
    await frame.locator('#connection-header').screenshot({ path: join(root, `tmp/host-proof/icons-sidebar-${theme}.png`) });
  }
  await frame.locator('#connection-header').screenshot({ path: join(root, 'tmp/host-proof/lock-sidebar.png') });
  phase = 'transfer';
  for (let round = 0; round < 3; round++) {
    phase = `transfer round ${round + 1}`;
    await main.evaluate(id => gale.panels.move(id, 'window'), view.viewId);
    const target = app.context().pages().find(page => page.url().includes('panel-window.html'));
    await colors(target);
    await expect(target.getByRole('button', { name: 'Disable clipboard sync', pressed: true })).toBeVisible();
    await expect(target.getByRole('button', { name: 'Local input locked — click to unlock', pressed: true })).toBeVisible();
    const lockButton = target.getByRole('button', { name: 'Local input locked — click to unlock', pressed: true });
    await expect(lockButton.locator('img')).toHaveAttribute('src', /\/_anas\/icon\/assets\/lock.svg$/);
    await expect.poll(() => lockButton.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await expect(target.getByRole('button', {name:'Reset keyboard',exact:true})).toBeEnabled();
    await target.getByRole('button', {name:'Reset keyboard',exact:true}).click();
    if (round === 0) {
      await target.locator('.panel-window-titlebar').screenshot({ path: join(root, 'tmp/host-proof/lock-window.png') });
      await target.getByRole('button', { name: 'Local input locked — click to unlock' }).click();
      await expect(target.getByRole('button', { name: 'Lock local input', pressed: false })).toBeEnabled();
      phase = 'window fitting';
      const nativeWindow = await app.browserWindow(target);
      const geometry = () => frameIn(target).locator('canvas').evaluate(canvas => {
        const image = canvas.getBoundingClientRect(), viewport = canvas.parentElement.getBoundingClientRect();
        return { width: image.width, height: image.height, remoteWidth: canvas.width, remoteHeight: canvas.height,
          availableWidth: viewport.width, availableHeight: viewport.height,
          centerX: image.x + image.width / 2 - viewport.x - viewport.width / 2,
          centerY: image.y + image.height / 2 - viewport.y - viewport.height / 2,
          scroll: canvas.parentElement.scrollWidth > canvas.parentElement.clientWidth || canvas.parentElement.scrollHeight > canvas.parentElement.clientHeight };
      });
      const fitting = async () => {
        const size = await geometry();
        const scale = Math.min(1, size.availableWidth / size.remoteWidth, size.availableHeight / size.remoteHeight);
        return Math.abs(size.width - size.remoteWidth * scale) < 1 && Math.abs(size.height - size.remoteHeight * scale) < 1
          && Math.abs(size.centerX) < 1 && Math.abs(size.centerY) < 1 && !size.scroll;
      };
      for (const size of [[700, 450], [1400, 1050]]) {
        await nativeWindow.evaluate((window, [width, height]) => window.setSize(width, height), size);
        await expect.poll(fitting).toBe(true);
        const position = await frameIn(target).evaluate(() => {
          const canvas = document.querySelector('canvas'), bounds = canvas.getBoundingClientRect();
          const originalSend = WebSocket.prototype.send;
          let input;
          WebSocket.prototype.send = function (data) {
            const value = typeof data === 'string' ? JSON.parse(data) : null;
            if (value?.type === 'mouse') { input = value; return; }
            return originalSend.call(this, data);
          };
          try {
            canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: bounds.x + bounds.width * .75, clientY: bounds.y + bounds.height * .25 }));
            return { x: input?.x, y: input?.y, expectedX: Math.round(canvas.width * .75), expectedY: Math.round(canvas.height * .25) };
          } finally { WebSocket.prototype.send = originalSend; }
        });
        assert.equal(position.x, position.expectedX);
        assert.equal(position.y, position.expectedY);
      }
      const fitWindow = async () => {
        await target.getByRole('button', { name: 'Fit window to desktop', exact: true }).click();
        await expect(target.getByRole('button', { name: 'Fit window to desktop', exact: true })).toBeEnabled();
        await expect.poll(fitting).toBe(true);
        assert.equal((await backend('find', { owner: profile.id })).id, original.id);
      };
      await fitWindow();
      phase = 'window fitting / maximized';
      await nativeWindow.evaluate(window => window.maximize());
      await expect.poll(() => nativeWindow.evaluate(window => window.isMaximized())).toBe(true);
      await fitWindow();
      await expect.poll(() => nativeWindow.evaluate(window => window.isMaximized())).toBe(false);
      phase = 'window fitting / fullscreen';
      await nativeWindow.evaluate(window => window.setFullScreen(true));
      await expect.poll(() => nativeWindow.evaluate(window => window.isFullScreen())).toBe(true);
      await fitWindow();
      await expect.poll(() => nativeWindow.evaluate(window => window.isFullScreen())).toBe(false);
      await target.locator('.panel-window-titlebar').screenshot({ path: join(root, 'tmp/host-proof/fit-window.png') });
      console.log('Window fitting passed: proportional shrink-only display, centered letterboxing, mouse coordinates, repeated fits, maximize/fullscreen restoration, same connection.');
      await target.getByRole('button', { name: 'Lock local input' }).click();
      await expect(target.getByRole('button', { name: 'Local input locked — click to unlock', pressed: true })).toBeEnabled();
    }
    await expect(target.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
    await target.getByRole('button', { name: 'Disconnect', exact: true }).hover();
    await expect(target.getByRole('tooltip')).toHaveText('Disconnect');
    await colors(target);
    assert.equal((await backend('find', { owner: profile.id })).id, original.id);
    await target.evaluate(() => { void panelWindow.moveToSidebar(); });
    await expect.poll(() => target.isClosed()).toBe(true);
    await colors(main);
  }
  phase = 'close-and-reattach';
  await frameIn(main).evaluate(id => { void anas.moveView({ instanceId: id, location: 'window' }); }, profile.id);
  await expect.poll(() => app.context().pages().some(page => page.url().includes('panel-window.html'))).toBe(true);
  const lastWindow = app.context().pages().find(page => page.url().includes('panel-window.html'));
  await expect.poll(() => !!frameIn(lastWindow)).toBe(true);
  await colors(lastWindow);
  await expect.poll(() => backend('profiles.get', { id: profile.id }).then(profile => profile.openMode)).toBe('window');
  await main.evaluate(id => gale.panels.close(id), view.viewId);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await backend('find', { owner: profile.id })).id, original.id);
  const remembered = (await backend('runtime.state', {})).sessions.find(session => session.id === original.id);
  assert.equal(remembered.profile.openMode, 'window');
  await main.evaluate(({ id, location }) => gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location, title: 'Handoff verification' }), { id: profile.id, location: remembered.profile.openMode });
  const restoredWindow = app.context().pages().find(page => page.url().includes('panel-window.html'));
  await colors(restoredWindow);
  await expect(restoredWindow.getByRole('button', { name: 'Local input locked — click to unlock', pressed: true })).toBeVisible();
  assert.equal((await backend('find', { owner: profile.id })).id, original.id);
  await restoredWindow.evaluate(() => { void panelWindow.moveToSidebar(); });
  await expect.poll(() => restoredWindow.isClosed()).toBe(true);
  await colors(main);
  phase = 'move-after-profile-deletion';
  const activeProfile = (await backend('profiles.list', {})).find(item => item.id === profile.id);
  await assert.rejects(backend('profiles.delete', { id: profile.id, revision: activeProfile.revision }), /RDP_PROFILE_ACTIVE/);
  const profileFile = join(directory, 'data-profile/plugins_data/rdp/profiles.json');
  const external = JSON.parse(await readFile(profileFile, 'utf8'));
  external.profiles = external.profiles.filter(item => item.id !== profile.id);
  await writeFile(profileFile, JSON.stringify(external));
  const reopened = (await main.evaluate(() => gale.panels.list())).find(item => item.content.instanceId === profile.id);
  await main.evaluate(id => gale.panels.move(id, 'window'), reopened.viewId);
  const movedWithoutProfile = app.context().pages().find(page => page.url().includes('panel-window.html'));
  await colors(movedWithoutProfile);
  assert.equal((await backend('find', { owner: profile.id })).id, original.id);
  await movedWithoutProfile.evaluate(() => { void panelWindow.moveToSidebar(); });
  await expect.poll(() => movedWithoutProfile.isClosed()).toBe(true);
  await colors(main);
  assert.equal((await backend('find', { owner: profile.id })).id, original.id);
  phase = 'disconnect';
  await frameIn(main).locator('#disconnect').click();
  await expect.poll(() => backend('find', { owner: profile.id })).toBe(null);
  await main.evaluate(id => gale.panels.close(id), reopened.viewId);
  phase = 'foreground-close';
  const foreground = await backend('profiles.save', { ...config, name: 'Foreground close verification', passwordAction: 'set' });
  assert.equal(foreground.runInBackground, false);
  await backend('profiles.launch', { id: foreground.id, revision: foreground.revision });
  await main.evaluate(id => gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location: 'sidebar' }), foreground.id);
  await expect.poll(() => !!frameIn(main)).toBe(true);
  await expect(frameIn(main).locator('#status')).toHaveText('Connected', { timeout: 40000 });
  const foregroundResource = await backend('find', { owner: foreground.id });
  await frameIn(main).evaluate(() => { void anas.moveView('window'); });
  await expect.poll(() => app.context().pages().some(page => page.url().includes('panel-window.html'))).toBe(true);
  const foregroundWindow = app.context().pages().find(page => page.url().includes('panel-window.html'));
  await expect.poll(() => !!frameIn(foregroundWindow)).toBe(true);
  await colors(foregroundWindow);
  assert.equal((await backend('find', { owner: foreground.id })).id, foregroundResource.id, 'Moving an opted-out desktop must preserve its connection.');
  await (await app.browserWindow(foregroundWindow)).evaluate(window => window.close());
  await expect.poll(() => foregroundWindow.isClosed()).toBe(true);
  await expect.poll(() => backend('find', { owner: foreground.id })).toBe(null);
  phase = 'model-tools-without-page';
  const toolSession = await backend('create', { ...config, owner: 'model-tool-test', trustedSha256: pin, runInBackground: true });
  await expect.poll(() => backend('status', { owner: 'model-tool-test', id: toolSession.id }).then(value => value.state), { timeout: 40000 }).toBe('connected');
  const background = await backend('profiles.save', { ...config, name: 'Model background verification', passwordAction: 'set', runInBackground: true });
  const readInputEvents = async () => (await readFile(inputEventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await verifyToolCalls(main, toolSession.id, [await backend('profiles.get', { id: foreground.id }), background], backend, readInputEvents);
  assert.equal(await backend('find', { owner: 'model-tool-test' }), null, 'The model disconnect tool must terminate the same resource.');
  console.log('RDP model tools passed: no-page queries, native screenshot in model request and ordinary history, explicit disconnect, saved-profile connection reuse across completed turns and subsequent input.');
  console.log('Host + RDP passed: round-trip moves, background close and same-session resume, deleted-profile handoff, explicit disconnect, and default foreground close ending a live RDP connection.');
} catch (error) {
  let message = String(error?.stack ?? error);
  for (const value of [config.host, config.username, config.password]) if (value) message = message.split(value).join('[redacted]');
  console.error('RDP host phase:', phase, message);
  for (const page of app?.context().pages() ?? []) {
    for (const frame of page.frames().filter(frame => frame.url().startsWith('anas-plugin://rdp/'))) {
      console.error('RDP UI status:', await frame.locator('#status').textContent().catch(() => ''),
        await frame.locator('#error-message').textContent().catch(() => ''));
    }
  }
  process.exitCode = 1;
} finally {
  await closeElectronTestApplication(app);
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}
