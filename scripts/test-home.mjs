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
async function checkLayout(frame) {
  const geometry = await frame.locator('#surface').evaluate(surface => {
    const b = surface.getBoundingClientRect(), css = getComputedStyle(surface), main = document.querySelector('main');
    const header = document.querySelector('#connection-header'), layout = getComputedStyle(main);
    const padding = parseFloat(layout.paddingTop), top = header.hidden ? padding : header.getBoundingClientRect().bottom + parseFloat(layout.gap);
    return { x: b.x, y: b.y, width: b.width, height: b.height, viewportWidth: main.clientWidth, viewportHeight: main.clientHeight,
      availableTop: top, availableBottom: main.clientHeight - padding, page: document.body.dataset.page, border: css.borderTopWidth, padding: parseFloat(css.paddingLeft), overflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(parseFloat(geometry.border) > 0, geometry.page === 'connection', 'Only the connection form should have a card border, regardless of display scaling.');
  assert.ok(Math.abs(geometry.x + geometry.width / 2 - geometry.viewportWidth / 2) < 1, JSON.stringify(geometry));
  if (geometry.page === 'connection') {
    assert.ok(geometry.padding >= 10);
    if (geometry.height < geometry.availableBottom - geometry.availableTop) assert.ok(Math.abs(geometry.y + geometry.height / 2 - (geometry.availableTop + geometry.availableBottom) / 2) < 1);
    else assert.ok(geometry.y >= 0, 'Short windows must keep the start of the form reachable');
  }
  assert.equal(geometry.overflow, false);
}
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
  await expect(page.getByRole('menuitem', { name: 'Remote Desktop', exact: true }).locator('img')).toHaveAttribute('src', /assets\/remote-desktop.svg$/);
  await page.getByRole('menuitem', { name: 'Remote Desktop', exact: true }).click();
  // An existing home keeps its placement even when the saved preference changes.
  const homes = () => page.evaluate(() => window.gale.panels.list().then(views => views.filter(view => view.content.pluginId === 'rdp' && view.content.instanceId === 'main')));
  await expect.poll(async () => (await homes()).length).toBe(1);
  if ((await homes())[0].location === 'sidebar') {
    await expect(page.getByRole('tab', { name: 'Remote Desktop', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => page.getByRole('tab', { name: 'Remote Desktop', exact: true }).locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
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
  const saved = await readFile(join(data, 'plugins_data/rdp/state.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return saved === null ? null : JSON.parse(saved).values.home_open_location;
}
try {
  await launch();
  await page.evaluate(() => window.gale.config.updateSettings({ language: 'en', theme: 'dark' }));
  await page.reload();
  await page.locator('[data-agent-composer-input]').waitFor();
  await install();
  await openHome();
  let frame = await pluginPage(application, 'rdp');
  await expect(frame.locator('#new')).toBeEnabled({ timeout: 20000 });
  assert.equal(await windowCount(application), 1);
  assert.equal(await storedLocation(), null);
  await expect(frame.locator('#connection')).toBeHidden();
  await expect(frame.locator('#profile-editor')).toBeHidden();
  await expect(frame.locator('#disconnect')).toBeHidden();
  await expect(frame.locator('#empty')).toBeVisible();
  await expect(frame.locator('#up')).toBeDisabled();
  await expect(frame.locator('#home-settings')).toHaveCount(0);
  await frame.locator('#add-server').click();
  await expect(frame.locator('#run-in-background')).not.toBeChecked();
  await frame.locator('#run-in-background').check();
  await frame.locator('#name').fill('Synthetic server');
  await frame.locator('#host').fill('test.invalid');
  await frame.locator('#username').fill('fixture');
  await frame.locator('#open-mode').selectOption('window');
  await frame.locator('#save').click();
  await expect(frame.locator('#profiles li')).toHaveCount(1);
  await frame.locator('#profiles li').hover();
  await expect(frame.locator('.row-actions')).toHaveCSS('opacity', '1');
  await frame.locator('[data-action="edit"]').click();
  await expect(frame.locator('#run-in-background')).toBeChecked();
  await frame.locator('#run-in-background').uncheck();
  await expect(frame.locator('#copy, #reload')).toHaveCount(0);
  await expect(frame.locator('#reload-conflict')).toBeHidden();
  await frame.locator('#name').fill('Conflicting draft');
  await frame.evaluate(async () => {
    const [profile] = await anas.backend.call('profiles.list', {});
    await anas.backend.call('profiles.save', { ...profile, domain: 'updated-domain', passwordAction: 'keep' });
  });
  await frame.locator('#save').click();
  await expect(frame.locator('#error')).toContainText('discards unsaved edits');
  await expect(frame.locator('#reload-conflict')).toBeVisible();
  await expect(frame.locator('#reload-conflict')).toHaveCSS('border-top-width', '0px');
  await frame.locator('body').screenshot({ path: join(directory, 'conflict-reload.png') });
  await frame.locator('#reload-conflict').click();
  await expect(frame.locator('#error')).toBeHidden();
  await expect(frame.locator('#name')).toHaveValue('Synthetic server');
  await expect(frame.locator('#domain')).toHaveValue('updated-domain');
  await frame.locator('#domain').fill('');
  await frame.locator('#save').click();
  await frame.locator('#profiles li').hover();
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
  // Less frequent operations live on the pointed-to row, independently of selection.
  await frame.locator('.profile-select').last().click({ button: 'right' });
  await expect(frame.getByRole('menuitem', { name: 'Move down', exact: true })).toBeDisabled();
  await frame.getByRole('menuitem', { name: 'Copy', exact: true }).click();
  await expect(frame.locator('#profiles li')).toHaveCount(3);
  await expect(frame.locator('.profile-select strong').last()).toHaveText('Synthetic server copy');
  await frame.locator('.profile-select').last().click({ button: 'right' });
  await frame.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect(frame.locator('#delete-confirm')).toContainText('Synthetic server copy');
  await frame.locator('#confirm-delete').click();
  await expect(frame.locator('#profiles li')).toHaveCount(2);
  for (const [theme,fontSize] of [['dark',18],['light',14]]) {
    await page.evaluate(settings => window.gale.config.updateSettings(settings), { theme,fontSize });
    await expect(frame.locator('html')).toHaveAttribute('data-theme', theme, {timeout:10000});
    await frame.locator('.profile-select').first().focus();
    await expect(frame.locator('.row-actions').first()).toHaveCSS('opacity', '1');
    await expect.poll(() => frame.locator('#new').evaluate(button => button.getBoundingClientRect().height), {timeout:10000}).toBe(Math.max(30,fontSize+18));
    assert.equal(await frame.locator('html').evaluate(html => html.scrollWidth <= innerWidth), true);
    const first = frame.locator('.profile-select').first();
    await first.click({ button: 'right' });
    const menu = frame.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(frame.getByRole('menuitem', { name: 'Move up', exact: true })).toBeDisabled();
    await expect.poll(() => frame.getByRole('menuitem', { name: 'Copy', exact: true }).evaluate(button => button.getBoundingClientRect().height)).toBe(Math.max(30,fontSize+18));
    assert.equal(await menu.evaluate(menu => { const bounds = menu.getBoundingClientRect(); return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight; }), true);
    await frame.locator('body').screenshot({ path: join(directory, `menu-${theme}.png`) });
    await menu.press('Escape');
    await expect(first).toBeFocused();
    await checkLayout(frame);
    await frame.locator('body').screenshot({ path: join(directory, `list-${theme}.png`) });
    await frame.locator('[data-action="edit"]').first().click();
    await expect(frame.locator('#profile-editor')).toBeVisible();
    await checkLayout(frame);
    await frame.locator('body').screenshot({ path: join(directory, `editor-${theme}.png`) });
    await frame.locator('#cancel-edit').click();
  }
  results.push('Default sidebar list; empty state, add/edit/cancel, persisted ordering, delete cancellation, row context menus with copy/delete, keyboard dismissal, light/dark and font sizing');
  await setHomeLocation('window');
  await page.screenshot({ path: join(directory, 'plugin-settings.png') });
  await openHome();
  assert.equal(await windowCount(application), 1, 'Changing the preference must reuse the existing sidebar home');
  assert.equal((await frame.evaluate(() => anas.getInfo())).view.location, 'sidebar');
  await page.evaluate(async () => {
    const home = (await window.gale.panels.list()).find(view => view.content.pluginId === 'rdp' && view.content.instanceId === 'main');
    await window.gale.panels.close(home.viewId);
  });
  await openHome();
  await expect.poll(() => windowCount(application)).toBe(2);
  const popup = await pluginPage(application, 'rdp', 'main', 'window');
  frame = popup;
  await expect(popup.locator('#new')).toBeEnabled({ timeout: 20000 });
  await expect(popup.locator('.profile-select strong')).toHaveText(['Second server', 'Synthetic server']);
  await popup.locator('#new').click();
  await popup.locator('#name').fill('Unsaved home form');
  await openHome();
  assert.equal(await windowCount(application), 2);
  await expect(popup.locator('#name')).toHaveValue('Unsaved home form');
  await setHomeLocation('sidebar');
  await openHome();
  assert.equal(await windowCount(application), 2);
  assert.equal((await popup.evaluate(() => anas.getInfo())).view.location, 'window');
  await expect(popup.locator('#name')).toHaveValue('Unsaved home form');
  await popup.locator('#cancel-edit').click();
  await frame.locator('.profile-select').last().focus();
  await frame.locator('#profiles li').last().hover();
  await frame.locator('.profile-select').last().dblclick();
  await expect.poll(() => windowCount(application)).toBe(3);
  let connection = await pluginByTitle(application, page, 'rdp', 'Synthetic server', 'window');
  const connectionIcon = (await pluginWindow(application, connection)).locator('.panel-window-titlebar img');
  await expect(connectionIcon).toHaveAttribute('src', /assets\/desktop.svg$/);
  await expect.poll(() => connectionIcon.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await expect(connection.locator('#connect')).toBeEnabled({ timeout: 20000 });
  await expect(connection.locator('#home-settings')).toHaveCount(0);
  await expect(connection.locator('#profile-editor')).toBeHidden();
  await expect(connection.locator('#save')).toBeHidden();
  await expect(connection.locator('#session-password')).toBeVisible();
  await expect(connection.locator('#session-remember-password')).not.toBeChecked();
  await connection.locator('#session-password').fill('temporary-handoff');
  await connection.locator('#session-remember-password').check();
  await expect(connection.locator('#status')).toHaveText('Enter a password, then connect');
  await expect(connection.locator('#connection-header')).toBeHidden();
  const connectionShell = await pluginWindow(application, connection);
  await expect(connectionShell.locator('.panel-toolbar-status')).toHaveText('Enter a password, then connect');
  await expect(connectionShell.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled();
  await expect(connection.locator('#toolbar-error')).toBeHidden();
  const nativeWindow = await application.browserWindow(connectionShell);
  const originalSize = await nativeWindow.evaluate(window => window.getContentSize());
  for (const [theme, fontSize, width, height] of [['dark',18,900,680], ['light',14,600,560], ['dark',18,640,300]]) {
    await page.evaluate(settings => window.gale.config.updateSettings(settings), { theme,fontSize });
    const previousWidth = await connection.evaluate(() => innerWidth);
    await nativeWindow.evaluate((window, size) => window.setContentSize(...size), [width,height]);
    // Windows frame/DPI metrics can differ from the CSS viewport. Wait for the
    // actual presentation resize, then assert layout against that viewport.
    await expect.poll(() => connection.evaluate(() => innerWidth)).not.toBe(previousWidth);
    await expect(connection.locator('html')).toHaveAttribute('data-theme', theme, { timeout:10000 });
    await expect.poll(() => connection.locator('#connect').evaluate(button => button.getBoundingClientRect().height), { timeout:10000 }).toBe(Math.max(30,fontSize+18));
    await connection.locator('main').evaluate(main => { main.scrollTop = 0; });
    await checkLayout(connection);
    await connection.locator('body').screenshot({ path: join(directory, `connection-${theme}-${width}.png`) });
  }
  await nativeWindow.evaluate((window, size) => window.setContentSize(...size), originalSize);
  await page.evaluate(() => window.gale.config.updateSettings({ theme: 'light', fontSize: 14 }));
  await expect.poll(() => connection.locator('#connect').evaluate(button => button.getBoundingClientRect().height), { timeout:10000 }).toBe(32);
  await expect(connection.locator('#manage, #hint')).toHaveCount(0);
  await connection.locator('body').screenshot({ path: join(directory, 'connection-header-window.png') });
  const identity = await connection.evaluate(() => anas.getContext().then(context => context.pageId));
  const connectionId = (await connection.evaluate(() => anas.getInfo())).view.instanceId;
  await (await pluginWindow(application, connection)).getByRole('button', { name: 'Move to side panel', exact: true }).click();
  connection = await pluginPage(application, 'rdp', connectionId, 'sidebar');
  await expect.poll(() => connection.evaluate(id => anas.backend.call('profiles.get', { id }).then(profile => profile.openMode), connectionId)).toBe('sidebar');
  await expect.poll(() => windowCount(application)).toBe(2);
  await expect(connection.locator('#connection-header')).toBeVisible();
  await expect(connection.getByRole('button', { name: 'Server list', exact: true })).toBeVisible();
  await expect(connection.locator('#disconnect')).toHaveText('');
  await expect(connection.locator('#disconnect')).toHaveAttribute('aria-label', 'Disconnect');
  await page.getByRole('tab', { name: 'Synthetic server', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to window', exact: true }).click();
  connection = await pluginPage(application, 'rdp', connectionId, 'window');
  await expect.poll(() => connection.evaluate(id => anas.backend.call('profiles.get', { id }).then(profile => profile.openMode), connectionId)).toBe('window');
  await expect.poll(() => windowCount(application)).toBe(3);
  assert.notEqual(await connection.evaluate(() => anas.getContext().then(context => context.pageId)), identity);
  await expect(connection.locator('#connection-header')).toBeHidden();
  await expect(connection.locator('#title')).toHaveText('Synthetic server');
  await expect(connection.locator('#session-password')).toHaveValue('temporary-handoff');
  await expect(connection.locator('#session-remember-password')).toBeChecked();
  await (await pluginWindow(application, connection)).screenshot({ path: join(directory, 'window-toolbar.png') });
  results.push('The actual RDP page moves window → sidebar → window by rebuilding its presentation and retaining form state');
  await (await pluginWindow(application, connection)).getByRole('button', { name: 'Server list', exact: true }).click();
  assert.equal(await windowCount(application), 3);
  await expect(frame.locator('#profiles')).toBeVisible();
  await expect(frame.locator('.profile-select[aria-pressed="true"]')).toHaveText(/Synthetic server/);
  await expect(frame.locator('.profile-select').last()).toBeFocused();
  await frame.locator('#profiles li').last().hover();
  await expect(frame.locator('[data-action="edit"]').last()).toBeHidden();
  await assert.rejects(frame.evaluate(id => anas.backend.call('profiles.beginEdit', { id }), connectionId), /RDP_PROFILE_OPEN/);
  await (await pluginWindow(application, connection)).close();
  await expect(frame.locator('[data-action="edit"]').last()).toBeVisible();
  await frame.locator('[data-action="edit"]').last().click();
  await expect(frame.locator('#profile-editor')).toBeVisible();
  await assert.rejects(frame.evaluate(async id => { const profile = await anas.backend.call('profiles.get', { id }); return anas.backend.call('profiles.launch', profile); }, connectionId), /RDP_PROFILE_EDITING/);
  await expect(frame.locator('#connection')).toBeHidden();
  await expect(frame.locator('#connect')).toBeHidden();
  await frame.locator('#name').fill('Updated server');
  await frame.locator('#open-mode').selectOption('sidebar');
  await frame.locator('#save').click();
  await expect(frame.locator('#status')).toHaveText('Profile saved');
  await frame.locator('.profile-select').last().dblclick();
  let updatedConnection = await pluginPage(application, 'rdp', connectionId, 'sidebar');
  await expect(page.getByRole('tab', { name: 'Updated server', exact: true }).locator('img')).toHaveAttribute('src', /assets\/desktop.svg$/);
  await expect(updatedConnection.locator('#status')).toHaveText('Enter a password, then connect', {timeout:20000});
  await expect(updatedConnection.locator('header #disconnect')).toBeVisible();
  assert.ok(await updatedConnection.locator('header').evaluate(header => Math.abs(header.getBoundingClientRect().right - header.querySelector('#disconnect').getBoundingClientRect().right) < 1));
  await expect(updatedConnection.locator('#manage, #hint')).toHaveCount(0);
  await updatedConnection.locator('body').screenshot({ path: join(directory, 'connection-header-sidebar.png') });
  assert.equal(await windowCount(application), 2, 'One profile owns one page across placements');
  await updatedConnection.getByRole('button', { name: 'Server list', exact: true }).click();
  await expect(frame.locator('.profile-select[aria-pressed="true"]')).toHaveText(/Updated server/);
  await expect(frame.locator('.profile-select').last()).toBeFocused();
  await expect(frame.locator('.profile-select strong').last()).toHaveText('Updated server');
  await expect(frame.locator('#error')).toBeHidden();
  results.push('Disconnected connection pages still block editing; editing blocks opening; closing/saving unlocks the opposite page and Start uses the latest profile');
  await popup.locator('body').screenshot({ path: join(directory, 'home-window.png') });
  const homeIdentity = await frame.evaluate(() => anas.getContext().then(context => context.panelId));
  await frame.evaluate(() => { void anas.moveView('sidebar'); });
  frame = await pluginPage(application, 'rdp');
  await expect.poll(() => windowCount(application)).toBe(1);
  await setHomeLocation('window');
  await openHome();
  assert.equal(await frame.evaluate(() => anas.getContext().then(context => context.panelId)), homeIdentity);
  assert.equal((await frame.evaluate(() => anas.getInfo())).view.location, 'sidebar');
  await frame.locator('body').screenshot({ path: join(directory, 'home-sidebar.png') });
  results.push('One home is reused across placements and preference changes without losing forms; closing it allows the new preference; business pages keep independent placement');

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
  await assert.rejects(stat(join(data, 'plugins_data/rdp')), { code: 'ENOENT' });
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
    let active = await pluginPage(application, 'rdp', profile.id, 'window');
    await expect(active.locator('#connect')).toBeEnabled({ timeout: 20000 });
    await active.locator('#session-password').fill('synthetic-save-password');
    await active.locator('#session-remember-password').check();
    await active.locator('#connect').click();
    await expect.poll(() => accepted).toBe(1);
    const saved = await active.evaluate(id => anas.backend.call('profiles.get', { id }), profile.id);
    assert.equal(saved.hasPassword, true);
    assert.equal(await active.evaluate(profile => anas.backend.call('profiles.password', profile), saved), 'synthetic-save-password');
    assert.equal((await readFile(join(data, 'plugins_data/rdp/profiles.json'), 'utf8')).includes('synthetic-save-password'), false);
    await openHome();
    const manager = await pluginPage(application, 'rdp');
    const row = manager.locator('#profiles li').filter({ hasText: 'Toolbar fixture' });
    await expect(row.locator('.profile-status')).toHaveText('Connecting…');
    await expect(row.locator('[data-action=edit]')).toBeHidden();
    await row.locator('.profile-select').click();
    await expect(manager.locator('#delete')).toBeDisabled();
    await assert.rejects(manager.evaluate(profile => anas.backend.call('profiles.delete', profile), saved), /RDP_PROFILE_ACTIVE/);
    const originalResource = await manager.evaluate(id => anas.backend.call('find', { owner: id }), profile.id);
    await row.locator('[data-action=resume]').click();
    assert.equal((await manager.evaluate(id => anas.backend.call('find', { owner: id }), profile.id)).id, originalResource.id);
    assert.equal(accepted, 1);
    await manager.locator('body').screenshot({ path: join(directory, 'background-connection.png') });
    let finalShell = await pluginWindow(application, active);
    await expect(finalShell.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await expect(active.locator('#connection-header')).toBeHidden();
    await finalShell.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(finalShell.locator('.panel-toolbar-status')).toHaveText('Disconnected');
    await expect(finalShell.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled();
    await expect(active.locator('#connect')).toBeEnabled();
    await expect.poll(() => peers.size).toBe(0);
    await expect(active.locator('#error')).toBeHidden();
    await expect(active.locator('#toolbar-error')).toBeHidden();
    await expect(row.locator('.profile-status')).toHaveText('Disconnected');
    await expect(row.locator('[data-action=edit]')).toBeHidden();
    await expect(manager.locator('#delete')).toBeEnabled();
    await row.locator('.profile-select').click({ button: 'right' });
    await expect(manager.getByRole('menuitem', { name: 'Start in sidebar', exact: true })).toBeVisible();
    await expect(manager.getByRole('menuitem', { name: 'Start in window', exact: true })).toBeVisible();
    await manager.getByRole('menu').press('Escape');
    await manager.evaluate(profile => anas.moveView({ instanceId: profile.id, location: 'sidebar' }), saved);
    active = await pluginPage(application, 'rdp', profile.id, 'sidebar');
    await expect.poll(() => active.evaluate(id => anas.backend.call('profiles.get', { id }).then(profile => profile.openMode), profile.id)).toBe('sidebar');
    await manager.evaluate(profile => anas.moveView({ instanceId: profile.id, location: 'window' }), saved);
    active = await pluginPage(application, 'rdp', profile.id, 'window');
    finalShell = await pluginWindow(application, active);
    await expect.poll(() => active.evaluate(id => anas.backend.call('profiles.get', { id }).then(profile => profile.openMode), profile.id)).toBe('window');
    // Keep a second native resource alive without attaching a presentation.
    await manager.evaluate(profile => anas.backend.call('create', { ...profile, owner: profile.id, password: 'synthetic-background' }), saved);
    await expect.poll(() => accepted).toBe(2);
    await expect(row.locator('.profile-status')).toHaveText('Connecting…');
    await row.locator('.profile-select').click({ button: 'right' });
    await expect(manager.getByRole('menuitem', { name: 'Edit', exact: true })).toBeDisabled();
    await expect(manager.getByRole('menuitem', { name: 'Delete', exact: true })).toBeDisabled();
    await manager.locator('body').screenshot({ path: join(directory, 'background-menu.png') });
    await manager.getByRole('menuitem', { name: 'Disconnect', exact: true }).click();
    await expect.poll(() => peers.size).toBe(0);
    await expect(row.locator('.profile-status')).toHaveText('Disconnected');
    await expect(manager.locator('#delete')).toBeEnabled();
    await expect(row.locator('[data-action=edit]')).toBeHidden();
    results.push('The list reflects real native resources, Resume focuses the same connection, running profiles reject deletion, and the context menu stops a background resource');
    await finalShell.close();
    await expect(row.locator('.profile-status')).toBeHidden();
    await expect(row.locator('.profile-status')).toHaveText('');
    await expect(row.locator('[data-action=edit]')).toBeVisible();
    await assert.rejects(manager.evaluate(profile => anas.moveView({ instanceId: profile.id, location: 'sidebar' }), saved), /not open/);
    await manager.locator('body').screenshot({ path: join(directory, 'disconnected-without-window.png') });
    await manager.evaluate(profile => anas.openView({ instanceId: profile.id, location: 'window', title: profile.name }), saved);
    active = await pluginPage(application, 'rdp', profile.id, 'window');
    finalShell = await pluginWindow(application, active);
    await expect(row.locator('.profile-status')).toBeVisible();
    await expect(row.locator('.profile-status')).toHaveText('Disconnected');
    await expect(row.locator('[data-action=edit]')).toBeHidden();
    await manager.locator('body').screenshot({ path: join(directory, 'disconnected-with-window.png') });
    results.push('Disconnected rows show status only while their desktop page exists; closing and reopening the window refreshes status without reconnecting');
    const latestProfile = await active.evaluate(id => anas.backend.call('profiles.get', { id }), profile.id);
    await active.evaluate(profile => anas.backend.call('profiles.delete', profile), latestProfile);
    await active.locator('#connect').click();
    await expect(active.locator('#error')).toContainText('deleted');
    await expect(active.locator('#session-remember-password')).toBeDisabled();
    assert.equal(accepted, 2);
    await finalShell.close();
    for (const [location, runInBackground] of [['window', false], ['sidebar', false], ['window', true]]) {
      const closeProfile = await manager.evaluate(({ port, runInBackground }) => anas.backend.call('profiles.save', { name: 'Close behavior', host: '127.0.0.1', port, username: 'fixture', passwordAction: 'remove', ...(runInBackground ? { runInBackground } : {}) }), { port: server.address().port, runInBackground });
      assert.equal(closeProfile.runInBackground, runInBackground);
      await manager.evaluate(({ id, location }) => anas.openView({ instanceId: id, location }), { id: closeProfile.id, location });
      const foreground = await pluginPage(application, 'rdp', closeProfile.id, location);
      await foreground.locator('#session-password').fill('synthetic');
      await foreground.locator('#connect').click();
      await expect.poll(() => peers.size).toBe(1);
      const panel = (await page.evaluate(() => gale.panels.list())).find(item => item.content.instanceId === closeProfile.id);
      if (location === 'window') {
        const shell = await pluginWindow(application, foreground);
        await (await application.browserWindow(shell)).evaluate(window => window.close());
        await expect.poll(() => shell.isClosed()).toBe(true);
      }
      else await page.evaluate(id => gale.panels.close(id), panel.viewId);
      if (runInBackground) {
        const resource = await manager.evaluate(id => anas.backend.call('find', { owner: id }), closeProfile.id);
        assert.ok(resource, 'The opted-in connection survives closing while authentication is pending.');
        assert.equal(peers.size, 1);
        await manager.evaluate(({ owner, id }) => anas.backend.call('disconnect', { owner, id }), { owner: closeProfile.id, id: resource.id });
      }
      await expect.poll(() => manager.evaluate(id => anas.backend.call('find', { owner: id }), closeProfile.id)).toBe(null);
      await expect.poll(() => peers.size).toBe(0);
      await expect.poll(() => page.evaluate(() => gale.panels.list()).then(panels => panels.some(item => item.viewId === panel.viewId))).toBe(false);
    }
    results.push('Background running defaults off; foreground close stops connecting helpers in both locations, while opted-in background close retains them');
    results.push('Connection cards fit large/short windows; Remember persists only encrypted credentials through the actual backend, cancellation closes the peer, and deleted profiles cannot be recreated');
  } finally {
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  await writeFile('.local/home-result.json', JSON.stringify({ date: new Date().toISOString(), results, directory }, null, 2));
  console.log(results.join('\n'));
} finally { await application?.close(); }
