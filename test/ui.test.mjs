import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { build } from 'esbuild';

const html = await readFile('src/ui/index.html', 'utf8');
const languageResources = Object.fromEntries(await Promise.all(['en', 'zh-CN'].map(async code => [code, JSON.parse(await readFile(`lang/${code}.json`, 'utf8'))])));
const compiled = await build({
  entryPoints: ['src/ui/app.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'synthetic-rdp', setup(builder) {
    builder.onResolve({ filter: /^\.\/desktop$/ }, () => ({ path: 'rdp', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export class Desktop {
      constructor(container, connection, onState) { window.__remoteState = state => { if (state !== 'connected') this.available = false; onState(state); }; this.canvas = document.createElement('canvas'); container.append(this.canvas);
        this.ready = Promise.resolve().then(() => window.__attachDisplay()).then(() => { this.available = true; onState('connected'); }); }
      release() {}
      dispose() { this.available = false; this.canvas.remove(); }
    }` }));
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
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'UI did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://rdp.invalid/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  const navigation = options.navigation ?? {};
  window.HTMLElement.prototype.scrollIntoView = function(options) { calls.push({ method: 'scrollIntoView', params: { id: this.dataset.id, ...options } }); };
  const errors = [];
  const element = id => window.document.getElementById(id);
  const button = element('accept-certificate');
  const addListener = button.addEventListener.bind(button);
  button.addEventListener = (type, listener, settings) => addListener(type, event => {
    Promise.resolve(listener(event)).catch(error => errors.push(error));
  }, settings);
  let nextId = 0;
  let attempts = 0;
  let profile = { id: 'fixture', revision: 1, name: 'Fixture', host: 'test.invalid', port: 3389, username: 'fixture', domain: '', openMode: 'sidebar', runInBackground: false, hasPassword: false, ...options.profile };
  let profiles = options.empty ? [] : [profile, ...(options.extraProfiles ?? [])];
  const info = { language: 'en', theme: 'dark', fontSize: 14, view: { instanceId: options.manager ? 'main' : profile.id, location: options.location ?? 'sidebar' } };
  const viewLocations = new Map(options.manager ? [] : [[profile.id, info.view.location]]);
  let viewListener;
  let toolbarListener;
  let toolbar;
  let lifecycle;
  const context = { panelId: "panel", pageId: "page", location: info.view.location, phase: "preparing", restoreState: options.restore ?? null, view: { content: { instanceId: info.view.instanceId } } };
  window.anas = {
    getContext: async () => context,
    registerLifecycle: handlers => { lifecycle = handlers; },
    ready: async () => { await lifecycle.activate({ signal: new window.AbortController().signal, context }); context.phase = 'active'; viewListener?.(info.view); },
    failed: async () => { calls.push({ method: 'failed' }); },
    onViewChanged: listener => { viewListener = listener; return () => { viewListener = undefined; }; },
    setToolbar: async value => { await options.toolbar?.(value); toolbar = value; },
    onToolbarAction: listener => { toolbarListener = listener; return () => { toolbarListener = undefined; }; },
    getInfo: async () => info,
    getLanguageResources: async () => ({ resources: { ...languageResources, ...options.languages }, errors: [] }),
    openHome: async () => { calls.push({ method: 'openHome' }); },
    openView: async params => { calls.push({method:'openView',params}); if (options.openError) throw new Error('Open failed'); if (!viewLocations.has(params.instanceId)) viewLocations.set(params.instanceId, params.location); },
    moveView: async target => { const location = typeof target === 'string' ? target : target.location; const id = typeof target === 'string' ? info.view.instanceId : target.instanceId; calls.push({ method: 'moveView', params: { location, instanceId: id } }); await options.move?.(); viewLocations.set(id, location); },
    data: { get: options.get ?? (async () => null), set: options.set ?? (async () => {}) },
    backend: { call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'profiles.select') { navigation.request = { id: params.id, token: 'select-token' }; return null; }
      if (method === 'profiles.ackSelection') { if (navigation.request?.token === params.token) navigation.request = undefined; return null; }
      if (method === 'profiles.beginEdit' || method === 'profiles.endEdit') return null;
      if (options.store && (method.startsWith('profiles.') || method.startsWith('trusts.'))) return options.store.call(method, params);
      if (method === 'runtime.state') return { sessions: options.sessions?.() ?? [], openProfiles: options.openProfiles?.() ?? [], editingProfiles: options.editingProfiles?.() ?? [], selection: navigation.request };
      if (method === 'connection.setLocation') {
        await options.position?.();
        const location = viewLocations.get(params.id) ?? info.view.location;
        const saved = options.store ? await options.store.call('profiles.setOpenMode', { id: params.id, openMode: location }) : { ...profile, openMode: location };
        if (saved) profile = saved;
        return { location, profile: saved };
      }
      if (method === 'find') return options.find?.(params) ?? null;
      if (method === 'connection.close') return options.close?.(params) ?? null;
      if (method === 'disconnect') return options.disconnect?.(params) ?? null;
      if (method === 'profiles.list') return profiles;
      if (method === 'profiles.get') { await options.profileRead?.(); if (options.empty) throw new Error('PROFILE_MISSING'); return profile; }
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
      if (method === 'lease') return options.lease?.() ?? { owner: null, epoch: 0 };
      if (method === 'claim') { await options.claim?.(); return { owner: params.pageId, epoch: params.expectedEpoch + 1 }; }
      if (method === 'create') { await options.create?.(); return { id: String(++nextId), token: 'synthetic', url: 'ws://127.0.0.1:9/display' }; }
      if (method === 'status') return options.status?.(params) ?? { state: 'connected', certificate: null };
      return null;
    } },
  };
  window.__attachDisplay = async () => {
    attempts++;
    if (options.connect) return options.connect(attempts);
  };
  await window.eval(`(async () => { ${compiled.outputFiles[0].text} })()`);
  element('host').value = 'test.invalid';
  element('username').value = 'fixture';
  return { window, info, element, calls, errors, lifecycle: () => lifecycle, context, toolbar: () => toolbar, action: id => toolbarListener?.(id), hasToolbarListener: () => !!toolbarListener, move: location => { info.view.location = location; context.location = location; if (context.phase === 'active') viewLocations.set(profile.id, location); viewListener?.(info.view); }, hasViewListener: () => !!viewListener, submit: () => element(options.manager ? 'profile-editor' : 'connection').dispatchEvent(new window.Event('submit', { cancelable: true })) };
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

test('canceling while the latest profile is loading does not start a helper later', async t => {
  const saved = deferred();
  let pending = false;
  const ui = await fixture(t, { profileRead: () => pending ? saved.promise : undefined });
  pending = true;
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
  assert.equal(ui.calls.find(call => call.method === 'openView').params.icon, 'assets/desktop.svg');
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
  await until(() => !ui.element('profile-editor').hidden && !ui.element('save').disabled);
  assert.equal(ui.element('manager').hidden, true);
  ui.element('name').value = 'Unsaved';
  ui.element('cancel-edit').click();
  await until(() => !ui.element('manager').hidden);
  assert.equal(ui.element('profiles').querySelector('strong').textContent, 'Fixture');
  assert.equal(ui.calls.some(call => call.method === 'profiles.save'), false);
  ui.element('new').click();
  assert.equal(ui.element('name').value, '');
  assert.equal(ui.element('copy'), null);
  assert.equal(ui.element('reload'), null);
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
  assert.equal(empty.element('profile-editor').hidden, false);
  const second = { id:'second',revision:1,name:'Second',host:'second.invalid',port:3389,username:'test',domain:'',openMode:'sidebar',hasPassword:false };
  const ui = await fixture(t, { manager: true, extraProfiles: [second] });
  assert.equal(ui.element('up').disabled, true);
  assert.equal(ui.element('down').disabled, false);
  ui.element('down').click();
  await until(() => ui.element('status').textContent === 'Order saved');
  assert.equal(ui.calls.find(call => call.method === 'profiles.move').params.neighborId, 'second');
  assert.equal(ui.element('profiles').lastChild.dataset.id, 'fixture');
  assert.equal(ui.element('down').disabled, true);
  ui.element('delete').click();
  await until(() => !ui.element('delete-confirm').hidden && !ui.element('cancel-delete').disabled);
  ui.element('cancel-delete').click();
  assert.equal(ui.calls.some(call => call.method === 'profiles.delete'), false);
  ui.element('delete').click();
  await until(() => !ui.element('delete-confirm').hidden && !ui.element('confirm-delete').disabled);
  ui.element('confirm-delete').click();
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
  await until(() => ui.element('status').textContent === 'Enter a password, then connect');
  assert.equal(ui.window.document.activeElement.id, 'session-password');
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
});

test('the header disconnect action stops the current session', async t => {
  const ui = await fixture(t);
  assert.equal(ui.element('manage'), null);
  assert.equal(ui.element('hint'), null);
  assert.equal(ui.element('disconnect').closest('header'), ui.element('connection-header'));
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
  assert.equal(ui.element('disconnect').getAttribute('aria-label'), '断开');
  ui.info.language = 'fr';
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
});

test('a saved password stays out of the form and is retrieved only for a connection', async t => {
  const ui = await fixture(t, { profile: { hasPassword: true } });
  assert.equal(ui.element('password').value, '');
  assert.equal(ui.element('session-password-field').hidden, true);
  assert.equal(ui.calls.some(call => call.method === 'profiles.password'), false);
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.some(call => call.method === 'profiles.save'), false);
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
  assert.equal(ui.element('disconnect').getAttribute('aria-label'), 'Déconnecter');
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
  await ui.window.anas.backend.call('profiles.save', { host: '<example>', passwordAction: 'remove' });
  ui.submit();
  await until(() => !ui.element('trust').hidden);
  assert.equal(ui.element('trust-message').textContent, 'Vérifier <example>:3389');
  assert.equal(ui.element('trust-message').children.length, 0);
});

test('conflicting edits are visible and never start a connection', async t => {
  const ui = await fixture(t, { manager: true, saveError: 'PROFILE_CONFLICT' });
  ui.element('profiles').querySelector('[data-action="edit"]').click();
  await until(() => !ui.element('profile-editor').hidden && !ui.element('save').disabled);
  ui.submit();
  await until(() => !ui.element('error').hidden);
  assert.match(ui.element('error').textContent, /profile changed/gi);
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
});

test('saving in another editor then starting from an existing home uses the latest revision and location', async t => {
  const { store, profile } = await profileStore(t);
  const home = await fixture(t, { manager:true, store, profile });
  const connection = await fixture(t, { manager: true, store, profile });
  connection.element('profiles').querySelector('[data-action="edit"]').click();
  await until(() => !connection.element('profile-editor').hidden && !connection.element('save').disabled);
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
  await until(() => !home.element('profile-editor').hidden && !home.element('save').disabled);
  assert.equal(home.element('name').value, 'External edit');
  home.element('name').value = 'My draft';
  const winner = await store.call('profiles.save', { ...external, name:'Another edit', passwordAction:'keep' });
  home.element('save').click();
  await until(() => !home.element('error').hidden);
  assert.match(home.element('error').textContent, /profile changed/gi);
  assert.equal(home.element('name').value, 'My draft');
  assert.deepEqual(await store.call('profiles.list', {}), [winner]);
  assert.equal(home.element('reload-conflict').hidden, false);
  assert.match(home.element('error').textContent, /discards unsaved edits/);
  home.element('reload-conflict').click();
  await until(() => home.element('error').hidden && !home.element('save').disabled);
  assert.equal(home.element('name').value, winner.name);
  assert.equal(home.element('profile-editor').hidden, false);
  home.element('name').value = 'After reload';
  home.submit();
  await until(() => home.element('status').textContent === 'Profile saved');
  assert.equal((await store.call('profiles.get', profile)).name, 'After reload');
  assert.equal(home.calls.some(call => call.method === 'create'), false);
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

test('moving a connected page preserves its session and consumes launch requests at the new location', async t => {
  const ui = await fixture(t);
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  for (const location of ['window', 'sidebar', 'window']) {
    ui.move(location);
    const start = ui.calls.length;
    ui.window.dispatchEvent(new ui.window.Event('focus'));
    await until(() => ui.calls.slice(start).some(call => call.method === 'profiles.consumeLaunch' && call.params.location === location));
    assert.equal(ui.element('status').textContent, 'Connected');
  }
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 0);
  assert.equal(ui.hasViewListener(), true);
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 0);
  assert.equal(ui.hasViewListener(), false);
});


test('window toolbar follows the live connection without recreating it when moved', async t => {
  const ui = await fixture(t);
  assert.equal(ui.element('connection-header').hidden, false);
  ui.submit();
  await until(() => ui.toolbar()?.status.label === 'Connected');
  const desktop = ui.element('desktop').firstElementChild;
  for (const location of ['window', 'sidebar', 'window']) {
    ui.move(location);
    await until(() => ui.element('connection-header').hidden === (location === 'window'));
    assert.equal(ui.element('desktop').firstElementChild, desktop);
    assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').disabled, false);
  }
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 0);
  await ui.action('disconnect');
  await until(() => ui.toolbar().status.label === 'Disconnected');
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').disabled, true);
  assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 1);
  assert.equal(ui.element('desktop').firstElementChild, null);
});

test('titlebar cancel prevents a delayed handshake from restoring a canceled session', async t => {
  const handshake = deferred();
  const ui = await fixture(t, { location: 'window', connect: () => handshake.promise });
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'create'));
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').label, 'Cancel');
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').icon, 'x');
  await ui.action('disconnect');
  handshake.resolve({ run: () => new Promise(() => {}) });
  await until(() => ui.toolbar().status.label === 'Disconnected');
  assert.equal(ui.element('connect').disabled, false);
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').disabled, true);
});

test('a rejected toolbar update keeps connection controls visible and reports failure', async t => {
  const ui = await fixture(t, { location: 'window', toolbar: () => { throw new Error('Unavailable'); } });
  await until(() => !ui.element('toolbar-error').hidden);
  assert.equal(ui.element('connection-header').hidden, false);
  assert.match(ui.element('toolbar-error').textContent, /controls could not be updated/i);
});

test('home keeps its header and page teardown unregisters action listeners', async t => {
  const ui = await fixture(t, { manager: true, location: 'window' });
  assert.equal(ui.toolbar(), null);
  assert.equal(ui.element('connection-header').hidden, false);
  assert.equal(ui.hasToolbarListener(), true);
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  assert.equal(ui.hasToolbarListener(), false);
});

test('handoff keeps an unsaved draft and detaches without disconnecting the resource', async t => {
  const ui = await fixture(t, { manager: true });
  ui.element('new').click();
  ui.element('name').value = 'unsaved latest';
  ui.element('run-in-background').checked = true;
  ui.element('password').value = 'in-memory-only';
  const controller = new ui.window.AbortController();
  const state = await ui.lifecycle().prepare({ signal: controller.signal, context: ui.context });
  assert.equal(state.view.fields.name.value, 'unsaved latest');
  assert.equal(state.view.fields['run-in-background'].checked, true);
  assert.equal(state.view.fields.password.value, 'in-memory-only');
  await ui.lifecycle().resume({ signal: controller.signal, context: ui.context });
  await ui.lifecycle().dispose({ signal: controller.signal, reason: 'moved', context: ui.context });
  assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 0);
});


test('handoff waits for the whole connection operation, including pending input ownership', async t => {
  const ownership = deferred();
  const ui = await fixture(t, { claim: () => ownership.promise });
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'claim'));
  let prepared = false;
  const state = ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal }).then(value => { prepared = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(prepared, false);
  ownership.resolve();
  assert.equal((await state).session.id, '1');
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
});


test('a terminal session can move and rollback to usable disconnected controls', async t => {
  let terminal = false;
  const ui = await fixture(t, {
    status: () => ({ state: terminal ? 'closed' : 'connected', certificate: null }),
    lease: () => { if (terminal) throw new Error('RDP_SESSION_CLOSED'); return {owner:'page',epoch:1}; },
  });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  terminal = true; ui.window.__remoteState('RDP_DISPLAY_CLOSED');
  const signal = new ui.window.AbortController().signal;
  const restored = await ui.lifecycle().prepare({ signal });
  assert.equal(restored.session, null);
  await ui.lifecycle().resume({ signal });
  assert.equal(ui.element('connect').disabled, false);
  terminal = false; ui.submit();
  await until(() => ui.calls.filter(c => c.method === 'create').length === 2);
  await until(() => ui.element('status').textContent === 'Connected');
});

test('cancelled handoff resumes a pending handshake without claiming its unready display', async t => {
  const handshake = deferred(); let connected = false;
  const ui = await fixture(t, { connect: () => handshake.promise,
    claim: () => { assert.equal(connected, true, 'Do not claim before the first frame'); } });
  ui.submit(); await until(() => ui.calls.some(c => c.method === 'create'));
  const controller = new ui.window.AbortController();
  const preparing = ui.lifecycle().prepare({ signal: controller.signal });
  controller.abort(); await assert.rejects(preparing);
  await ui.lifecycle().resume({ signal: new ui.window.AbortController().signal });
  assert.equal(ui.calls.some(c => c.method === 'claim'), false);
  connected = true; handshake.resolve();
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.filter(c => c.method === 'claim').length, 1);
  assert.equal(ui.calls.filter(c => c.method === 'create').length, 1);
  assert.equal(ui.calls.filter(c => c.method === 'disconnect').length, 0);
});

test('rollback reattaches a lost display without recreating its live resource', async t => {
  let attachments = 0;
  const ui = await fixture(t, { connect: () => { attachments++; } });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  ui.window.__remoteState('RDP_DISPLAY_CLOSED');
  const signal = new ui.window.AbortController().signal;
  await ui.lifecycle().prepare({ signal });
  await ui.lifecycle().resume({ signal });
  assert.equal(attachments, 2);
  assert.equal(ui.calls.filter(c => c.method === 'create').length, 1);
  assert.equal(ui.calls.filter(c => c.method === 'disconnect').length, 0);
  assert.equal(ui.element('status').textContent, 'Connected');
});

test('handoff restores a live session and its fields after the saved profile was deleted', async t => {
  const source = await fixture(t);
  source.submit(); await until(() => source.element('status').textContent === 'Connected');
  const restored = await source.lifecycle().prepare({ signal: new source.window.AbortController().signal });
  const target = await fixture(t, { empty: true, restore: restored });
  assert.equal(target.context.phase, 'active');
  assert.equal(target.calls.some(c => c.method === 'failed'), false);
  assert.equal(target.calls.filter(c => c.method === 'claim').length, 1);
  assert.equal(target.calls.some(c => c.method === 'create'), false);
  assert.equal(target.element('title').textContent, restored.view.profile.name);
  assert.equal(target.element('profile-editor').hidden, true);
  await target.action('disconnect');
  assert.equal(target.calls.filter(c => c.method === 'disconnect').length, 1);
});

test('a resource ending during claim does not prevent rollback from restoring controls', async t => {
  let terminal = false, failClaim = false;
  const ui = await fixture(t, { status: () => ({ state: terminal ? 'closed' : 'connected', certificate: null }),
    claim: () => { if (failClaim) { terminal = true; throw new Error('RDP_SESSION_CLOSED'); } } });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  failClaim = true;
  await ui.lifecycle().resume({ signal: new ui.window.AbortController().signal });
  assert.equal(ui.element('connect').disabled, false);
  assert.equal(ui.element('status').textContent, 'Disconnected');
});


test('Connect after a lost display reattaches instead of disconnecting or replacing the session', async t => {
  let attempts = 0;
  const ui = await fixture(t, { connect: () => { if (++attempts === 2) throw new Error('display unavailable'); } });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  ui.window.__remoteState('RDP_DISPLAY_CLOSED');
  assert.equal(ui.element('disconnect').disabled, false);
  ui.submit(); await until(() => attempts === 2 && !ui.element('connect').disabled);
  assert.equal(ui.calls.filter(c => c.method === 'disconnect').length, 0);
  ui.submit(); await until(() => attempts === 3 && ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.filter(c => c.method === 'create').length, 1);
  assert.equal(ui.calls.filter(c => c.method === 'disconnect').length, 0);
});


for (const ended of ['closed', 'connection_failed', 'missing']) {
  test(`a remotely ended session (${ended}) disables both disconnect actions and retains its last frame`, async t => {
    let terminal = false;
    const ui = await fixture(t, { location: 'window', status: () => {
      if (terminal && ended === 'missing') throw new Error('RDP_SESSION_CLOSED');
      return { state: terminal ? ended : 'connected', certificate: null };
    } });
    ui.submit();
    await until(() => ui.element('status').textContent === 'Connected' && ui.element('disconnect').getAttribute('aria-label') === 'Disconnect');
    const canvas = ui.element('desktop').querySelector('canvas');
    terminal = true;
    ui.window.__remoteState('RDP_DISPLAY_CLOSED');
    await until(() => ui.element('disconnect').disabled && ui.toolbar().actions.find(action => action.id === 'disconnect').disabled);
    assert.equal(ui.element('desktop').querySelector('canvas'), canvas);
    assert.equal(ui.element('connect').disabled, false);
    ui.element('disconnect').click();
    await ui.action('disconnect');
    assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 0);
    assert.equal(ui.element('desktop').querySelector('canvas'), canvas);
    terminal = false;
    ui.submit();
    await until(() => ui.element('status').textContent === 'Connected' && ui.element('disconnect').getAttribute('aria-label') === 'Disconnect');
    assert.equal(ui.element('disconnect').disabled, false);
    assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').disabled, false);
    assert.equal(ui.calls.filter(call => call.method === 'create').length, 2);
  });
}

test('refresh reconciles a native session that ends after its display socket closes', async t => {
  let terminal = false;
  const ui = await fixture(t, { status: () => ({ state: terminal ? 'closed' : 'connected', certificate: null }) });
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected' && ui.element('disconnect').getAttribute('aria-label') === 'Disconnect');
  const canvas = ui.element('desktop').querySelector('canvas');
  ui.window.__remoteState('RDP_DISPLAY_CLOSED');
  await until(() => ui.calls.some(call => call.method === 'status'));
  assert.equal(ui.element('disconnect').disabled, false, 'a still-live resource remains stoppable');
  terminal = true;
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('disconnect').disabled && ui.toolbar().actions.find(action => action.id === 'disconnect').disabled);
  assert.equal(ui.element('desktop').querySelector('canvas'), canvas);
});

test('a delayed terminal status cannot disable a newer connection', async t => {
  const oldStatus = deferred();
  const ui = await fixture(t, { status: ({ id }) => id === '1' ? oldStatus.promise : { state: 'connected', certificate: null } });
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected' && ui.element('disconnect').getAttribute('aria-label') === 'Disconnect');
  ui.window.__remoteState('RDP_DISPLAY_CLOSED');
  await until(() => ui.calls.some(call => call.method === 'status'));
  await ui.action('disconnect');
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected' && ui.element('disconnect').getAttribute('aria-label') === 'Disconnect');
  oldStatus.resolve({ state: 'closed', certificate: null });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.element('status').textContent, 'Connected');
  assert.equal(ui.element('disconnect').disabled, false);
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').disabled, false);
  assert.ok(ui.element('desktop').querySelector('canvas'));
});


test('double-clicking a server starts it once, while a single click only selects it', async t => {
  const ui = await fixture(t, { manager: true, profile: { openMode: 'window' } });
  const row = ui.element('profiles').querySelector('.profile-select');
  row.click();
  assert.equal(ui.calls.some(call => call.method === 'openView'), false);
  row.click();
  row.dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
  await until(() => ui.calls.some(call => call.method === 'openView'));
  assert.equal(ui.calls.filter(call => call.method === 'profiles.launch').length, 1);
  assert.equal(ui.calls.filter(call => call.method === 'openView').length, 1);
  assert.equal(ui.calls.find(call => call.method === 'openView').params.location, 'window');
});

test('connecting reads the latest profile without writing it; temporary passwords remain in memory', async t => {
  const { store, profile } = await profileStore(t);
  const ui = await fixture(t, { store, profile });
  const updated = await store.call('profiles.save', { ...profile, host: 'updated.invalid', username: 'updated-user', passwordAction: 'keep' });
  ui.element('session-password').value = 'temporary-only';
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  const created = ui.calls.find(call => call.method === 'create').params;
  assert.equal(created.host, updated.host);
  assert.equal(created.username, updated.username);
  assert.equal(created.password, 'temporary-only');
  assert.equal(ui.calls.some(call => call.method === 'profiles.save'), false);
  assert.deepEqual(await store.call('profiles.list', {}), [updated]);
  assert.equal(ui.element('session-password').value, '');
  assert.equal(ui.element('profile-editor').hidden, true);
  assert.equal(ui.element('connection').hidden, true);
  await ui.action('disconnect');
  assert.equal(ui.element('profile-editor').hidden, true);
  assert.equal(ui.element('connection').hidden, false);
  assert.equal(ui.element('connect').textContent, 'Reconnect');
});

test('editing after the connection page is closed changes the next connection', async t => {
  const { store, profile } = await profileStore(t);
  const connection = await fixture(t, { store, profile });
  connection.submit(); await until(() => connection.element('status').textContent === 'Connected');
  await connection.action('disconnect');
  await connection.lifecycle().dispose({ signal: new connection.window.AbortController().signal, reason: 'closed' });
  const editor = await fixture(t, { manager: true, store, profile });
  editor.element('profiles').querySelector('[data-action="edit"]').click();
  await until(() => !editor.element('profile-editor').hidden && !editor.element('save').disabled);
  editor.element('host').value = 'next.invalid';
  editor.submit();
  await until(() => editor.element('status').textContent === 'Profile saved');
  assert.equal(editor.calls.some(call => ['create', 'disconnect', 'profiles.launch'].includes(call.method)), false);
  const reopened = await fixture(t, { store, profile });
  reopened.submit(); await until(() => reopened.element('status').textContent === 'Connected');
  assert.equal(reopened.calls.find(call => call.method === 'create').params.host, 'next.invalid');
});

test('connection handoff retains only its temporary credential and session presentation', async t => {
  const source = await fixture(t);
  source.element('session-password').value = 'unsaved-password';
  source.element('session-remember-password').checked = true;
  const restored = await source.lifecycle().prepare({ signal: new source.window.AbortController().signal });
  const target = await fixture(t, { restore: restored });
  assert.equal(target.element('session-password').value, 'unsaved-password');
  assert.equal(target.element('session-remember-password').checked, true);
  assert.equal(target.calls.some(call => call.method === 'profiles.savePassword'), false);
  assert.equal(target.element('profile-editor').hidden, true);
  assert.equal(target.element('connection').hidden, false);
  assert.equal(target.calls.some(call => call.method === 'profiles.save'), false);
});

test('opening server profiles from a live connection preserves the session', async t => {
  const ui = await fixture(t);
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  await ui.action('profiles');
  assert.equal(ui.calls.filter(call => call.method === 'openHome').length, 1);
  assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 0);
  assert.equal(ui.element('status').textContent, 'Connected');
});


test('Start after a display interruption reattaches the original session even if its profile was edited', async t => {
  const { store, profile } = await profileStore(t);
  const ui = await fixture(t, { store, profile });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  ui.window.__remoteState('RDP_DISPLAY_CLOSED');
  const changed = await store.call('profiles.save', { ...profile, name: 'Next session', host: 'next.invalid', passwordAction: 'keep' });
  await store.call('profiles.launch', changed);
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.element('title').textContent, profile.name);
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(ui.calls.filter(call => call.method === 'disconnect').length, 0);
});


function contextMenu(ui, id) {
  const row = ui.element('profiles').querySelector(`[data-id="${id}"]`);
  row.dispatchEvent(new ui.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  return row;
}
function menuItem(ui, label) {
  return Array.from(ui.window.document.querySelectorAll('[role="menuitem"]')).find(item => item.textContent === label);
}

test('the row menu copies the pointed-to server, preserves its saved credentials, and never connects', async t => {
  const { store, profile } = await profileStore(t);
  const second = await store.call('profiles.save', { ...profile, id: undefined, revision: undefined,
    name: 'Second', host: 'second.invalid', passwordAction: 'set', password: 'copy-secret' });
  const ui = await fixture(t, { manager: true, store, profile });
  assert.equal(ui.element('profiles').querySelector('[aria-pressed="true"]').closest('li').dataset.id, profile.id);
  contextMenu(ui, second.id);
  assert.equal(ui.element('profiles').querySelector('[aria-pressed="true"]').closest('li').dataset.id, second.id);
  menuItem(ui, 'Copy').click();
  await until(() => ui.element('status').textContent === 'Profile copied');
  const all = await store.call('profiles.list', {});
  assert.equal(all.length, 3);
  const copy = all[2];
  assert.equal(copy.name, 'Second copy');
  assert.equal(copy.host, second.host);
  assert.equal(await store.call('profiles.password', copy), 'copy-secret');
  assert.equal(ui.element('profiles').querySelector('[aria-pressed="true"]').closest('li').dataset.id, copy.id);
  assert.equal(ui.window.document.querySelector('[role="menu"]'), null);
  assert.equal(ui.calls.some(call => ['create', 'profiles.launch'].includes(call.method)), false);
});

test('row menu reordering disables boundaries and delete still requires confirmation for that row', async t => {
  const { store, profile } = await profileStore(t);
  const second = await store.call('profiles.save', { ...profile, id: undefined, name: 'Second', passwordAction: 'remove' });
  const ui = await fixture(t, { manager: true, store, profile });
  contextMenu(ui, profile.id);
  assert.equal(menuItem(ui, 'Move up').disabled, true);
  assert.equal(menuItem(ui, 'Move down').disabled, false);
  menuItem(ui, 'Move down').click();
  await until(() => ui.element('status').textContent === 'Order saved');
  assert.deepEqual((await store.call('profiles.list', {})).map(item => item.id), [second.id, profile.id]);
  contextMenu(ui, profile.id);
  assert.equal(menuItem(ui, 'Move down').disabled, true);
  contextMenu(ui, second.id);
  menuItem(ui, 'Delete').click();
  await until(() => !ui.element('delete-confirm').hidden && !ui.element('confirm-delete').disabled);
  assert.match(ui.element('delete-message').textContent, /Second/);
  assert.equal((await store.call('profiles.list', {})).length, 2);
  ui.element('cancel-delete').click();
  assert.equal(ui.element('delete-confirm').hidden, true);
  contextMenu(ui, second.id);
  menuItem(ui, 'Delete').click();
  await until(() => !ui.element('delete-confirm').hidden && !ui.element('confirm-delete').disabled);
  ui.element('confirm-delete').click();
  await until(() => ui.element('status').textContent === 'Profile deleted');
  assert.deepEqual((await store.call('profiles.list', {})).map(item => item.id), [profile.id]);
  assert.equal(ui.calls.some(call => call.method === 'disconnect'), false);
});

test('the row menu supports keyboard navigation, Escape focus return, outside dismissal and handoff cleanup', async t => {
  const ui = await fixture(t, { manager: true });
  const row = ui.element('profiles').querySelector('.profile-select');
  row.focus();
  row.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(ui.window.document.activeElement.textContent, 'Start in sidebar');
  const menu = ui.window.document.querySelector('[role="menu"]');
  menu.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(ui.window.document.activeElement.textContent, 'Delete');
  menu.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(ui.window.document.activeElement.textContent, 'Copy', 'disabled ordering items must be skipped');
  menu.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(ui.window.document.querySelector('[role="menu"]'), null);
  assert.equal(ui.window.document.activeElement, row);
  contextMenu(ui, 'fixture');
  ui.element('new').dispatchEvent(new ui.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(ui.window.document.querySelector('[role="menu"]'), null);
  contextMenu(ui, 'fixture');
  await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal });
  assert.equal(ui.window.document.querySelector('[role="menu"]'), null);
});

test('the row menu exposes the same Start and Edit operations and follows the language', async t => {
  const ui = await fixture(t, { manager: true });
  contextMenu(ui, 'fixture');
  menuItem(ui, 'Edit').click();
  await until(() => !ui.element('profile-editor').hidden && !ui.element('save').disabled);
  assert.equal(ui.element('copy'), null);
  assert.equal(ui.element('reload'), null);
  ui.element('cancel-edit').click();
  await until(() => !ui.element('manager').hidden && !ui.element('new').disabled);
  ui.info.language = 'zh-CN'; ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('save').textContent === '保存');
  contextMenu(ui, 'fixture');
  assert.ok(menuItem(ui, '复制'));
  menuItem(ui, '侧边栏启动').click();
  await until(() => ui.calls.some(call => call.method === 'openView'));
  assert.equal(ui.calls.filter(call => call.method === 'profiles.launch').length, 1);
});


test('remembering a connection password is opt-in and saves without editing the server', async t => {
  const { store, profile } = await profileStore(t);
  const ui = await fixture(t, { store, profile });
  assert.equal(ui.element('session-remember-password').checked, false);
  ui.element('session-password').value = 'remember-this';
  ui.element('session-remember-password').checked = true;
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  const saved = await store.call('profiles.get', { id: profile.id });
  assert.deepEqual(saved, { ...profile, revision: profile.revision + 1, hasPassword: true });
  assert.equal(await store.call('profiles.password', saved), 'remember-this');
  assert.equal(ui.calls.find(call => call.method === 'create').params.password, 'remember-this');
  assert.equal(ui.calls.filter(call => call.method === 'profiles.savePassword').length, 1);
  assert.equal(ui.calls.some(call => call.method === 'profiles.save'), false);
  assert.equal(ui.element('session-password').value, '');
  assert.equal(ui.element('session-remember-password').checked, false);
  await ui.action('disconnect');
  assert.equal(ui.element('session-remember-field').hidden, true);
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.filter(call => call.method === 'create')[1].params.password, 'remember-this');
  assert.equal(ui.calls.filter(call => call.method === 'profiles.savePassword').length, 1);
});

test('unchecking Remember uses a replacement password temporarily without removing the saved one', async t => {
  const { store, profile } = await profileStore(t);
  const saved = await store.call('profiles.savePassword', { ...profile, password: 'existing-secret' });
  const ui = await fixture(t, { store, profile: saved, connect: attempt => { if (attempt === 1) throw new Error('rejected'); }, status: () => ({ state: 'closed' }) });
  ui.submit();
  await until(() => !ui.element('error').hidden && !ui.element('connect').disabled);
  assert.equal(ui.element('session-remember-field').hidden, false);
  ui.element('session-password').value = 'temporary-replacement';
  ui.element('session-remember-password').checked = true;
  ui.element('session-remember-password').checked = false;
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.filter(call => call.method === 'create')[1].params.password, 'temporary-replacement');
  assert.equal(ui.calls.some(call => call.method === 'profiles.savePassword'), false);
  assert.equal(await store.call('profiles.password', saved), 'existing-secret');
});

test('a deleted connection profile cannot be recreated by Remember and keeps the input for recovery', async t => {
  const { store, profile } = await profileStore(t);
  const ui = await fixture(t, { store, profile });
  await store.call('profiles.delete', profile);
  ui.element('session-password').value = 'do-not-lose';
  ui.element('session-remember-password').checked = true;
  ui.submit();
  await until(() => !ui.element('error').hidden && !ui.element('connect').disabled);
  assert.match(ui.element('error').textContent, /deleted/);
  assert.equal(ui.element('session-remember-password').disabled, true);
  assert.equal(ui.element('session-password').value, 'do-not-lose');
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
  assert.deepEqual(await store.call('profiles.list', {}), []);
});

test('a failed password save reports an error, retains the choice, and never starts a connection', async t => {
  const { store, profile } = await profileStore(t);
  const ui = await fixture(t, { profile, store: { call: (method, params) => {
    if (method === 'profiles.savePassword') throw new Error('PROFILE_WRITE_FAILED');
    return store.call(method, params);
  } } });
  ui.element('session-password').value = 'retry-this';
  ui.element('session-remember-password').checked = true;
  ui.submit();
  await until(() => !ui.element('error').hidden && !ui.element('connect').disabled);
  assert.match(ui.element('error').textContent, /Profile operation failed/);
  assert.equal(ui.element('session-password').value, 'retry-this');
  assert.equal(ui.element('session-remember-password').checked, true);
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
  assert.deepEqual(await store.call('profiles.list', {}), [profile]);
});

test('a concurrent edit during password save wins without being overwritten', async t => {
  const { store, profile } = await profileStore(t);
  let winner;
  const ui = await fixture(t, { profile, store: { call: async (method, params) => {
    if (method === 'profiles.savePassword') winner = await store.call('profiles.save', { ...profile, name: 'New name', passwordAction: 'keep' });
    return store.call(method, params);
  } } });
  ui.element('session-password').value = 'stale';
  ui.element('session-remember-password').checked = true;
  ui.submit();
  await until(() => !ui.element('error').hidden && !ui.element('connect').disabled);
  assert.match(ui.element('error').textContent, /profile changed/);
  assert.deepEqual(await store.call('profiles.list', {}), [winner]);
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
  ui.element('reload-conflict').click();
  await until(() => ui.element('error').hidden && !ui.element('connect').disabled);
  assert.equal(ui.element('title').textContent, winner.name);
  assert.equal(ui.element('session-password').value, 'stale');
  assert.equal(ui.element('session-remember-password').checked, true);
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
});

test('cancelling an in-flight password save does not start a late connection', async t => {
  const { store, profile } = await profileStore(t);
  const pending = deferred();
  const ui = await fixture(t, { profile, store: { call: async (method, params) => {
    if (method === 'profiles.savePassword') await pending.promise;
    return store.call(method, params);
  } } });
  ui.element('session-password').value = 'explicitly-saved';
  ui.element('session-remember-password').checked = true;
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'profiles.savePassword'));
  await ui.action('disconnect');
  pending.resolve();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
  assert.equal(ui.element('status').textContent, 'Disconnected');
});


test('conflict Reload is localized and preserves the draft when the profile was deleted', async t => {
  const { store, profile } = await profileStore(t);
  const ui = await fixture(t, { manager: true, store, profile });
  assert.equal(ui.element('reload-conflict').hidden, true);
  ui.element('profiles').querySelector('[data-action="edit"]').click();
  await until(() => !ui.element('profile-editor').hidden && !ui.element('save').disabled);
  ui.element('name').value = 'Keep my draft';
  const winner = await store.call('profiles.save', { ...profile, name: 'Changed', passwordAction: 'keep' });
  ui.submit();
  await until(() => !ui.element('error').hidden && !ui.element('save').disabled);
  ui.info.language = 'zh-CN';
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('reload-conflict').textContent === '重新加载');
  assert.match(ui.element('error').textContent, /放弃未保存的修改/);
  await store.call('profiles.delete', winner);
  ui.element('reload-conflict').click();
  await until(() => /配置已删除/.test(ui.element('error').textContent));
  assert.equal(ui.element('name').value, 'Keep my draft');
  assert.equal(ui.element('reload-conflict').hidden, true);
  assert.deepEqual(await store.call('profiles.list', {}), []);
});


const runningFixture = (state = 'connected') => ({ id: 'resource', state, profile: { id: 'fixture', name: 'Fixture', host: 'test.invalid', port: 3389, username: 'fixture', domain: '', openMode: 'sidebar' } });
const displayFixture = { id: 'resource', url: 'ws://127.0.0.1:9/display', token: 'synthetic' };

test('row status follows remote disconnection and the presence of its own desktop page', async t => {
  let resources = [runningFixture()];
  let views = ['fixture'];
  const ui = await fixture(t, { manager: true, sessions: () => resources, openProfiles: () => views });
  const badge = ui.element('profiles').querySelector('.profile-status');
  const choose = ui.element('profiles').querySelector('.profile-select'); choose.focus();
  assert.equal(badge.textContent, 'Connected');
  assert.equal(badge.hidden, false);
  resources = [];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => badge.textContent === 'Disconnected' && !badge.hidden);
  views = ['another-server'];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => badge.hidden && badge.textContent === '');
  assert.equal(ui.window.document.activeElement, choose);
  views = ['fixture'];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => badge.textContent === 'Disconnected' && !badge.hidden);
  views = []; resources = [runningFixture('ready')];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => badge.textContent === 'Connecting…' && !badge.hidden);
  resources = [runningFixture()];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => badge.textContent === 'Connected' && !badge.hidden);
});

test('running rows show status and resume without launching or authenticating; editing is hidden and deletion is disabled', async t => {
  for (const state of ['starting', 'ready', 'connected']) {
    const ui = await fixture(t, { manager: true, sessions: () => [runningFixture(state)], find: () => displayFixture });
    assert.equal(ui.element('profiles').querySelector('.profile-status').textContent, state === 'connected' ? 'Connected' : 'Connecting…');
    assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, true);
    assert.equal(ui.element('delete').disabled, true);
    contextMenu(ui, 'fixture');
    assert.equal(menuItem(ui, 'Edit').disabled, true);
    assert.equal(menuItem(ui, 'Delete').disabled, true);
    assert.equal(menuItem(ui, 'Disconnect').disabled, false);
    menuItem(ui, 'Resume in sidebar').click();
    await until(() => ui.calls.some(call => call.method === 'openView'));
    assert.equal(ui.calls.some(call => ['profiles.launch', 'create', 'profiles.password'].includes(call.method)), false);
    await until(() => !ui.element('profiles').querySelector('.profile-select').disabled);
    ui.element('profiles').querySelector('.profile-select').dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
    await until(() => ui.calls.filter(call => call.method === 'openView').length === 2);
    assert.equal(ui.calls.some(call => call.method === 'profiles.launch'), false);
  }
});

test('resuming a resource that ended before the click never creates a new login', async t => {
  let resources = [runningFixture()];
  const ui = await fixture(t, { manager: true, sessions: () => resources, find: () => null });
  resources = [];
  ui.element('profiles').querySelector('[data-action=resume]').click();
  await until(() => !ui.element('error').hidden);
  assert.match(ui.element('error').textContent, /previous connection ended/);
  assert.equal(ui.calls.some(call => ['profiles.launch', 'openView', 'create'].includes(call.method)), false);
  assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, false);
});

test('disconnecting from the list targets the displayed resource and unlocks editing/deletion only after completion', async t => {
  let resources = [runningFixture()];
  const stopped = deferred();
  const ui = await fixture(t, { manager: true, sessions: () => resources, disconnect: async () => { await stopped.promise; resources = []; } });
  contextMenu(ui, 'fixture'); menuItem(ui, 'Disconnect').click();
  await until(() => ui.calls.some(call => call.method === 'disconnect'));
  assert.equal(ui.element('delete').disabled, true);
  assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, true);
  stopped.resolve();
  await until(() => !ui.element('delete').disabled);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.method === 'disconnect').params)), { owner: 'fixture', id: 'resource' });
  assert.equal(ui.element('profiles').querySelector('.profile-status').textContent, '');
  assert.equal(ui.element('profiles').querySelector('.profile-status').hidden, true);
  assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, false);
});

test('a resource that starts while the editor is open freezes fields without discarding the draft; stopping restores them', async t => {
  let resources = [];
  const ui = await fixture(t, { manager: true, sessions: () => resources });
  ui.element('profiles').querySelector('[data-action=edit]').click();
  await until(() => !ui.element('profile-editor').hidden && !ui.element('name').disabled);
  ui.element('name').value = 'Keep this draft';
  resources = [runningFixture()];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('save').disabled);
  assert.equal(ui.element('name').disabled, true);
  assert.equal(ui.element('name').value, 'Keep this draft');
  assert.equal(ui.element('cancel-edit').disabled, false);
  assert.equal(ui.element('edit-locked').hidden, false);
  resources = [];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => !ui.element('save').disabled);
  assert.equal(ui.element('name').value, 'Keep this draft');
  assert.equal(ui.element('edit-locked').hidden, true);
});

test('a resource that starts after delete confirmation was opened disables the confirmation', async t => {
  let resources = [];
  const ui = await fixture(t, { manager: true, sessions: () => resources });
  ui.element('delete').click();
  await until(() => !ui.element('delete-confirm').hidden && !ui.element('confirm-delete').disabled);
  resources = [runningFixture('ready')];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => ui.element('confirm-delete').disabled);
  ui.element('confirm-delete').click();
  assert.equal(ui.calls.some(call => call.method === 'profiles.delete'), false);
  assert.equal(ui.element('cancel-delete').disabled, false);
});

test('a stale edit button rechecks the resource before opening an editor', async t => {
  let resources = [];
  const ui = await fixture(t, { manager: true, sessions: () => resources });
  resources = [runningFixture()];
  ui.element('profiles').querySelector('[data-action=edit]').click();
  await until(() => !ui.element('error').hidden);
  assert.match(ui.element('error').textContent, /Disconnect this server/);
  assert.equal(ui.element('profile-editor').hidden, true);
});

test('unknown session status locks modification and recovers without rebuilding focused rows', async t => {
  let failed = true;
  const ui = await fixture(t, { manager: true, sessions: () => { if (failed) throw new Error('offline'); return []; } });
  const choose = ui.element('profiles').querySelector('.profile-select'); choose.focus();
  assert.equal(ui.element('sessions-error').hidden, false);
  assert.equal(ui.element('delete').disabled, true);
  assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, true);
  failed = false;
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => !ui.element('delete').disabled);
  assert.equal(ui.element('sessions-error').hidden, true);
  assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, false);
  assert.equal(ui.window.document.activeElement, choose);
});

test('a background-enabled page delegates closing to the backend and can reopen without credentials', async t => {
  const ui = await fixture(t, { profile: { runInBackground: true }, find: () => displayFixture });
  await until(() => ui.element('status').textContent === 'Connected');
  await ui.lifecycle().dispose({ signal: new ui.window.AbortController().signal, reason: 'closed' });
  assert.equal(ui.calls.some(call => call.method === 'disconnect'), false);
  const reopened = await fixture(t, { find: () => displayFixture });
  await until(() => reopened.element('status').textContent === 'Connected');
  assert.equal(reopened.calls.some(call => ['create', 'profiles.password'].includes(call.method)), false);
});

test('externally deleted profiles leave running resources discoverable and recoverable', async t => {
  const ui = await fixture(t, { manager: true, empty: true, sessions: () => [runningFixture()], find: () => displayFixture });
  assert.equal(ui.element('profiles').children.length, 1);
  assert.equal(ui.element('profiles').querySelector('.profile-deleted').hidden, false);
  assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, true);
  contextMenu(ui, 'fixture');
  assert.equal(menuItem(ui, 'Edit'), undefined);
  menuItem(ui, 'Resume in sidebar').click();
  await until(() => ui.calls.some(call => call.method === 'openView'));
  const connection = await fixture(t, { empty: true, sessions: () => [runningFixture()], find: () => displayFixture });
  await until(() => connection.element('status').textContent === 'Connected');
  assert.equal(connection.element('title').textContent, 'Fixture');
  assert.equal(connection.calls.some(call => call.method === 'create'), false);
});

test('even a disconnected connection page prevents editing until it closes', async t => {
  let views = ['fixture'];
  const ui = await fixture(t, { manager: true, openProfiles: () => views });
  assert.equal(ui.element('profiles').querySelector('.profile-status').textContent, 'Disconnected');
  assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, true);
  contextMenu(ui, 'fixture'); assert.equal(menuItem(ui, 'Edit').disabled, true);
  views = [];
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => !ui.element('profiles').querySelector('[data-action=edit]').hidden);
  ui.element('profiles').querySelector('[data-action=edit]').click();
  await until(() => !ui.element('profile-editor').hidden);
  assert.equal(ui.calls.filter(call => call.method === 'profiles.beginEdit').length, 1);
  await until(() => !ui.element('cancel-edit').disabled);
  ui.element('cancel-edit').click();
  await until(() => !ui.element('manager').hidden);
  assert.equal(ui.calls.filter(call => call.method === 'profiles.endEdit').length, 1);
});

test('editor disposal leaves lock cleanup to the host’s completed close, so failed closes cannot unlock it', async t => {
  const ui = await fixture(t, { manager: true });
  ui.element('profiles').querySelector('[data-action=edit]').click();
  await until(() => !ui.element('profile-editor').hidden && !ui.element('save').disabled);
  const restore = await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal });
  await ui.lifecycle().dispose({ signal: new ui.window.AbortController().signal, reason: 'moved' });
  assert.equal(ui.calls.some(call => call.method === 'profiles.endEdit'), false);
  const moved = await fixture(t, { manager: true, restore });
  assert.equal(moved.calls.some(call => call.method === 'profiles.beginEdit'), true);
  await moved.lifecycle().dispose({ signal: new moved.window.AbortController().signal, reason: 'closed' });
  assert.equal(moved.calls.some(call => call.method === 'profiles.endEdit'), false);
});

test('right-click position overrides the default and reuses an active desktop without launching a new login', async t => {
  const ui = await fixture(t, { manager: true, profile: { openMode: 'sidebar' } });
  contextMenu(ui, 'fixture');
  assert.ok(menuItem(ui, 'Start in sidebar'));
  menuItem(ui, 'Start in window').click();
  await until(() => ui.calls.some(call => call.method === 'connection.setLocation'));
  assert.equal(ui.calls.find(call => call.method === 'openView').params.location, 'window');
  const active = await fixture(t, { manager: true, sessions: () => [runningFixture()], find: () => displayFixture });
  contextMenu(active, 'fixture'); menuItem(active, 'Resume in window').click();
  await until(() => active.calls.some(call => call.method === 'connection.setLocation'));
  assert.deepEqual(JSON.parse(JSON.stringify(active.calls.find(call => call.method === 'moveView').params)), { location: 'window', instanceId: 'fixture' });
  assert.equal(active.calls.some(call => ['profiles.launch', 'create', 'profiles.password'].includes(call.method)), false);
});

test('only committed movement remembers placement; persistence failure is visible without disconnecting', async t => {
  const { store, profile } = await profileStore(t);
  let failed = false;
  const ui = await fixture(t, { store, profile, position: async () => { if (failed) throw new Error('RDP_LOCATION_SAVE_FAILED'); } });
  await until(() => ui.calls.some(call => call.method === 'connection.setLocation'));
  ui.context.phase = 'preparing'; ui.move('window');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await store.call('profiles.get', { id: profile.id })).openMode, 'sidebar');
  ui.context.phase = 'active'; ui.move('window');
  await until(() => ui.calls.filter(call => call.method === 'connection.setLocation').length >= 2);
  await until(async () => (await store.call('profiles.get', { id: profile.id })).openMode === 'window');
  assert.equal((await store.call('profiles.get', { id: profile.id })).openMode, 'window');
  failed = true; ui.move('sidebar');
  await until(() => !ui.element('error').hidden);
  assert.match(ui.element('error').textContent, /opening preference could not be saved/);
  assert.equal((await store.call('profiles.get', { id: profile.id })).openMode, 'window');
  assert.equal(ui.calls.some(call => call.method === 'disconnect'), false);
});


test('background setting starts unchecked, saves both choices and is passed to a new connection', async t => {
  const { store, profile } = await profileStore(t);
  const ui = await fixture(t, { manager: true, store, profile });
  ui.element('new').click();
  assert.equal(ui.element('run-in-background').checked, false);
  ui.element('cancel-edit').click();
  await until(() => !ui.element('manager').hidden);
  for (const enabled of [true, false]) {
    ui.element('profiles').querySelector('[data-action=edit]').click();
    await until(() => !ui.element('profile-editor').hidden && !ui.element('save').disabled);
    ui.element('run-in-background').checked = enabled;
    ui.submit();
    await until(() => !ui.element('manager').hidden && !ui.element('new').disabled);
    assert.equal((await store.call('profiles.get', profile)).runInBackground, enabled);
    const connection = await fixture(t, { store, profile });
    connection.submit(); await until(() => connection.element('status').textContent === 'Connected');
    assert.equal(connection.calls.find(call => call.method === 'create').params.runInBackground, enabled);
  }
});

test('closing while a profile read is pending prevents late connection creation', async t => {
  const blocked = deferred(); let hold = false;
  const ui = await fixture(t, { profileRead: () => hold ? blocked.promise : undefined });
  hold = true; ui.submit();
  await until(() => ui.element('connect').disabled);
  const closing = ui.lifecycle().dispose({ signal: new ui.window.AbortController().signal, reason: 'closed' });
  await until(() => ui.calls.some(call => call.method === 'connection.close'));
  blocked.resolve(); await closing;
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
  assert.equal(ui.hasViewListener(), false);
});

test('moves and cancelled closes do not end resources; a failed close keeps the page recoverable', async t => {
  let fail = true;
  const ui = await fixture(t, { find: () => displayFixture, close: () => { if (fail) throw new Error('stop failed'); } });
  await until(() => ui.element('status').textContent === 'Connected');
  const cancelled = new ui.window.AbortController(); cancelled.abort();
  await assert.rejects(ui.lifecycle().dispose({ signal: cancelled.signal, reason: 'closed' }));
  assert.equal(ui.calls.some(call => call.method === 'connection.close'), false);
  const signal = new ui.window.AbortController().signal;
  await ui.lifecycle().resume({ signal });
  await assert.rejects(ui.lifecycle().dispose({ signal, reason: 'closed' }), /stop failed/);
  await ui.lifecycle().resume({ signal });
  assert.equal(ui.hasViewListener(), true);
  assert.ok(ui.window.document.querySelector('canvas'));
  fail = false;
  await ui.lifecycle().dispose({ signal, reason: 'moved' });
  assert.equal(ui.calls.filter(call => call.method === 'connection.close').length, 1);
});

for (const runInBackground of [false, true]) test('closing during helper creation respects background=' + runInBackground, async t => {
  const pending = deferred();
  const ui = await fixture(t, { profile: { runInBackground }, create: () => pending.promise });
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'create'));
  const closed = ui.lifecycle().dispose({ signal: new ui.window.AbortController().signal, reason: 'closed' });
  await until(() => ui.calls.some(call => call.method === 'connection.close'));
  pending.resolve(); await closed;
  assert.equal(ui.calls.some(call => call.method === 'disconnect'), !runInBackground);
  assert.equal(ui.calls.some(call => call.method === 'claim'), false);
  assert.equal(ui.hasViewListener(), false);
});


test('moving during a pending position save lets the started connection finish before handoff', async t => {
  const saving = deferred();
  const ui = await fixture(t, { position: () => saving.promise });
  await until(() => ui.calls.some(call => call.method === 'connection.setLocation'));
  ui.submit();
  const controller = new ui.window.AbortController();
  t.after(() => controller.abort());
  const prepared = ui.lifecycle().prepare({ signal: controller.signal, context: ui.context });
  prepared.catch(() => {});
  saving.resolve();
  await until(() => ui.calls.some(call => call.method === 'create'));
  const snapshot = await prepared;
  assert.ok(snapshot.session);
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
  await ui.lifecycle().resume({ signal: controller.signal });
  assert.equal(ui.element('status').textContent, 'Connected');
});


test('connection actions have matching accessible labels in the sidebar and host toolbar', async t => {
  const pending = deferred();
  const ui = await fixture(t, { create: () => pending.promise });
  const button = ui.element('manage-profiles');
  assert.equal(button.getAttribute('aria-label'), 'Server list');
  assert.equal(ui.toolbar().actions.find(action => action.id === 'profiles').icon, 'list');
  assert.equal(button.querySelector('[data-icon="list"]').hasAttribute('hidden'), false);
  button.click();
  await until(() => ui.calls.some(call => call.method === 'profiles.select'));
  assert.equal(ui.calls.find(call => call.method === 'profiles.select').params.id, 'fixture');
  const stop = ui.element('disconnect');
  assert.equal(stop.textContent, '');
  assert.equal(stop.title, 'Disconnect');
  assert.equal(stop.disabled, true);
  ui.submit();
  await until(() => stop.title === 'Cancel');
  assert.equal(stop.querySelector('[data-icon="x"]').hasAttribute('hidden'), false);
  assert.equal(stop.querySelector('[data-icon="unplug"]').hasAttribute('hidden'), true);
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').icon, 'x');
  pending.resolve();
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(stop.title, 'Disconnect');
  assert.equal(stop.querySelector('[data-icon="unplug"]').hasAttribute('hidden'), false);
});

test('opening the list selects and scrolls to the requested server without saving or connecting', async t => {
  const second = { id: 'second', revision: 1, name: 'Second', host: 'second.invalid', port: 3389, username: 'fixture', domain: '', openMode: 'sidebar', runInBackground: false, hasPassword: false };
  const navigation = { request: { id: second.id, token: 'request' } };
  const ui = await fixture(t, { manager: true, navigation, extraProfiles: [second] });
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => !navigation.request);
  assert.equal(ui.element('profiles').querySelector('[aria-pressed="true"]').closest('li').dataset.id, second.id);
  assert.equal(ui.window.document.activeElement.closest('li').dataset.id, second.id);
  assert.ok(ui.calls.some(call => call.method === 'scrollIntoView' && call.params.id === second.id && call.params.block === 'nearest'));
  assert.equal(ui.calls.some(call => ['profiles.save', 'profiles.launch', 'create'].includes(call.method)), false);
  ui.element('profiles').querySelector('.profile-select').click();
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ui.element('profiles').querySelector('[aria-pressed="true"]').closest('li').dataset.id, 'fixture');
});

test('a navigation request waits for editing to finish instead of overwriting an unsaved draft', async t => {
  const second = { id: 'second', revision: 1, name: 'Second', host: 'second.invalid', port: 3389, username: 'fixture', domain: '', openMode: 'sidebar', runInBackground: false, hasPassword: false };
  const navigation = {};
  const ui = await fixture(t, { manager: true, navigation, extraProfiles: [second] });
  ui.element('profiles').querySelector('[data-action="edit"]').click();
  await until(() => !ui.element('profile-editor').hidden && !ui.element('name').disabled);
  ui.element('name').value = 'My unsaved draft';
  navigation.request = { id: second.id, token: 'request' };
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ui.element('name').value, 'My unsaved draft');
  assert.equal(ui.element('profile-editor').hidden, false);
  assert.ok(navigation.request);
  ui.element('cancel-edit').click();
  await until(() => ui.element('profile-editor').hidden);
  ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => !navigation.request);
  assert.equal(ui.element('profiles').querySelector('[aria-pressed="true"]').closest('li').dataset.id, second.id);
});
