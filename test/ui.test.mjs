import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { build } from 'esbuild';

const upstream = createRequire(resolve('.local/upstream/IronRDP/web-client/iron-remote-desktop/package.json'));
const { JSDOM } = upstream('jsdom');
const html = await readFile('src/ui/index.html', 'utf8');
const languageResources = Object.fromEntries(await Promise.all(['en', 'zh-CN'].map(async code => [code, JSON.parse(await readFile(`lang/${code}.json`, 'utf8'))])));
const compiled = await build({
  entryPoints: ['src/ui/app.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'synthetic-rdp', setup(builder) {
    builder.onResolve({ filter: /iron-remote-desktop.*\.js$/ }, () => ({ path: 'rdp', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const init = async () => {}; export const Backend = {};' }));
  } }],
});
const compiledProfiles = await build({ entryPoints: ['src/profiles.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { Profiles } = await import(`data:text/javascript;base64,${Buffer.from(compiledProfiles.outputFiles[0].text).toString('base64')}`);
async function profileStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rdp-ui-profiles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Profiles(directory);
  const profile = await store.call('profiles.save', { name:'Fixture', host:'test.invalid', username:'fixture', passwordAction:'remove' });
  return { store, profile };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'UI did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://rdp.invalid/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  const errors = [];
  const element = id => window.document.getElementById(id);
  const button = element('accept-certificate');
  const addListener = button.addEventListener.bind(button);
  button.addEventListener = (type, listener, settings) => addListener(type, event => {
    Promise.resolve(listener(event)).catch(error => errors.push(error));
  }, settings);
  let nextId = 0;
  let attempts = 0;
  let profile = { id: 'fixture', revision: 1, name: 'Fixture', host: 'test.invalid', port: 3389, username: 'fixture', domain: '', openMode: 'sidebar', hasPassword: false, ...options.profile };
  let profiles = options.empty ? [] : [profile, ...(options.extraProfiles ?? [])];
  const info = { language: 'en', theme: 'dark', fontSize: 14, view: { instanceId: options.manager ? 'main' : profile.id, location: 'sidebar' } };
  window.anas = {
    getInfo: async () => info,
    getLanguageResources: async () => ({ resources: { ...languageResources, ...options.languages }, errors: [] }),
    openView: async params => { calls.push({method:'openView',params}); if (options.openError) throw new Error('Open failed'); },
    data: { get: options.get ?? (async () => null), set: options.set ?? (async () => {}) },
    backend: { call: async (method, params) => {
      calls.push({ method, params });
      if (options.store && (method.startsWith('profiles.') || method.startsWith('trusts.'))) return options.store.call(method, params);
      if (method === 'profiles.list') return profiles;
      if (method === 'profiles.consumeLaunch') return options.launch?.(profile) ?? null;
      if (method === 'profiles.launch') return 'launch-token';
      if (method === 'profiles.delete') { profiles = profiles.filter(item => item.id !== params.id); return null; }
      if (method === 'profiles.move') {
        const i = profiles.findIndex(item => item.id === params.id); const j = i + params.direction;
        [profiles[i], profiles[j]] = [profiles[j], profiles[i]];
        return profiles;
      }
      if (method === 'profiles.save') {
        await options.set?.('connection');
        if (options.saveError) throw new Error(options.saveError);
        profile = { ...profile, ...params, id: params.id ?? 'fixture', hasPassword: params.passwordAction === 'set' || params.passwordAction === 'keep' && profile.hasPassword };
        const index = profiles.findIndex(item => item.id === profile.id);
        if (index < 0) profiles.push(profile); else profiles[index] = profile;
        return profile;
      }
      if (method === 'profiles.password') return options.password?.() ?? 'saved-secret';
      if (method === 'trusts.list') return [];
      if (method === 'trusts.save') { await options.set?.('certificate_trust'); return [params]; }
      if (method === 'create') return { id: String(++nextId), token: 'synthetic', proxy: 'ws://127.0.0.1:9/rdp' };
      if (method === 'status') return options.status?.(params) ?? { state: 'connection_failed', certificate: null };
      return null;
    } },
  };
  window.customElements.define('iron-remote-desktop', class extends window.HTMLElement {
    connectedCallback() {
      const config = new Proxy({}, { get: (_, key) => key === 'build' ? () => ({}) : () => config });
      const interaction = {
        setEnableClipboard() {}, setEnableAutoClipboard() {}, setVisibility() {}, shutdown() {},
        configBuilder: () => config,
        connect: async () => {
          attempts++;
          if (options.connect) return options.connect(attempts);
          return { run: () => new Promise(() => {}) };
        },
      };
      window.queueMicrotask(() => this.dispatchEvent(new window.CustomEvent('ready', { detail: { irgUserInteraction: interaction } })));
    }
  });
  await window.eval(`(async () => { ${compiled.outputFiles[0].text} })()`);
  element('host').value = 'test.invalid';
  element('username').value = 'fixture';
  return { window, info, element, calls, errors, submit: () => element('connection').dispatchEvent(new window.Event('submit', { cancelable: true })) };
}

test('a delayed failed connection cannot disconnect a newer session or display its certificate', async t => {
  const oldStatus = deferred();
  const ui = await fixture(t, {
    connect: attempt => attempt === 1 ? Promise.reject(new Error('synthetic failure')) : { run: () => new Promise(() => {}) },
    status: () => oldStatus.promise,
  });
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'status'));
  ui.element('disconnect').click();
  await until(() => !ui.element('connect').disabled);
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  oldStatus.resolve({ state: 'certificate_required', certificate: { sha256: 'a'.repeat(64), trusted: false } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.element('status').textContent, 'Connected');
  assert.equal(ui.element('trust').hidden, true);
  assert.deepEqual(ui.calls.filter(call => call.method === 'disconnect').map(call => call.params.id), ['1']);
});

test('canceling while settings are saving does not start a connection helper later', async t => {
  const saved = deferred();
  const ui = await fixture(t, { set: () => saved.promise });
  ui.submit();
  ui.element('disconnect').click();
  saved.resolve();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 0);
  assert.equal(ui.element('connect').disabled, false);
});

test('empty trust list does not prevent startup', async t => {
  const ui = await fixture(t);
  assert.equal(ui.element('error').hidden, true);
  assert.equal(ui.element('connect').disabled, false);
});

test('failed certificate persistence is visible and does not grant in-memory trust', async t => {
  let writes = 0;
  const ui = await fixture(t, {
    connect: () => Promise.reject(new Error('synthetic failure')),
    status: () => ({ state: 'certificate_required', certificate: { sha256: 'a'.repeat(64), trusted: false } }),
    set: async key => { if (key === 'certificate_trust') { writes++; throw new Error('synthetic disk failure'); } },
  });
  ui.submit();
  await until(() => !ui.element('trust').hidden && !ui.element('connect').disabled);
  ui.element('accept-certificate').click();
  await until(() => writes === 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.errors.length, 0, 'Persistence rejection escaped the UI');
  assert.equal(ui.element('error').hidden, false);
  assert.match(ui.element('error').textContent, /save.*certificate|certificate.*save/i);
  ui.submit();
  await until(() => ui.calls.filter(call => call.method === 'create').length === 2);
  assert.equal(ui.calls.filter(call => call.method === 'create')[1].params.trustedSha256, undefined);
});

test('home shows a list and only Start requests a connection in the saved location', async t => {
  const ui = await fixture(t, { manager: true, profile: { openMode: 'window' } });
  assert.equal(ui.element('profiles').querySelector('.profile-select').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.element('connection').hidden, true);
  assert.equal(ui.calls.some(call => call.method === 'profiles.launch'), false);
  ui.element('profiles').querySelector('[data-action="start"]').click();
  await until(() => ui.calls.some(call => call.method === 'openView'));
  assert.equal(ui.calls.find(call => call.method === 'openView').params.location, 'window');
  assert.equal(ui.calls.find(call => call.method === 'openView').params.instanceId, 'fixture');
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
  assert.equal(ui.calls.some(call => call.method === 'profiles.launch'), true);
});

test('failed opening cancels its launch request', async t => {
  const ui = await fixture(t, { manager: true, openError: true });
  ui.element('profiles').querySelector('[data-action="start"]').click();
  await until(() => !ui.element('error').hidden);
  assert.equal(ui.calls.find(call => call.method === 'profiles.cancelLaunch').params.token, 'launch-token');
});

test('new and edit are separate from the list; cancel discards unsaved changes', async t => {
  const ui = await fixture(t, { manager: true });
  ui.element('profiles').querySelector('[data-action="edit"]').click();
  await until(() => !ui.element('connection').hidden && !ui.element('save').disabled);
  assert.equal(ui.element('manager').hidden, true);
  ui.element('name').value = 'Unsaved';
  ui.element('cancel-edit').click();
  await until(() => !ui.element('manager').hidden);
  assert.equal(ui.element('profiles').querySelector('strong').textContent, 'Fixture');
  assert.equal(ui.calls.some(call => call.method === 'profiles.save'), false);
  ui.element('new').click();
  assert.equal(ui.element('name').value, '');
  assert.equal(ui.element('copy').disabled, true);
  ui.element('name').value = 'Created'; ui.element('host').value = 'new.invalid'; ui.element('username').value = 'test';
  ui.submit();
  await until(() => !ui.element('manager').hidden);
  assert.equal(ui.element('profiles').querySelector('strong').textContent, 'Created');
  assert.equal(ui.calls.some(call => call.method === 'profiles.launch'), false);
});

test('empty list, reorder boundaries and confirmed deletion update toolbar and persist through backend calls', async t => {
  const empty = await fixture(t, { manager: true, empty: true });
  assert.equal(empty.element('empty').hidden, false);
  for (const id of ['delete','up','down']) assert.equal(empty.element(id).disabled, true);
  empty.element('add-server').click();
  assert.equal(empty.element('connection').hidden, false);
  const second = { id:'second',revision:1,name:'Second',host:'second.invalid',port:3389,username:'test',domain:'',openMode:'sidebar',hasPassword:false };
  const ui = await fixture(t, { manager: true, extraProfiles: [second] });
  assert.equal(ui.element('up').disabled, true);
  assert.equal(ui.element('down').disabled, false);
  ui.element('down').click();
  await until(() => ui.element('status').textContent === 'Order saved');
  assert.equal(ui.calls.find(call => call.method === 'profiles.move').params.neighborId, 'second');
  assert.equal(ui.element('profiles').lastChild.dataset.id, 'fixture');
  assert.equal(ui.element('down').disabled, true);
  ui.element('delete').click(); ui.element('cancel-delete').click();
  assert.equal(ui.calls.some(call => call.method === 'profiles.delete'), false);
  ui.element('delete').click(); ui.element('confirm-delete').click();
  await until(() => ui.element('status').textContent === 'Profile deleted');
  assert.equal(ui.element('profiles').children.length, 1);
  assert.equal(ui.element('profiles').querySelector('button').getAttribute('aria-pressed'), 'true');
});

test('a one-shot launch uses a saved password; another Start never restarts an active connection', async t => {
  let pending = true;
  const ui = await fixture(t, { profile: { hasPassword:true }, launch: profile => { if (!pending) return null; pending = false; return profile; } });
  await until(() => ui.element('status').textContent === 'Connected');
  pending = true; ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => !pending);
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
  pending = true;
  ui.element('disconnect').click();
  await until(() => !ui.element('connect').disabled);
  assert.equal(pending, false, 'Disconnect must discard an unconsumed Start');
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
});

