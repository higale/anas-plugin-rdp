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
const host = resolve(root, '../Anas');
const require = createRequire(join(host, 'package.json'));
const { _electron: electron } = require('playwright');
const { expect } = require('playwright/test');
const config = JSON.parse(await readFile(join(root, '.local/rdp-test.json'), 'utf8'));
const trust = JSON.parse(await readFile(join(root, '.local/rdp-trust.json'), 'utf8'));
assert.equal(trust.target_key, createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex'));
const directory = await mkdtemp(join(root, '.local/anas-e2e-'));
const revision = cwd => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const metadata = { date: new Date().toISOString(), host_commit: revision(host), plugin_commit: revision(root), plugin_dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), platform: process.platform, architecture: process.arch, os: release(), node: process.version, upstream: JSON.parse(await readFile(join(root, 'upstream.lock.json'), 'utf8')) };
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
async function connect(page, approveCertificate = false) {
  await expect(page.locator('#connect')).toBeEnabled({ timeout: 20000 });
  await page.locator('#host').fill(config.host);
  await page.locator('#port').fill(String(config.port ?? 3389));
  await page.locator('#username').fill(config.username);
  await page.locator('#domain').fill(config.domain ?? '');
  await page.locator('#password').fill(config.password);
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
try {
  app = await electron.launch({ executablePath: require('electron'), args: [host, '--data-dir', directory], cwd: host, env, timeout: 45000 });
  const page = await app.firstWindow();
  page.on('console', event => { if (event.type() === 'error') browserErrors.push(event.text()); });
  page.on('pageerror', error => browserErrors.push(String(error)));
  await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  await app.evaluate(({ dialog, BrowserWindow }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    BrowserWindow.getAllWindows()[0].setSize(1360,850);
  }, join(root, 'dist'));
  phase = 'install';
  await page.evaluate(() => globalThis.gale.plugins.install());
  await page.locator('.sidebar-settings').click();
  await page.getByRole('menuitem', { name: /^(Settings|设置)$/ }).click();
  await page.locator('[data-settings-tab="plugins"]').click();
  await page.getByRole('button', { name: /Open in side panel|在侧边.*打开|侧边.*打开/ }).click();
  const frame = page.frameLocator('iframe[title="Remote Desktop / 远程桌面"]');
  await expect(frame.locator('#connect')).toBeEnabled({ timeout: 20000 });
  const pluginFrame = page.frames().find(frame => frame.url().startsWith('anas-plugin://rdp/'));
  assert.ok(pluginFrame);
  assert.equal(await pluginFrame.evaluate(() => typeof window.gale), 'undefined');
  phase = 'appearance';
  for (const [theme, fontSize] of [['light',14], ['dark',18]]) {
    await page.evaluate(settings => globalThis.gale.config.updateSettings(settings), { theme, fontSize });
    await pluginFrame.goto(pluginFrame.url());
    await expect(frame.locator('#connect')).toBeEnabled({ timeout: 20000 });
    assert.equal(await pluginFrame.evaluate(() => document.documentElement.dataset.theme), theme);
    assert.equal(await frame.locator('#host').evaluate(input => input.getBoundingClientRect().height), Math.max(30, fontSize + 18));
    assert.ok(await pluginFrame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // No connection information has been entered at this point.
    await page.locator('iframe[title="Remote Desktop / 远程桌面"]').screenshot({ path: join(root, `.local/ui-${theme}.png`) });
  }
  results.push('light/dark themes, large font, and narrow sidebar layout');
  await page.evaluate(() => globalThis.gale.config.updateSettings({ theme: 'light', fontSize: 14 }));
  // Reload to consume the restored host appearance before entering any credentials.
  await pluginFrame.goto(pluginFrame.url());
  phase = 'sidebar connect';
  await connect(frame, true);
  results.push('untrusted certificate rejected; approved target fingerprint accepted; sidebar authentication and desktop');
  // Verify the session survives the host RPC duration.
  await page.waitForTimeout(32000);
  await expect(frame.locator('#status')).toHaveText(/^(Connected|已连接)$/);
  await frame.locator('canvas').hover();
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
  const data = await pluginFrame.evaluate(() => window.anas.data.get('connection'));
  assert.deepEqual(Object.keys(data).sort(), ['domain','host','port','username']);
  results.push('disconnect and password excluded from persistence');
  await expect.poll(helperPids).toEqual([]);
  phase = 'cancel negotiation';
  const sockets = new Set();
  const stalled = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  try {
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
  await page.evaluate(() => globalThis.gale.plugins.openWindow('rdp'));
  await expect.poll(() => app.windows().length).toBe(2);
  const popup = app.windows().find(window => window !== page);
  await connect(popup);
  results.push('independent window authentication and desktop');
  phase = 'page close';
  await popup.close();
  await expect.poll(helperPids).toEqual([]);
  results.push('closing a connected page reclaims its helper');
  await connect(frame);
  phase = 'backup';
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, `${directory}-backup.zip`);
  const backup = await page.evaluate(() => globalThis.gale.app.backupData());
  assert.ok(backup?.path);
  await expect.poll(helperPids).toEqual([]);
  await expect(frame.locator('#connect')).toBeEnabled();
  results.push('backup stops active connection and helper');
  phase = 'reconnect after backup';
  await connect(frame);
  phase = 'restore';
  await page.evaluate(path => globalThis.gale.app.restoreData(path), backup.path);
  await expect.poll(helperPids).toEqual([]);
  await expect(page.locator('iframe[title="Remote Desktop / 远程桌面"]')).toHaveCount(0);
  assert.equal((await page.evaluate(() => globalThis.gale.plugins.list())).find(item => item.id === 'rdp').backendStatus, 'stopped');
  results.push('restore reclaims active connection without automatic login');
  await page.evaluate(() => globalThis.gale.plugins.openWindow('rdp'));
  await expect.poll(() => app.windows().length).toBe(2);
  await connect(app.windows().find(window => window !== page));
  phase = 'disable';
  await page.evaluate(() => globalThis.gale.plugins.setEnabled('rdp', false));
  await expect.poll(() => app.windows().length).toBe(1);
  const plugins = await page.evaluate(() => globalThis.gale.plugins.list());
  assert.equal(plugins.find(item => item.id === 'rdp').backendStatus, 'stopped');
  results.push('disable closes window and stops backend');
  await expect.poll(helperPids).toEqual([]);
  phase = 'uninstall';
  await page.evaluate(() => globalThis.gale.plugins.uninstall('rdp'));
  assert.ok((await readFile(join(directory, 'plugin_data/rdp/state.json'), 'utf8')).length);
  await expect.poll(helperPids).toEqual([]);
  results.push('uninstall retains ordinary configuration and leaves no helper');
  phase = 'forced host termination';
  await page.evaluate(() => globalThis.gale.plugins.install());
  await page.evaluate(() => globalThis.gale.plugins.openWindow('rdp'));
  await expect.poll(() => app.windows().length).toBe(2);
  await connect(app.windows().find(window => window !== page));
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
