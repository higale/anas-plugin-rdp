import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir, cp, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const root = process.cwd(), host = resolve(root, '../Anas');
assert.equal(process.platform, 'darwin', 'This two-host proof currently preserves the native macOS clipboard');
const require = createRequire(join(host, 'package.json'));
const { _electron: electron } = require('playwright');
const { expect } = require('playwright/test');
const { closeElectronTestApplication } = require('./scripts/electron-test-close.cjs');
const configs = await Promise.all(['rdp-test.json', 'rdp-test-2.json'].map(name => readFile(join('.local', name), 'utf8').then(JSON.parse)));
const trust = JSON.parse(await readFile(join(homedir(), '.galeAnas/plugins_data/rdp/profiles.json'), 'utf8')).certificate_trust;
const pins = configs.map(config => trust.find(item => item.host === config.host && item.port === (config.port ?? 3389))?.sha256);
assert.ok(pins.every(Boolean), 'Both test machines need previously verified certificates');
await mkdir(resolve('tmp'), { recursive: true });
const directory = await mkdtemp(resolve('tmp/clipboard-focus-'));
let app, main, phase = 'prepare';
const snapshot = join(directory, 'clipboard.plist'), snapshotHelper = join(directory, 'clipboard-snapshot');
if (process.platform === 'darwin') {
  execFileSync('clang', ['-framework', 'AppKit', 'test/fixtures/clipboard-snapshot.m', '-o', snapshotHelper], { stdio: 'ignore' });
  execFileSync(snapshotHelper, ['save', snapshot]);
}
try {
  const pkg = join(directory, 'package');
  await cp(resolve('dist'), pkg, { recursive: true });
  // Exercise the real input handler through an isolated test package; no extra production API.
  await appendFile(join(pkg, 'backend.cjs'), `
const proofBackend = module.exports;
module.exports = { ...proofBackend, call: (method, params, context) => method === 'proof.input'
  ? proofBackend.tools.input(params, { ...context, deadline: Date.now() + 45000 })
  : proofBackend.call(method, params, context) };
`);
  await mkdir(join(directory, 'documents'));
  await cp(join(host, 'data'), join(directory, 'data'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'anas-clipboard-proof', version: '1.0.0', main: 'main.cjs' }));
  await writeFile(join(directory, 'main.cjs'), `const {app,dialog}=require('electron'); app.setAppPath(${JSON.stringify(host)}); app.setPath('documents',${JSON.stringify(join(directory, 'documents'))}); dialog.showErrorBox=()=>app.exit(1); require(${JSON.stringify(join(host, 'out/main/index.js'))});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  app = await electron.launch({ executablePath: require('electron'), args: [directory, '--data-dir', join(directory, 'data-profile')], cwd: host, env, timeout: 45000 });
  main = await app.firstWindow();
  await main.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  await main.evaluate(() => gale.config.updateSettings({ language: 'en', theme: 'dark' }));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, join(pkg, 'PLUGIN.json'));
  await main.evaluate(() => gale.plugins.install());
  const backend = (method, params) => main.evaluate(({ method, params }) => gale.plugins.invoke('rdp', 'backend.call', { method, params }), { method, params });
  const resources = [];
  const focus = async page => {
    await app.evaluate(({ app }) => app.focus({ steal: true }));
    const window = await app.browserWindow(page);
    await window.evaluate(window => { window.show(); window.focus(); });
    await expect.poll(() => window.evaluate(window => window.isFocused())).toBe(true);
  };
  const frameFor = async (page, id) => {
    for (const frame of page.frames().filter(frame => frame.url().startsWith('anas-plugin://rdp/'))) {
      try { if ((await frame.evaluate(() => anas.getContext())).view.content.instanceId === id) return frame; } catch {}
    }
    throw new Error('Test panel not found');
  };
  const clipRead = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const clipWrite = text => app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text);
  const pollState = (item, state) => expect.poll(async () => (await backend('status', { owner: item.profile.id, id: item.session.id })).clipboardState, { timeout: 10000 }).toBe(state);
  for (let i = 0; i < configs.length; i++) {
    phase = 'connect ' + (i + 1); console.log(phase);
    const location = i === 0 ? 'sidebar' : 'window';
    const profile = await backend('profiles.save', { ...configs[i], name: 'Clipboard test ' + (i + 1), clipboardSupport: true, passwordAction: 'set', openMode: location, runInBackground: true });
    await backend('trusts.save', { host: configs[i].host, port: configs[i].port ?? 3389, sha256: pins[i] });
    await backend('profiles.launch', { id: profile.id, revision: profile.revision });
    await main.evaluate(({ id, location }) => gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location, title: 'Clipboard test' }), { id: profile.id, location });
    const page = i === 0 ? main : app.context().pages().find(page => page.url().includes('panel-window.html'));
    const frame = await frameFor(page, profile.id);
    await expect(frame.locator('#status')).toHaveText('Connected', { timeout: 45000 });
    const session = await backend('find', { owner: profile.id });
    const view = (await main.evaluate(() => gale.panels.list())).find(view => view.content.instanceId === profile.id);
    const item = { profile, session, view, page, frame }; resources.push(item);
    await app.evaluate(({ app }) => app.focus({ steal: true })); await focus(page);
    await expect.poll(async () => {
      try { await backend('setClipboardEnabled', { owner: profile.id, id: session.id, enabled: true }); return true; }
      catch (error) { if (!String(error).includes('RDP_CLIPBOARD_UNAVAILABLE')) throw error; return false; }
    }, { timeout: 15000 }).toBe(true);
    await pollState(item, 'syncing');
  }
  const [a, b] = resources;
  const input = (item, actions) => backend('proof.input', { session_id: item.session.id, actions, interval_ms: 80 });
  const setRemote = async (item, text) => {
    assert.match(text, /^[a-zA-Z0-9-]+$/);
    await input(item, [{ type: 'hotkey', keys: ['WIN', 'R'] }]);
    await new Promise(resolve => setTimeout(resolve, 500));
    await input(item, [{ type: 'text', text: `powershell.exe -NoProfile -STA -WindowStyle Hidden -Command "Set-Clipboard '${text}'"` }, { type: 'press', key: 'ENTER' }]);
  };
  phase = 'two independent switches'; console.log(phase);
  await pollState(a, 'paused');
  assert.equal((await backend('status', { owner: a.profile.id, id: a.session.id })).clipboardEnabled, true);
  const marker = 'anas-clipboard-' + randomUUID();
  await clipWrite(marker); await new Promise(resolve => setTimeout(resolve, 250));
  await setRemote(b, marker + '-B');
  await app.evaluate(({ app }) => app.focus({ steal: true })); await focus(b.page);
  await pollState(b, 'syncing');
  await expect.poll(clipRead, { timeout: 15000 }).toBe(marker + '-B');
  await setRemote(a, marker + '-inactive-A');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await clipRead(), marker + '-B');
  phase = 'sidebar activation'; console.log(phase);
  await focus(main);
  await main.locator(`[data-panel-id="${a.view.viewId}"]`).click();
  await pollState(a, 'syncing'); await pollState(b, 'paused');
  await setRemote(a, marker + '-A');
  await app.evaluate(({ app }) => app.focus({ steal: true })); await focus(main);
  await main.locator(`[data-panel-id="${a.view.viewId}"]`).click();
  await pollState(a, 'syncing');
  await expect.poll(clipRead, { timeout: 15000 }).toBe(marker + '-A');
  await main.locator('[data-agent-composer-input]').click();
  await pollState(a, 'paused');
  await a.frame.locator('#ui-lock').hover();
  await pollState(a, 'paused');
  await a.frame.locator('#ui-lock').click();
  await pollState(a, 'syncing');
  await a.frame.locator('#ui-lock').click();
  await main.evaluate(() => gale.plugins.invoke('rdp', 'host.openHome'));
  await pollState(a, 'paused');
  await main.locator(`[data-panel-id="${a.view.viewId}"]`).click();
  await pollState(a, 'syncing');
  phase = 'window focus and minimization'; console.log(phase);
  await focus(b.page); await pollState(b, 'syncing'); await pollState(a, 'paused');
  const windowB = await app.browserWindow(b.page);
  await windowB.evaluate(window => window.minimize());
  await pollState(b, 'paused');
  await windowB.evaluate(window => { window.restore(); window.focus(); });
  await pollState(b, 'syncing');
  phase = 'page handoff'; console.log(phase);
  await main.evaluate(id => gale.panels.move(id, 'window'), a.view.viewId);
  await pollState(a, 'syncing'); await pollState(b, 'paused');
  await main.evaluate(id => gale.panels.move(id, 'sidebar'), a.view.viewId);
  await pollState(a, 'syncing');
  assert.equal((await backend('find', { owner: a.profile.id })).id, a.session.id);
  phase = 'background page close'; console.log(phase);
  await main.evaluate(id => gale.panels.close(id), a.view.viewId);
  await pollState(a, 'paused');
  assert.equal((await backend('status', { owner: a.profile.id, id: a.session.id })).clipboardEnabled, true);
  await main.evaluate(id => gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location: 'sidebar', title: 'Clipboard test' }), a.profile.id);
  await pollState(a, 'syncing');
  assert.equal((await backend('find', { owner: a.profile.id })).id, a.session.id);
  phase = 'stop'; console.log(phase);
  await main.evaluate(() => gale.plugins.setEnabled('rdp', false));
  console.log('Two real RDP connections: independent switches, text isolation, sidebar/chat/hover, window focus/minimize, handoff and background restore passed.');
} catch (error) {
  console.error('Clipboard focus verification failed during:', phase);
  if (app) {
    for (const [index, page] of app.context().pages().entries()) await page.screenshot({ path: resolve('tmp/clipboard-focus-failure-' + index + '.png') }).catch(() => {});
    console.error('Activity at failure:', await main?.evaluate(() => gale.panels.list().then(views => views.map(view => ({ location: view.location, activity: view.activity })))).catch(() => []));
  }
  throw error;
} finally {
  if (app) {
    // Stop clipboard owners before restoring the local clipboard.
    await main?.evaluate(() => gale.plugins.setEnabled('rdp', false)).catch(() => {});
    await closeElectronTestApplication(app);
  }
  if (process.platform === 'darwin') execFileSync(snapshotHelper, ['restore', snapshot]);
  await rm(directory, { recursive: true, force: true });
}
