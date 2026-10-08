import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const host = resolve('../Anas');
const require = createRequire(join(host, 'package.json'));
const { _electron: electron } = require('playwright');
const { expect } = require('playwright/test');
const { pluginPage, pluginByTitle, pluginWindow, windowCount } = require('./scripts/electron-plugin-helpers.cjs');
const directory = await mkdtemp(resolve('.local/home-'));
const data = join(directory, 'data'); await mkdir(data);
const env = { ...process.env, ANAS_SKIP_SINGLE_INSTANCE_LOCK: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let application;
let page;
const results = [];
async function launch() {
  application = await electron.launch({ executablePath: require('electron'), args: [host, '--data-dir', data], cwd: host, env, timeout: 45000 });
  page = await application.firstWindow();
  await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
}
async function openHome() {
  if (await page.locator('[data-settings-tab="plugins"]').isVisible()) {
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remote Desktop', exact: true }).click();
  // The host delivers sidebar opening asynchronously. Wait for selection before
  // navigating to settings, even when the home page already exists.
  if (await storedLocation() !== 'window') {
    await expect(page.getByRole('tab', { name: 'Remote Desktop', exact: true })).toHaveAttribute('aria-selected', 'true');
    await pluginPage(application, 'rdp');
  }
}
async function settings() {
  if (!await page.locator('[data-settings-tab="plugins"]').isVisible()) {
    await page.locator('.sidebar-settings').click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  }
  await page.locator('[data-settings-tab="plugins"]').click();
}
async function setHomeLocation(location) {
  await settings();
  const label = location === 'window' ? 'Window' : 'Sidebar';
  await expect(page.getByRole('radio', { name: label, exact: true })).toBeEnabled();
  await page.getByRole('radiogroup', { name: 'Home page opens in', exact: true }).getByText(label, { exact: true }).click();
  await expect.poll(storedLocation).toBe(location);
}
async function install() {
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, resolve('dist/PLUGIN.json'));
  await page.evaluate(() => window.gale.plugins.install());
}
async function storedLocation() {
  const saved = await readFile(join(data, 'plugin_data/rdp/state.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return saved === null ? null : JSON.parse(saved).values.home_open_location;
}
try {
  await launch();
  await page.evaluate(() => window.gale.config.updateSettings({ language: 'en', theme: 'dark' }));
  await page.reload();
  await page.locator('[data-agent-composer-input]').waitFor();
  await install();
  await openHome();
  const frame = await pluginPage(application, 'rdp');
  await expect(frame.locator('#new')).toBeEnabled({ timeout: 20000 });
  assert.equal(await windowCount(application), 1);
  assert.equal(await storedLocation(), null);
  await expect(frame.locator('#connection')).toBeHidden();
  await expect(frame.locator('#disconnect')).toBeHidden();
  await expect(frame.locator('#empty')).toBeVisible();
  await expect(frame.locator('#up')).toBeDisabled();
  await expect(frame.locator('#home-settings')).toHaveCount(0);
  await frame.locator('#add-server').click();
  await frame.locator('#name').fill('Synthetic server');
  await frame.locator('#host').fill('test.invalid');
  await frame.locator('#username').fill('fixture');
  await frame.locator('#open-mode').selectOption('window');
  await frame.locator('#save').click();
  await expect(frame.locator('#profiles li')).toHaveCount(1);
  await frame.locator('#profiles li').hover();
  await expect(frame.locator('.row-actions')).toHaveCSS('opacity', '1');
  await frame.locator('[data-action="edit"]').click();
  await frame.locator('#name').fill('Discarded name');
  await frame.locator('#cancel-edit').click();
  await expect(frame.locator('.profile-select strong')).toHaveText('Synthetic server');
  await frame.locator('#new').click();
  await frame.locator('#name').fill('Second server');
  await frame.locator('#host').fill('second.invalid');
  await frame.locator('#username').fill('fixture');
  await frame.locator('#save').click();
  await expect(frame.locator('#profiles li')).toHaveCount(2);
  await expect(frame.locator('#down')).toBeDisabled();
  await frame.locator('#up').click();
  await expect(frame.locator('.profile-select strong')).toHaveText(['Second server', 'Synthetic server']);
  await expect(frame.locator('#up')).toBeDisabled();
  await frame.locator('#delete').click();
  await expect(frame.locator('#delete-confirm')).toContainText('Second server');
  await frame.locator('#cancel-delete').click();
  await expect(frame.locator('#profiles li')).toHaveCount(2);
  for (const [theme,fontSize] of [['dark',18],['light',14]]) {
    await page.evaluate(settings => window.gale.config.updateSettings(settings), { theme,fontSize });
    await expect(frame.locator('html')).toHaveAttribute('data-theme', theme, {timeout:10000});
    await frame.locator('.profile-select').first().focus();
    await expect(frame.locator('.row-actions').first()).toHaveCSS('opacity', '1');
    await expect.poll(() => frame.locator('#new').evaluate(button => button.getBoundingClientRect().height), {timeout:10000}).toBe(Math.max(30,fontSize+18));
    assert.equal(await frame.locator('html').evaluate(html => html.scrollWidth <= innerWidth), true);
    await frame.screenshot({ path: join(directory, `list-${theme}.png`) });
  }
  results.push('Default sidebar list; empty state, add/edit/cancel, persisted ordering, delete cancellation, hover/keyboard actions, light/dark and font sizing');
  await setHomeLocation('window');
  await page.screenshot({ path: join(directory, 'plugin-settings.png') });
  await openHome();
  await expect.poll(() => windowCount(application)).toBe(2);
  const popup = await pluginPage(application, 'rdp', 'main', 'window');
  await expect(popup.locator('#new')).toBeEnabled({ timeout: 20000 });
  await expect(popup.locator('.profile-select strong')).toHaveText(['Second server', 'Synthetic server']);
  await popup.locator('#new').click();
  await popup.locator('#name').fill('Unsaved home form');
  await openHome();
  assert.equal(await windowCount(application), 2);
  await expect(popup.locator('#name')).toHaveValue('Unsaved home form');
  await frame.locator('.profile-select').last().focus();
  await frame.locator('#profiles li').last().hover();
  await frame.locator('[data-action="start"]').last().click();
  await expect.poll(() => windowCount(application)).toBe(3);
  const connection = await pluginByTitle(application, page, 'rdp', 'Synthetic server', 'window');
  await expect(connection.locator('#connect')).toBeEnabled({ timeout: 20000 });
  await expect(connection.locator('#home-settings')).toHaveCount(0);
  await expect(connection.locator('#status')).toHaveText('Enter a password, then connect');
  await expect(connection.locator('#connection-header')).toBeHidden();
  const connectionShell = await pluginWindow(application, connection);
  await expect(connectionShell.locator('.panel-toolbar-status')).toHaveText('Enter a password, then connect');
  await expect(connectionShell.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled();
  await expect(connection.locator('#toolbar-error')).toBeHidden();
  await expect(connection.locator('#manage, #hint')).toHaveCount(0);
  await connection.screenshot({ path: join(directory, 'connection-header-window.png') });
  const identity = await connection.evaluate(() => globalThis.transferIdentity = crypto.randomUUID());
  await (await pluginWindow(application, connection)).getByRole('button', { name: 'Move to side panel', exact: true }).click();
  await expect.poll(async () => (await connection.evaluate(() => anas.getInfo())).view.location).toBe('sidebar');
  await expect.poll(() => windowCount(application)).toBe(2);
  await expect(connection.locator('#connection-header')).toBeVisible();
  await page.getByRole('button', { name: 'Move to window', exact: true }).click();
  await expect.poll(async () => (await connection.evaluate(() => anas.getInfo())).view.location).toBe('window');
  await expect.poll(() => windowCount(application)).toBe(3);
  assert.equal(await connection.evaluate(() => globalThis.transferIdentity), identity);
  await expect(connection.locator('#connection-header')).toBeHidden();
  await expect(connection.locator('#name')).toHaveValue('Synthetic server');
  await (await pluginWindow(application, connection)).screenshot({ path: join(directory, 'window-toolbar.png') });
  results.push('The actual RDP page moves window → sidebar → window with its browsing context and form intact');
  await connection.locator('#name').fill('Updated server');
  await connection.locator('#open-mode').selectOption('sidebar');
  await connection.locator('#save').click();
  await expect(connection.locator('#status')).toHaveText('Profile saved');
  await openHome();
  await expect(popup.locator('#name')).toHaveValue('Unsaved home form');
  assert.equal(await windowCount(application), 3);
  await setHomeLocation('sidebar');
  await openHome();
  await expect(frame.locator('#profiles')).toBeVisible();
  // The existing home still has the earlier revision and window location.
  await expect(frame.locator('.profile-select strong').last()).toHaveText('Synthetic server');
  await frame.locator('.profile-select').last().focus();
  await frame.locator('#profiles li').last().hover();
  await frame.locator('[data-action="start"]').last().click();
  const updatedConnection = await pluginByTitle(application, page, 'rdp', 'Updated server', 'sidebar');
  await expect(updatedConnection.locator('#status')).toHaveText('Enter a password, then connect', {timeout:20000});
  await expect(updatedConnection.locator('header #disconnect')).toBeVisible();
  assert.ok(await updatedConnection.locator('header').evaluate(header => Math.abs(header.getBoundingClientRect().right - header.querySelector('#disconnect').getBoundingClientRect().right) < 1));
  await expect(updatedConnection.locator('#manage, #hint')).toHaveCount(0);
  await updatedConnection.screenshot({ path: join(directory, 'connection-header-sidebar.png') });
  assert.equal(await windowCount(application), 3, 'Updated placement must open the sidebar, not another window');
  await openHome();
  await expect(frame.locator('.profile-select strong').last()).toHaveText('Updated server');
  await expect(frame.locator('#error')).toBeHidden();
  results.push('Edit and save in the connection window, return to an existing home and Start uses the latest revision, name and sidebar placement without a false conflict');
  await setHomeLocation('window');
  await popup.screenshot({ path: join(directory, 'home-window.png') });
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await frame.screenshot({ path: join(directory, 'home-sidebar.png') });
  results.push('Top menu opens the configured home directly; repeat clicks and returning from a connection reuse it without losing forms; server placement remains independent');
  await (await pluginWindow(application, connection)).close();
  await application.close();
  await launch();
  const beforeOpen = await page.evaluate(() => window.gale.plugins.list());
  assert.equal(beforeOpen.find(plugin => plugin.id === 'rdp').backendStatus, 'stopped');
  await openHome();
  await expect.poll(() => windowCount(application)).toBe(2);
  const reopened = await pluginPage(application, 'rdp', 'main', 'window');
  assert.equal(await storedLocation(), 'window');
  await expect(reopened.locator('#new')).toBeEnabled({ timeout: 20000 });
  await expect(reopened.locator('.profile-select strong')).toHaveText(['Second server', 'Updated server']);
  await reopened.locator('#delete').click();
  await reopened.locator('#confirm-delete').click();
  await expect(reopened.locator('.profile-select strong')).toHaveText(['Updated server']);
  await page.evaluate(() => window.gale.plugins.setEnabled('rdp', false));
  await expect.poll(() => windowCount(application)).toBe(1);
  await assert.rejects(page.evaluate(() => window.gale.plugins.invoke('rdp', 'host.openHome')), /disabled/);
  await page.evaluate(() => window.gale.plugins.uninstall('rdp'));
  assert.equal(await storedLocation(), 'window');
  await install();
  await openHome();
  await expect.poll(() => windowCount(application)).toBe(2);
  await expect((await pluginPage(application, 'rdp', 'main', 'window')).locator('#new')).toBeEnabled({ timeout: 20000 });
  assert.equal(await storedLocation(), 'window');
  results.push('The preference survives restart and reinstall in plugin data; disabling closes home views and blocks reopening');
  await settings();
  await page.getByRole('button', { name: 'Uninstall plugin', exact: true }).click();
  let dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('checkbox', { name: 'Delete plugin data', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.gale.plugins.list())).toEqual([]);
  assert.equal(await storedLocation(), 'window');
  await install();
  await page.getByRole('button', { name: 'Uninstall plugin', exact: true }).click();
  dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('checkbox', { name: 'Delete plugin data', exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Delete plugin data', exact: true }).check();
  await page.screenshot({ path: join(directory, 'uninstall-delete-data.png') });
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.gale.plugins.list())).toEqual([]);
  await assert.rejects(stat(join(data, 'plugin_data/rdp')), { code: 'ENOENT' });
  await install();
  assert.deepEqual(await page.evaluate(() => window.gale.plugins.invoke('rdp', 'backend.call', { method: 'profiles.list', params: {} })), []);
  results.push('The setting lives in host plugin settings; uninstall keeps data by default and deletes profiles plus preferences only when explicitly checked');
  // A local peer holds negotiation open: exercise the actual helper and cancel
  // path without using credentials or changing any remote machine.
  const peers = new Set();
  let accepted = 0;
  const server = createServer(socket => {
    accepted++; peers.add(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => peers.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const profile = await page.evaluate(port => window.gale.plugins.invoke('rdp', 'backend.call', {
      method: 'profiles.save', params: { name: 'Toolbar fixture', host: '127.0.0.1', port, username: 'fixture', openMode: 'window', passwordAction: 'remove' }
    }), server.address().port);
    await page.evaluate(id => window.gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location: 'window', title: 'Toolbar fixture' }), profile.id);
    const active = await pluginPage(application, 'rdp', profile.id, 'window');
    await expect(active.locator('#connect')).toBeEnabled({ timeout: 20000 });
    const identity = await active.evaluate(() => globalThis.toolbarIdentity = crypto.randomUUID());
    await active.locator('#connect').click();
    await expect.poll(() => accepted).toBe(1);
    const firstShell = await pluginWindow(application, active);
    await expect(firstShell.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await expect(active.locator('#connection-header')).toBeHidden();
    await firstShell.getByRole('button', { name: 'Move to side panel', exact: true }).click();
    await expect(active.locator('#connection-header')).toBeVisible();
    await active.evaluate(() => anas.moveView('window'));
    const finalShell = await pluginWindow(application, active);
    await expect(active.locator('#connection-header')).toBeHidden();
    assert.equal(await active.evaluate(() => globalThis.toolbarIdentity), identity);
    assert.equal(accepted, 1, 'Moving must preserve the in-progress transport');
    await finalShell.screenshot({ path: join(directory, 'titlebar-cancel.png') });
    await finalShell.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(finalShell.locator('.panel-toolbar-status')).toHaveText('Disconnected');
    await expect(finalShell.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled();
    await expect(active.locator('#connect')).toBeEnabled();
    await expect.poll(() => peers.size).toBe(0);
    await expect(active.locator('#error')).toBeHidden();
    await expect(active.locator('#toolbar-error')).toBeHidden();
    await finalShell.close();
    results.push('Titlebar status and cancel use the actual RDP page/helper; window/sidebar transfers preserve pending transport, cancel closes the peer and restores reconnect controls');
  } finally {
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  await writeFile('.local/home-result.json', JSON.stringify({ date: new Date().toISOString(), results, directory }, null, 2));
  console.log(results.join('\n'));
} finally { await application?.close(); }