test('Start without a saved password prompts without creating a helper', async t => {
  let pending = true;
  const ui = await fixture(t, { launch: profile => { if (!pending) return null; pending = false; return profile; } });
  assert.equal(ui.element('status').textContent, 'Enter a password, then connect');
  assert.equal(ui.window.document.activeElement.id, 'password');
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
});

test('the header disconnect action stops the current session', async t => {
  const ui = await fixture(t);
  assert.equal(ui.element('manage'), null);
  assert.equal(ui.element('hint'), null);
  assert.equal(ui.element('disconnect').parentElement.tagName, 'HEADER');
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  ui.element('disconnect').click();
  await until(() => ui.element('status').textContent === 'Disconnected');
  assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 1);
  assert.equal(ui.element('disconnect').disabled, true);
});

test('host language changes translate an active session without reconnecting', async t => {
  const ui = await fixture(t);
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  ui.info.language = 'zh-CN';
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('status').textContent === '已连接');
  assert.equal(ui.element('disconnect').textContent, '断开');
  ui.info.language = 'fr';
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
});

test('a saved password stays out of the form and is retrieved only for a connection', async t => {
  const ui = await fixture(t, { profile: { hasPassword: true } });
  assert.equal(ui.element('password').value, '');
  assert.equal(ui.element('remember-password').checked, true);
  assert.equal(ui.calls.some(call => call.method === 'profiles.password'), false);
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.find(call => call.method === 'profiles.save').params.passwordAction, 'keep');
  assert.equal(ui.calls.some(call => call.method === 'profiles.password'), true);
  assert.equal(ui.element('password').value, '');
});

