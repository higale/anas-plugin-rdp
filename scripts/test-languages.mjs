import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const host = resolve('../Anas');
const require = createRequire(join(host, 'package.json'));
const { _electron: electron } = require('playwright');
const { expect } = require('playwright/test');
const { pluginPage, pluginWindow, windowCount } = require('./scripts/electron-plugin-helpers.cjs');
const { ZipFile } = require('yazl');
const directory = await mkdtemp(resolve('.local/languages-'));
const source = join(directory, 'source');
await cp(resolve('dist'), source, { recursive: true });
await writeFile(join(source, 'lang/fr.json'), JSON.stringify({ version: 0, _meta: { name: 'Français' }, plugin: { name: 'Bureau distant' }, actions: { new: 'Nouveau' } }));
const archive = join(directory, 'translated.zip');
await new Promise((resolveZip, reject) => {
  const zip = new ZipFile();
  const output = createWriteStream(archive);
  output.on('close', resolveZip); output.on('error', reject); zip.on('error', reject); zip.outputStream.pipe(output);
  const add = async (prefix = '') => {
    for (const entry of await readdir(join(source, prefix), { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await add(name + '/'); else zip.addFile(join(source, name), name);
    }
  };
  void add().then(() => zip.end(), reject);
});
const data = join(directory, 'data'); await mkdir(data);
const env = { ...process.env, ANAS_SKIP_SINGLE_INSTANCE_LOCK: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let application;
const results = [];
try {
  application = await electron.launch({ executablePath: require('electron'), args: [host, '--data-dir', data], cwd: host, env, timeout: 45000 });
  const page = await application.firstWindow();
  await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, archive);
  await page.evaluate(() => window.gale.plugins.install());
  // A translation supplied only by a plugin must not add a host language.
  await page.reload();
  await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  const snapshot = await page.evaluate(() => window.gale.app.getLanguageResources());
  assert.ok(!snapshot.languages.some(item => item.code === 'fr'));
  const settings = async () => {
    if (await page.locator('[data-settings-tab="general"]').isVisible()) return;
    await page.locator('.sidebar-settings').click();
    await page.getByRole('menuitem', { name: /^(Settings|设置)$/ }).click();
  };
  const selectLanguage = async (label, code) => {
    await settings();
    await page.locator('[data-settings-tab="general"]').click();
    await page.getByRole('combobox', { name: /^(Language|语言)$/ }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.gale.config.get()).settings.language)).toBe(code);
  };
  await settings();
  await page.locator('[data-settings-tab="general"]').click();
  await page.getByRole('combobox', { name: /^(Language|语言)$/ }).click();
  await expect(page.getByRole('option', { name: 'Français (fr)', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.gale.config.updateSettings({ language: 'fr' }));
  assert.equal((await page.evaluate(() => window.gale.plugins.invoke('rdp', 'host.info'))).language, 'en');
  results.push('Plugin-only French is absent from the host selector; an unsupported saved preference resolves to English');
  // Add an actual host language, then reopen to load the host's language list.
  await writeFile(join(data, 'lang/fr.json'), JSON.stringify({ version: 0, _meta: { name: 'Français' } }));
  await page.reload();
  await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 });
  await selectLanguage('Français (fr)', 'fr');
  await page.locator('[data-settings-tab="plugins"]').click();
  await expect(page.getByRole('button', { name: 'Bureau distant', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open in side panel', exact: true }).click();
  let frame = await pluginPage(application, 'rdp');
  await expect(frame.locator('#new')).toBeEnabled({ timeout: 20000 });
  await expect(frame.locator('#new')).toHaveAttribute('aria-label', 'Nouveau');
  await expect(frame.locator('#save')).toHaveText('Save');
  await expect(page.getByRole('tab', { name: 'Bureau distant', exact: true })).toBeVisible();
  await frame.locator('#new').click();
  await frame.locator('#name').fill('My server');
  await frame.locator('body').screenshot({ path: join(directory, 'french-sidebar.png') });
  await page.getByRole('tab', { name: 'Bureau distant', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to window', exact: true }).click();
  const popup = await pluginPage(application, 'rdp', 'main', 'window');
  await expect(popup.locator('#new')).toBeEnabled({ timeout: 20000 });
  await expect(popup.locator('#new')).toHaveAttribute('aria-label', 'Nouveau');
  await expect(popup.locator('#name')).toHaveValue('My server');
  assert.equal(await popup.evaluate(() => typeof window.gale), 'undefined');
  const shell = await pluginWindow(application, popup);
  await expect(shell.locator('.panel-window-titlebar > strong')).toHaveText('Bureau distant');
  await popup.locator('body').screenshot({ path: join(directory, 'french-window.png') });
  results.push('Host French is used in settings, sidebar and detached titles; moving preserves the draft and missing strings fall back to English');
  await selectLanguage('简体中文 (zh-CN)', 'zh-CN');
  await expect(popup.locator('#new')).toHaveAttribute('aria-label', '新建', { timeout: 10000 });
  await expect(popup.locator('#name')).toHaveValue('My server');
  await expect(shell.locator('.panel-window-titlebar > strong')).toHaveText('远程桌面');
  await shell.getByRole('button', { name: '移回侧边栏', exact: true }).click();
  frame = await pluginPage(application, 'rdp');
  await expect(page.getByRole('tab', { name: '远程桌面', exact: true })).toBeVisible();
  const profile = await page.evaluate(() => window.gale.plugins.invoke('rdp', 'backend.call', {
    method: 'profiles.save', params: { name: 'My server', host: 'test.invalid', username: 'fixture', passwordAction: 'remove' }
  }));
  await page.evaluate(id => window.gale.plugins.invoke('rdp', 'host.openView', { instanceId: id, location: 'window', title: 'My server' }), profile.id);
  await selectLanguage('English (en)', 'en');
  await expect(frame.locator('#new')).toHaveAttribute('aria-label', 'New', { timeout: 10000 });
  const titles = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.getTitle()));
  assert.ok(titles.includes('My server'));
  results.push('Language switches update existing views and preserve form input and custom window titles');
  await page.evaluate(() => window.gale.plugins.setEnabled('rdp', false));
  await expect.poll(() => windowCount(application)).toBe(1);
  assert.equal((await page.evaluate(() => window.gale.panels.list())).filter(view => view.content.pluginId === 'rdp').length, 0);
  await page.evaluate(() => window.gale.plugins.uninstall('rdp'));
  assert.ok((await page.evaluate(() => window.gale.app.getLanguageResources())).languages.some(language => language.code === 'fr'));
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, resolve('dist/PLUGIN.json'));
  const installed = await page.evaluate(() => window.gale.plugins.install());
  assert.ok(!installed.languages.some(language => language.code === 'fr'));
  assert.equal((await readdir(join(data, 'plugins/rdp/package/lang'))).includes('fr.json'), false);
  await selectLanguage('Français (fr)', 'fr');
  await page.evaluate(() => window.gale.plugins.openWindow('rdp'));
  const fallback = await pluginPage(application, 'rdp', 'main', 'window');
  await expect(fallback.locator('#new')).toBeEnabled({ timeout: 20000 });
  await expect(fallback.locator('#new')).toHaveAttribute('aria-label', 'New');
  assert.equal((await fallback.evaluate(() => window.anas.getInfo())).language, 'fr');
  results.push('Host French remains selectable after uninstall; a plugin without French falls back to English');
  results.push('Disable closes every view; reinstall uses only the new package language files');
  await writeFile('.local/languages-result.json', JSON.stringify({ date: new Date().toISOString(), results, directory }, null, 2));
  console.log(results.join('\n'));
} finally { await application?.close(); }
