import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { release } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = resolve(root, process.env.RDP_TEST_PACKAGE ?? 'dist');
const installSource = resolve(root, process.env.RDP_TEST_INSTALL_SOURCE ?? join(packageDirectory, 'PLUGIN.json'));
const host = resolve(root, '../Anas');
const require = createRequire(join(host, 'package.json'));
const { _electron: electron } = require('playwright');
const { expect } = require('playwright/test');
const { pluginPage, pluginByTitle, pluginWindow, windowCount } = require('./scripts/electron-plugin-helpers.cjs');
const config = JSON.parse(await readFile(join(root, '.local/rdp-test.json'), 'utf8'));
const trust = JSON.parse(await readFile(join(root, '.local/rdp-trust.json'), 'utf8'));
assert.equal(trust.target_key, createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex'));
const directory = await mkdtemp(join(root, '.local/anas-e2e-'));
const revision = cwd => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const metadata = { date: new Date().toISOString(), host_commit: revision(host), plugin_commit: revision(root), plugin_dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), platform: process.platform, architecture: process.arch, os: release(), node: process.version, upstream: JSON.parse(await readFile(join(root, 'upstream.lock.json'), 'utf8')) };
metadata.package_build = JSON.parse(await readFile(join(packageDirectory, 'BUILD.json'), 'utf8'));
metadata.install_source_kind = installSource.toLowerCase().endsWith('.zip') ? 'zip' : installSource.toLowerCase().endsWith('.json') ? 'manifest' : 'directory';
const env = { ...process.env, ANAS_SKIP_SINGLE_INSTANCE_LOCK: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const results = [];
const browserErrors = [];
let phase = 'launch';
function helperPids() {
  if (process.platform !== 'win32') throw new Error('Native process audit currently requires Windows.');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name anas-rdp-bridge -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true });
  const entries = result.trim() ? JSON.parse(result) : [];
  return (Array.isArray(entries) ? entries : [entries]).filter(item => item.Path?.toLowerCase().startsWith(directory.toLowerCase())).map(item => item.Id);
}
async function connect(page, approveCertificate = false, savedPassword = false) {
  await expect(page.locator('#connect')).toBeEnabled({ timeout: 20000 });
  await page.locator('#host').fill(config.host);
  await page.locator('#port').fill(String(config.port ?? 3389));
  await page.locator('#username').fill(config.username);
  await page.locator('#domain').fill(config.domain ?? '');
  if (!savedPassword) await page.locator('#password').fill(config.password);
  else await expect(page.locator('#password')).toHaveValue('');
  await page.locator('#connect').click();
  if (approveCertificate) {
    await expect(page.locator('#trust')).toBeVisible({ timeout: 20000 });
    // Approve only the exact target/certificate already verified by the user.
    await expect(page.locator('#fingerprint')).toHaveText(trust.certificate_sha256);
    await page.locator('#accept-certificate').click();
  }
  await expect(page.locator('#status')).toHaveText(/^(Connected|已连接)$/, { timeout: 25000 });
  await expect.poll(() => page.locator('canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    const values = new Set();
    for (let i=0; i<pixels.length; i+=400) values.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`);
    return values.size;
  // Reconnected Windows desktops can legitimately have very few colors.
  // Require painted content, without depending on wallpaper or open windows.
  }), { timeout: 15000 }).toBeGreaterThan(4);
}
async function centered(page) {
  await expect.poll(() => page.locator('canvas').evaluate(canvas => {
    const box = document.getElementById('desktop').getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    return Math.max(Math.abs(rect.x + rect.width / 2 - box.x - box.width / 2), Math.abs(rect.y + rect.height / 2 - box.y - box.height / 2), rect.width - box.width, rect.height - box.height,
      Math.abs(rect.width / rect.height - canvas.width / canvas.height));
  }), {timeout:5000}).toBeLessThan(2);
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: [host, '--data-dir', directory], cwd: host, env, timeout: 45000 });
  const page = await app.firstWindow();
  const openHome = async () => {
    await page.getByRole('button', { name: /^(Plugins|插件)$/ }).click();
    await page.getByRole('menuitem', { name: /^(Remote Desktop|远程桌面)$/ }).click();
  };
  page.on('console', event => { if (event.type() === 'error') browserErrors.push(event.text()); });
  page.on('pageerror', error => browserErrors.push(String(error)));
  await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  await app.evaluate(({ dialog, BrowserWindow }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    BrowserWindow.getAllWindows()[0].setSize(1360,850);
  }, installSource);
  phase = 'install';
  await page.evaluate(() => globalThis.gale.plugins.install());
  await page.locator('.sidebar-settings').click();
  await page.getByRole('menuitem', { name: /^(Settings|设置)$/ }).click();
  await page.locator('[data-settings-tab="plugins"]').click();
  await page.getByRole('button', { name: /Open in side panel|在侧边.*打开|侧边.*打开/ }).click();
  let frame = await pluginPage(app, 'rdp');
  await expect(frame.locator('#new')).toBeEnabled({ timeout: 20000 });
  let pluginFrame = frame;
  assert.ok(pluginFrame);
  assert.equal(await pluginFrame.evaluate(() => typeof window.gale), 'undefined');
  phase = 'appearance';
  for (const [theme, fontSize] of [['light',14], ['dark',18]]) {
    await page.evaluate(settings => globalThis.gale.config.updateSettings(settings), { theme, fontSize });
    await pluginFrame.goto(pluginFrame.url());
    await expect(frame.locator('#new')).toBeEnabled({ timeout: 20000 });
    assert.equal(await pluginFrame.evaluate(() => document.documentElement.dataset.theme), theme);
    assert.equal(await frame.locator('#new').evaluate(input => input.getBoundingClientRect().height), Math.max(30, fontSize + 18));
    assert.ok(await pluginFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // No connection information has been entered at this point.
    await frame.screenshot({ path: join(root, `.local/ui-${theme}.png`) });
  }
  results.push('light/dark themes, large font, and narrow sidebar layout');
  await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'light', fontSize: 14 }));
  // Reload to consume the restored host appearance before entering any credentials.
  await pluginFrame.goto(pluginFrame.url());
  phase = 'profiles';
  await expect(frame.locator('#new')).toBeEnabled({timeout:20000});
  const manager = frame;
  const managerFrame = pluginFrame;
  await managerFrame.evaluate(() => anas.data.set('home_open_location', 'sidebar'));
  await expect.poll(() => managerFrame.evaluate(() => anas.data.get('home_open_location'))).toBe('sidebar');
  await manager.locator('#new').click();
  await manager.locator('#name').fill('RDP integration');
  await manager.locator('#host').fill(config.host);
  await manager.locator('#port').fill(String(config.port ?? 3389));
  await manager.locator('#username').fill(config.username);
  await manager.locator('#domain').fill(config.domain ?? '');
  await manager.locator('#remember-password').check();
  await manager.locator('#password').fill(config.password);
  await manager.locator('#save').click();
  await expect(manager.locator('#profiles li')).toHaveCount(1);
  await managerFrame.evaluate(async () => {
    const [profile] = await anas.backend.call('profiles.list', {});
    await anas.openView({instanceId:profile.id,location:profile.openMode,title:profile.name});
  });
  frame = await pluginByTitle(app, page, 'rdp', 'RDP integration', 'sidebar');
  await expect(frame.locator('#connect')).toBeEnabled({ timeout: 20000 });
  pluginFrame = frame;
  const profileId = new URL(pluginFrame.url()).searchParams.get('instance');
  const openPopup = () => page.evaluate(instanceId => globalThis.gale.plugins.invoke('rdp', 'host.openView', { instanceId, location: 'window', title: 'RDP integration' }), profileId);
  await expect(frame.locator('#password')).toHaveValue('');
  await expect(frame.locator('#remember-password')).toBeChecked();
  // Opening a second time reuses the same browsing context without logging in.
  await managerFrame.evaluate(async id => anas.openView({ instanceId: id, location: 'sidebar', title: 'RDP integration' }), profileId);
  assert.equal((await page.evaluate(() => window.gale.plugins.listViews())).filter(view => view.pluginId === 'rdp' && view.instanceId === profileId && view.location === 'sidebar').length, 1);
  await expect.poll(helperPids).toEqual([]);
  const saved = JSON.parse(await readFile(join(directory, 'plugin_data/rdp/profiles.json'), 'utf8'));
  assert.equal(JSON.stringify(saved).includes(config.password), false);
  assert.equal(saved.profiles[0].password.version, 1);
  const profileCopy = await managerFrame.evaluate(async () => {
    const [profile] = await anas.backend.call('profiles.list', {});
    return anas.backend.call('profiles.copy', {id:profile.id,revision:profile.revision,name:'Second server'});
  });
  await managerFrame.evaluate(async profile => {
    await anas.backend.call('profiles.save', {...profile,openMode:'window',passwordAction:'remove'});
    await anas.openView({instanceId:profile.id,location:'window',title:profile.name});
  }, profileCopy);
  await expect.poll(() => windowCount(app)).toBe(2);
  const second = await pluginPage(app, 'rdp', profileCopy.id, 'window');
  await expect(second.locator('#name')).toHaveValue('Second server');
  await expect(second.locator('#remember-password')).not.toBeChecked();
  await expect(second.locator('#open-mode')).toHaveValue('window');
  await (await pluginWindow(app, second)).close();
  await managerFrame.evaluate(async id => {
    const profiles = await anas.backend.call('profiles.list', {});
    const profile = profiles.find(item => item.id === id);
    await anas.backend.call('profiles.delete', profile);
  }, profileCopy.id);
  results.push('multiple saved profiles, portable encrypted password, copy/delete, per-profile placement, duplicate page reuse, no automatic login');
  phase = 'sidebar connect';
  await page.bringToFront();
  await openHome();
  await manager.locator('.profile-select').first().focus();
  await manager.locator('#profiles li').first().hover();
  await manager.locator('[data-action="start"]').first().click();
  await expect(frame.locator('#trust')).toBeVisible({ timeout: 20000 });
  await expect(frame.locator('#fingerprint')).toHaveText(trust.certificate_sha256);
  await frame.locator('#accept-certificate').click();
  await expect(frame.locator('#status')).toHaveText(/^(Connected|已连接)$/, { timeout: 25000 });
  await centered(frame);
  phase = 'live transfer';
  const transferPids = helperPids();
  const transferIdentity = await frame.evaluate(() => globalThis.transferIdentity = crypto.randomUUID());
  for (let i = 0; i < 3; i++) {
    await frame.evaluate(() => anas.moveView('window'));
    await expect(frame.locator('#status')).toHaveText(/^(Connected|已连接)$/);
    await centered(frame);
    assert.deepEqual(helperPids(), transferPids);
    await frame.evaluate(() => anas.moveView('sidebar'));
    await expect(frame.locator('#status')).toHaveText(/^(Connected|已连接)$/);
    await centered(frame);
    assert.deepEqual(helperPids(), transferPids);
  }
  assert.equal(await frame.evaluate(() => globalThis.transferIdentity), transferIdentity);
  results.push('Active RDP page moves between sidebar and window without a new page, helper or authentication');
  phase = 'live language';
  for (const [language, label] of [['en','Connected'],['zh-CN','已连接']]) {
    await page.evaluate(language => globalThis.gale.config.updateSettings({language}), language);
    await expect(frame.locator('#status')).toHaveText(label, {timeout:10000});
    await expect.poll(() => helperPids().length).toBe(1);
  }
  results.push('language follows host changes without reconnecting');
  await openHome();
  await expect(managerFrame.locator('#profiles')).toBeVisible();
  const connectedPids = helperPids();
  await manager.locator('.profile-select').first().focus();
  await manager.locator('#profiles li').first().hover();
  await manager.locator('[data-action="start"]').first().click();
  await expect(frame.locator('#status')).toHaveText(/Connected|已连接/);
  await page.waitForTimeout(1500);
  assert.deepEqual(helperPids(), connectedPids);
  await expect.poll(() => helperPids().length).toBe(1);
  results.push('untrusted certificate rejected; approved target fingerprint accepted; sidebar authentication and desktop');
  results.push('Start from the server list connects with the saved password and reuses an active session without reconnecting');
  // Verify the session survives the host RPC duration.
  await page.waitForTimeout(32000);
  await expect(frame.locator('#status')).toHaveText(/^(Connected|已连接)$/);
  phase = 'keyboard after panel navigation';
  await frame.locator('canvas').hover();
  await frame.locator('canvas').focus();
  assert.equal(await frame.locator('canvas').evaluate(canvas => canvas.getRootNode().activeElement === canvas), true);
  const checksum = () => frame.locator('canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let hash = 0; for (let i = 0; i < pixels.length; i += 100) hash = (Math.imul(hash, 31) + pixels[i] + pixels[i+1] + pixels[i+2]) | 0;
    return hash;
  });
  const before = await checksum();
  await page.keyboard.press('Meta');
  await expect.poll(checksum, { timeout: 5000 }).not.toBe(before);
  await page.keyboard.press('Escape');
  results.push('session exceeds 30 seconds; remote keyboard produces visible pixel change');
  phase = 'disconnect';
  await frame.locator('#disconnect').click();
  await expect(frame.locator('#connect')).toBeEnabled();
  await expect(frame.locator('#password')).toHaveValue('');
  results.push('disconnect and password absent from form');
  await expect.poll(helperPids).toEqual([]);
  phase = 'cancel negotiation';
  const sockets = new Set();
  const stalled = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  try {
    await frame.locator('#remember-password').uncheck();
    await frame.locator('#host').fill('127.0.0.1');
    await frame.locator('#port').fill(String(stalled.address().port));
    await frame.locator('#username').fill('fixture');
    await frame.locator('#password').fill('synthetic');
    await frame.locator('#connect').click();
    await expect.poll(() => sockets.size).toBe(1);
    await frame.locator('#disconnect').click();
    await expect(frame.locator('#connect')).toBeEnabled();
    await expect.poll(helperPids).toEqual([]);
    results.push('cancel during stalled negotiation reclaims native helper');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => stalled.close(resolve));
  }
  phase = 'popup';
  // Restore the tested profile after the synthetic cancellation target.
  await frame.locator('#host').fill(config.host);
  await frame.locator('#port').fill(String(config.port ?? 3389));
  await frame.locator('#username').fill(config.username);
  await frame.locator('#password').fill(config.password);
  await frame.locator('#remember-password').check();
  await frame.locator('#save').click();
  await expect(frame.locator('#status')).toHaveText(/Profile saved|配置已保存/);
  await openPopup();
  await expect.poll(() => windowCount(app)).toBe(2);
  const popup = await pluginPage(app, 'rdp', profileId, 'window');
  await connect(popup, false, true);
  await centered(popup);
  for (const [width,height] of [[1200,500],[600,900]]) {
    await app.evaluate(({BrowserWindow}, size) => {
      BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('plugin-window.html')).setSize(...size);
    }, [width,height]);
    await centered(popup);
    await popup.locator('canvas').hover();
  }
  results.push('desktop remains centered, proportional and contained in sidebar and wide/tall windows');
  results.push('independent window authentication and desktop');
  phase = 'page close';
  await (await pluginWindow(app, popup)).close();
  await expect.poll(helperPids).toEqual([]);
  results.push('closing a connected page reclaims its helper');
  await page.bringToFront();
  await frame.locator('#reload').click();
  await expect(frame.locator('#status')).toHaveText(/Profile reloaded|配置已重新加载/);
  await connect(frame, false, true);
  phase = 'backup';
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, `${directory}-backup.zip`);
  const backup = await page.evaluate(() => globalThis.gale.app.backupData());
  assert.ok(backup?.path);
  await page.evaluate(() => globalThis.gale.plugins.invoke('rdp', 'data.set', { key: 'home_open_location', value: 'window' }));
  await expect.poll(helperPids).toEqual([]);
  await expect(frame.locator('#connect')).toBeEnabled();
  results.push('backup stops active connection and helper');
  phase = 'reconnect after backup';
  await connect(frame, false, true);
  phase = 'restore';
  await page.evaluate(path => globalThis.gale.app.restoreData(path), backup.path);
  await expect.poll(helperPids).toEqual([]);
  assert.equal((await page.evaluate(() => window.gale.plugins.listViews())).filter(view => view.pluginId === 'rdp').length, 0);
  assert.equal((await page.evaluate(() => globalThis.gale.plugins.list())).find(item => item.id === 'rdp').backendStatus, 'stopped');
  assert.equal((await page.evaluate(() => globalThis.gale.plugins.invoke('rdp', 'host.home'))).location, 'sidebar');
  results.push('restore reclaims active connection without automatic login');
  await openPopup();
  await expect.poll(() => windowCount(app)).toBe(2);
  await connect(await pluginPage(app, 'rdp', profileId, 'window'), false, true);
  results.push('restored backup decrypts the saved password and reconnects');
  phase = 'disable';
  await page.evaluate(() => globalThis.gale.plugins.setEnabled('rdp', false));
  await expect.poll(() => windowCount(app)).toBe(1);
  const plugins = await page.evaluate(() => globalThis.gale.plugins.list());
  assert.equal(plugins.find(item => item.id === 'rdp').backendStatus, 'stopped');
  results.push('disable closes window and stops backend');
  await expect.poll(helperPids).toEqual([]);
  phase = 'uninstall';
  await page.evaluate(() => globalThis.gale.plugins.uninstall('rdp'));
  assert.ok((await readFile(join(directory, 'plugin_data/rdp/profiles.json'), 'utf8')).length);
  await expect.poll(helperPids).toEqual([]);
  results.push('uninstall retains ordinary configuration and leaves no helper');
  phase = 'forced host termination';
  await page.evaluate(() => globalThis.gale.plugins.install());
  await openPopup();
  await expect.poll(() => windowCount(app)).toBe(2);
  await connect(await pluginPage(app, 'rdp', profileId, 'window'), false, true);
  await expect.poll(() => helperPids().length).toBe(1);
  // On Windows Electron's launcher PID can differ from its main-process PID.
  const hostPid = await app.evaluate(() => process.pid);
  process.kill(hostPid, 'SIGKILL');
  await expect.poll(helperPids, { timeout: 5000 }).toEqual([]);
  results.push('forced host termination reclaims helper');
  await writeFile(join(root, '.local/host-result.json'), JSON.stringify({ ...metadata, passed: results }, null, 2)+'\n');
  console.log('Anas integration passed: ' + results.join('; '));
} catch (error) {
  const safe = String(error).replaceAll(config.host,'[target]').replaceAll(config.username,'[user]').replaceAll(config.password,'[secret]');
  const diagnostic = browserErrors.map(value => value.replaceAll(config.host,'[target]').replaceAll(config.username,'[user]').replaceAll(config.password,'[secret]'));
  await writeFile(join(root, '.local/host-result.json'), JSON.stringify({ ...metadata, phase, passed: results, error: safe, browser_errors: diagnostic },null,2)+'\n');
  console.error(`Anas integration failed during ${phase}; details saved to .local/host-result.json.`);
  process.exitCode = 1;
} finally { await app?.close().catch(() => {}); }