test('user language packs translate an active page with per-key English fallback and preserve profile names', async t => {
  const ui = await fixture(t, { languages: { fr: { version: 0, _meta: { name: 'Français' }, plugin: { name: 'Bureau distant' }, actions: { disconnect: 'Déconnecter', save: '' }, status: { connected: 'Connecté' } } } });
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  ui.info.language = 'fr-CA';
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('status').textContent === 'Connecté');
  assert.equal(ui.element('disconnect').textContent, 'Déconnecter');
  assert.equal(ui.element('save').textContent, 'Save');
  assert.equal(ui.element('title').textContent, 'Fixture');
  assert.equal(ui.element('desktop').getAttribute('aria-label'), 'Bureau distant');
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
});

test('certificate interpolation uses translated text while inserting addresses as plain text', async t => {
  const ui = await fixture(t, { languages: { fr: { version: 0, certificate: { verify: 'Vérifier {{host}}:{{port}}' } } },
    connect: () => Promise.reject(new Error('synthetic failure')),
    status: () => ({ state: 'certificate_required', certificate: { sha256: 'a'.repeat(64), trusted: false } }),
  });
  ui.info.language = 'fr';
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  ui.element('host').value = '<example>';
  ui.submit();
  await until(() => !ui.element('trust').hidden);
  assert.equal(ui.element('trust-message').textContent, 'Vérifier <example>:3389');
  assert.equal(ui.element('trust-message').children.length, 0);
});

test('conflicting edits are visible and never start a connection', async t => {
  const ui = await fixture(t, { saveError: 'PROFILE_CONFLICT' });
  ui.submit();
  await until(() => !ui.element('error').hidden);
  assert.match(ui.element('error').textContent, /another page/);
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
});

test('saving in a connection page then starting from the existing home uses the latest revision and location', async t => {
  const { store, profile } = await profileStore(t);
  const home = await fixture(t, { manager:true, store, profile });
  const connection = await fixture(t, { store, profile });
  connection.element('name').value = 'Updated server';
  connection.element('open-mode').value = 'window';
  connection.element('save').click();
  await until(() => connection.element('status').textContent === 'Profile saved');
  home.element('profiles').querySelector('[data-action="start"]').click();
  await until(() => home.calls.some(call => call.method === 'openView') || !home.element('error').hidden);
  assert.equal(home.element('error').hidden, true, home.element('error').textContent);
  const opened = home.calls.find(call => call.method === 'openView');
  assert.equal(opened.params.location, 'window');
  assert.equal(opened.params.title, 'Updated server');
  const [latest] = await store.call('profiles.list', {});
  assert.equal(home.calls.find(call => call.method === 'profiles.launch').params.revision, latest.revision);
  assert.equal(home.element('profiles').querySelector('strong').textContent, 'Updated server');
});

test('entering Edit loads the latest server, while competing unsaved edits remain protected', async t => {
  const { store, profile } = await profileStore(t);
  const home = await fixture(t, { manager:true, store, profile });
  const external = await store.call('profiles.save', { ...profile, name:'External edit', passwordAction:'keep' });
  home.element('profiles').querySelector('[data-action="edit"]').click();
  await until(() => !home.element('connection').hidden && !home.element('save').disabled);
  assert.equal(home.element('name').value, 'External edit');
  home.element('name').value = 'My draft';
  const winner = await store.call('profiles.save', { ...external, name:'Another edit', passwordAction:'keep' });
  home.element('save').click();
  await until(() => !home.element('error').hidden);
  assert.match(home.element('error').textContent, /another page/);
  assert.equal(home.element('name').value, 'My draft');
  assert.deepEqual(await store.call('profiles.list', {}), [winner]);
});

test('a deleted server in a stale home list cannot be started or recreated', async t => {
  const { store, profile } = await profileStore(t);
  const home = await fixture(t, { manager:true, store, profile });
  await store.call('profiles.delete', profile);
  home.element('profiles').querySelector('[data-action="start"]').click();
  await until(() => !home.element('error').hidden);
  assert.match(home.element('error').textContent, /deleted/);
  assert.equal(home.calls.some(call => call.method === 'openView'), false);
  assert.deepEqual(await store.call('profiles.list', {}), []);
});
