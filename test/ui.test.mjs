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
      constructor(container, connection, onState, onSize, onClipboard, disableMouseAnimation, onResizeError, onResizeCapability) { window.__resizeCapability = onResizeCapability; window.__disableMouseAnimation = disableMouseAnimation; window.__remoteClipboard = onClipboard; this.onClipboard = onClipboard; window.__remoteSize = (width, height) => { this.size = { width, height }; this.canvas.width = width; this.canvas.height = height; onSize(); }; window.__remoteState = state => { if (state !== 'connected') this.available = false; onState(state, false); }; this.onState = onState; this.lockRevision = 0; this.locked = false; window.__remoteLock = (locked, revision = ++window.__lockRevision) => this.updateInputLock(locked, revision); this.canvas = document.createElement('canvas'); container.append(this.canvas);
        this.ready = Promise.resolve().then(() => window.__attachDisplay()).then(() => { this.available = true; onResizeCapability(window.__resizeSupported); this.onClipboard(false, window.__clipboardState); this.updateInputLock(window.__initialLock, window.__lockRevision); if (!window.__delayFirstFrame) window.__remoteSize(1024, 768); }); }
      updateClipboard(enabled) { this.onClipboard(enabled); }
      updateInputLock(locked, revision) { if (revision >= this.lockRevision) { this.lockRevision = revision; this.locked = locked; } this.onState('connected', this.locked); }
      get resizeEpoch() { return this.available ? 1 : undefined; }
      release() {}
      setInputBlocked(value) { window.__inputBlocked = value; }
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
  return { store, profile, directory };
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
  const dom = new JSDOM(html, { url: 'https://rdp.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.TextEncoder = TextEncoder;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.document.documentElement.getBoundingClientRect = () => ({ width: window.innerWidth, height: window.innerHeight });
  const resizeListeners = new Set();
  window.__resizeDesktop = (notifyHost = true) => {
    if (notifyHost) {
      const bounds = element('desktop').getBoundingClientRect();
      window.innerWidth = bounds.width + 24; window.innerHeight = bounds.height + 24;
      context.viewport = info.view.viewport = { width: window.innerWidth, height: window.innerHeight };
      context.windowResizeRevision = info.view.windowResizeRevision = (context.windowResizeRevision ?? 0) + 1;
      viewListener?.(info.view);
    }
    for (const listener of resizeListeners) listener([]);
  };
  window.ResizeObserver = class { constructor(callback) { this.callback = callback; } observe() { resizeListeners.add(this.callback); } disconnect() { resizeListeners.delete(this.callback); } };
  const optionsClose = options.closeView;
  const calls = [];
  window.HTMLElement.prototype.scrollIntoView = function(options) { calls.push({ method: 'scrollIntoView', params: { id: this.dataset.id, ...options } }); };
  const errors = [];
  const element = id => window.document.getElementById(id);
  element('desktop').getBoundingClientRect = () => ({ width: 1000, height: 744 });
  const button = element('accept-certificate');
  const addListener = button.addEventListener.bind(button);
  button.addEventListener = (type, listener, settings) => addListener(type, event => {
    Promise.resolve(listener(event)).catch(error => errors.push(error));
  }, settings);
  let nextId = 0;
  let attempts = 0;
  let profile = { id: 'fixture', revision: 1, name: 'Fixture', host: 'test.invalid', port: 3389, username: 'fixture', domain: '', openMode: 'sidebar', hasPassword: false, ...options.profile };
  let profiles = options.empty ? [] : [profile, ...(options.extraProfiles ?? [])];
  const info = { language: 'en', theme: 'dark', fontSize: 14, view: { instanceId: options.manager ? 'main' : profile.id, location: options.location ?? 'sidebar', windowMode: options.location === 'window' ? 'normal' : undefined, windowPlacement: options.placement, viewport: { width: window.innerWidth, height: window.innerHeight } } };
  let viewListener;
  let toolbarListener;
  let toolbar;
  let lifecycle;
  const context = { panelId: "panel", pageId: "page", location: info.view.location, windowMode: info.view.windowMode, windowPlacement: info.view.windowPlacement, viewport: info.view.viewport, phase: "preparing", restoreState: options.restore ?? null, view: { content: { instanceId: info.view.instanceId } } };
  window.anas = {
    getContext: async () => context,
    registerLifecycle: handlers => { lifecycle = handlers; },
    ready: async () => { await lifecycle.activate({ signal: new window.AbortController().signal, context }); context.phase = 'active'; viewListener?.(info.view); },
    failed: async () => { calls.push({ method: 'failed' }); },
    onViewChanged: listener => { viewListener = listener; return () => { viewListener = undefined; }; },
    setToolbar: async value => { await options.toolbar?.(value); toolbar = value; },
    resizeWindow: async params => { calls.push({ method: 'resizeWindow', params, phase: context.phase }); await (context.phase === 'preparing' ? options.prepareResize : options.resize)?.(params, context); },
    onToolbarAction: listener => { toolbarListener = listener; return () => { toolbarListener = undefined; }; },
    getInfo: async () => info,
    getLanguageResources: async () => ({ resources: { ...languageResources, ...options.languages }, errors: [] }),
    openView: async params => { calls.push({method:'openView',params}); if (options.openError) throw new Error('Open failed'); },
    moveView: async target => { const location = typeof target === 'string' ? target : target.location; const id = typeof target === 'string' ? info.view.instanceId : target.instanceId; calls.push({ method: 'moveView', params: { location, instanceId: id } }); await options.move?.(); },
    closeView: async options => { calls.push({ method: 'closeView', params: options }); await optionsClose?.(); },
    data: { get: options.get ?? (async () => null), set: options.set ?? (async () => {}) },
    backend: { call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'profiles.beginEdit' || method === 'profiles.endEdit') return null;
      if (options.store && (method.startsWith('profiles.') || method.startsWith('trusts.'))) return options.store.call(method, params);
      if (method === 'runtime.state') return { sessions: options.sessions?.() ?? [], openProfiles: options.openProfiles?.() ?? [], editingProfiles: options.editingProfiles?.() ?? [] };
      if (method === 'windowState.get') return options.windowState?.get() ?? null;
      if (method === 'windowState.set') { await options.windowState?.set(params); return null; }
      if (method === 'resize') { await options.remoteResize?.(params); return { accepted: true }; }
      if (method === 'find') return options.find?.(params) ?? null;
      if (method === 'connection.close') return options.close?.(params) ?? null;
      if (method === 'disconnect') return options.disconnect?.(params) ?? null;
      if (method === 'server.close') { options.launch?.(profile); if (options.store) options.store.cancelLaunch(params.profile_id); await options.disconnect?.(params); await window.anas.closeView({ instanceId: params.profile_id }); return null; }
      if (method === 'server.open') { await options.serverOpen?.(params); const found = (options.sessions?.() ?? []).find(s => s.profile.id === params.profile_id); const saved = options.store ? await options.store.call('profiles.get', {id:params.profile_id}) : profiles.find(p => p.id === params.profile_id) ?? found?.profile; if (!saved) throw new Error('PROFILE_MISSING'); if (!found) { calls.push({method:'profiles.launch',params: {id:saved.id, revision:saved.revision}}); if (options.store) await options.store.call('profiles.launch', saved); } if (params.location) await window.anas.moveView({ instanceId: params.profile_id, location: params.location }); await window.anas.openView({ instanceId: params.profile_id, location: params.location ?? saved.openMode, title: saved.name, icon:'assets/desktop.svg' }); return null; }
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
      if (method === 'create') { await options.create?.(); return { reused: options.createReused ?? false, id: String(++nextId), token: 'synthetic', url: 'ws://127.0.0.1:9/display' }; }
      if (method === 'resetInput') { await options.resetInput?.(params); return { session_id: params.id, accepted: true, toggle_flags: 0 }; }
      if (method === 'inputText') { await options.inputText?.(params); return { accepted: true }; }
      if (method === 'setUiLocked') { await options.lock?.(params); const uiRevision = ++window.__lockRevision; if (!options.delayLockSnapshot) window.__remoteLock(params.locked, uiRevision); return { session_id: params.id, ui_locked: params.locked, uiRevision }; }
      if (method === 'setClipboardEnabled') { if (options.clipboardError) throw new Error(options.clipboardError); window.__remoteClipboard(params.enabled); return { enabled: params.enabled }; }
      if (method === 'setAdaptive') { await options.adaptiveSave?.(params); const changes = options.store ? await options.store.call('preferences.adaptive', {id: profile.id, location: params.location, enabled: params.enabled}) : { ...profile, [params.location === 'window' ? 'adaptiveWindow' : 'adaptiveSidebar']: params.enabled }; profile = {...profile, ...changes}; return {adaptiveWindow: profile.adaptiveWindow ?? false, adaptiveSidebar: profile.adaptiveSidebar ?? false}; }
      if (method === 'status') return options.status?.(params) ?? { state: 'connected', certificate: null, adaptiveWindow: (options.restore?.view?.profile ?? profile).adaptiveWindow ?? false, adaptiveSidebar: (options.restore?.view?.profile ?? profile).adaptiveSidebar ?? false };
      return null;
    } },
  };
  window.__lockRevision = 0;
  window.__clipboardState = options.clipboardState ?? 'disabled';
  window.__initialLock = options.initialLock ?? false;
  window.__resizeSupported = options.resizeSupported ?? true;
  window.__delayFirstFrame = options.delayFirstFrame ?? false;
  window.__attachDisplay = async () => {
    attempts++;
    if (options.connect) return options.connect(attempts);
  };
  await window.eval(`(async () => { ${compiled.outputFiles[0].text} })()`);
  element('host').value = 'test.invalid';
  element('username').value = 'fixture';
  return { window, info, element, calls, errors, lifecycle: () => lifecycle, context, toolbar: () => toolbar, action: id => toolbarListener?.(id), hasToolbarListener: () => !!toolbarListener, place: placement => { context.windowPlacement = info.view.windowPlacement = placement; viewListener?.(info.view); }, move: location => { info.view.location = location; context.location = location; context.windowMode = info.view.windowMode = location === 'window' ? 'normal' : undefined; viewListener?.(info.view); }, mode: mode => { context.windowResizeRevision = info.view.windowResizeRevision = (context.windowResizeRevision ?? 0) + 1; context.windowMode = info.view.windowMode = mode; viewListener?.(info.view); }, visibility: visible => { context.view.activity = { visible, active: visible }; viewListener?.({ ...info.view, activity: context.view.activity }); }, hasViewListener: () => !!viewListener, submit: () => element(options.manager ? 'profile-editor' : 'connection').dispatchEvent(new window.Event('submit', { cancelable: true })) };
}

test('the resolution selector saves presets and preserves custom drafts across page handoff', async t => {
  const ui = await fixture(t, { manager: true });
  ui.element('profiles').querySelector('[data-action=edit]').click();
  await until(() => !ui.element('profile-editor').hidden);
  assert.equal(ui.element('resolution').value, '1280x800');
  assert.equal(ui.element('custom-resolution').hidden, true);
  ui.element('resolution').value = '1024x768';
  ui.element('resolution').dispatchEvent(new ui.window.Event('change'));
  ui.submit();
  await until(() => !ui.element('manager').hidden);
  const saved = ui.calls.find(call => call.method === 'profiles.save').params;
  assert.equal(saved.desktopWidth, 1024); assert.equal(saved.desktopHeight, 768);
  ui.element('profiles').querySelector('[data-action=edit]').click();
  await until(() => !ui.element('profile-editor').hidden);
  assert.equal(ui.element('resolution').value, '1024x768');
  ui.element('resolution').value = 'custom';
  ui.element('resolution').dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.element('custom-resolution').hidden, false);
  ui.element('desktop-width').value = '1440'; ui.element('desktop-height').value = '960';
  const restore = await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal, context: ui.context });
  const moved = await fixture(t, { manager: true, restore });
  assert.equal(moved.element('resolution').value, 'custom');
  assert.equal(moved.element('custom-resolution').hidden, false);
  assert.equal(moved.element('desktop-width').value, '1440');
  assert.equal(moved.element('desktop-height').value, '960');
  moved.submit();
  await until(() => !moved.element('manager').hidden);
  assert.equal(moved.calls.find(call => call.method === 'profiles.save').params.desktopWidth, 1440);
  assert.equal(moved.calls.find(call => call.method === 'profiles.save').params.desktopHeight, 960);
});

test('invalid custom resolution keeps the draft and shows a translated error without saving', async t => {
  const ui = await fixture(t, { manager: true, profile: { desktopWidth: 1440, desktopHeight: 960 } });
  ui.element('profiles').querySelector('[data-action=edit]').click();
  await until(() => !ui.element('profile-editor').hidden);
  assert.equal(ui.element('resolution').value, 'custom');
  ui.element('desktop-width').value = '8192'; ui.element('desktop-height').value = '8192';
  ui.submit();
  await until(() => !ui.element('error').hidden);
  assert.match(ui.element('error').textContent, /16,777,216/);
  assert.equal(ui.calls.some(call => call.method === 'profiles.save'), false);
  assert.equal(ui.element('desktop-width').value, '8192');
  ui.element('desktop-height').value = '2048';
  ui.submit();
  await until(() => !ui.element('manager').hidden);
});

test('new connections receive the saved fixed resolution', async t => {
  const ui = await fixture(t, { profile: { desktopWidth: 1024, desktopHeight: 768 } });
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  const config = ui.calls.find(call => call.method === 'create').params;
  assert.equal(config.desktopWidth, 1024); assert.equal(config.desktopHeight, 768);
});

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
  assert.deepEqual(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).map(call => call.params.profile_id ?? call.params.owner), ['fixture']);
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

test('failed server opening is reported and remains retryable', async t => {
  const ui = await fixture(t, { manager: true, serverOpen: () => { throw new Error('Open failed'); } });
  ui.element('profiles').querySelector('[data-action=start]').click();
  await until(() => !ui.element('error').hidden);
  assert.equal(ui.calls.filter(call => call.method === 'server.open').length, 1);
  assert.equal(ui.element('profiles').querySelector('[data-action=start]').disabled, false);
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
  assert.equal(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).length, 1);
  assert.equal(ui.calls.some(call => call.method === 'closeView'), true);
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
  assert.equal(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).length, 0);
  assert.equal(ui.hasViewListener(), true);
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).length, 0);
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
  assert.equal(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).length, 0);
  await ui.action('disconnect');
  await until(() => ui.toolbar().status.label === 'Disconnected');
  assert.equal(ui.calls.some(call => call.method === 'closeView'), true);
  assert.equal(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).length, 1);
  assert.equal(ui.element('desktop').firstElementChild, null);
});

test('titlebar cancel prevents a delayed handshake from restoring a canceled session', async t => {
  const handshake = deferred();
  const ui = await fixture(t, { location: 'window', connect: () => handshake.promise });
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'create'));
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').label, 'Cancel');
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').icon, 'assets/x.svg');
  await ui.action('disconnect');
  handshake.resolve({ run: () => new Promise(() => {}) });
  await until(() => ui.toolbar().status.label === 'Disconnected');
  assert.equal(ui.element('connect').disabled, false);
  assert.equal(ui.calls.some(call => call.method === 'closeView'), true);
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
  ui.element('clipboard-support').checked = true;
  ui.element('password').value = 'in-memory-only';
  const controller = new ui.window.AbortController();
  const state = await ui.lifecycle().prepare({ signal: controller.signal, context: ui.context });
  assert.equal(state.view.fields.name.value, 'unsaved latest');
  assert.equal(state.view.fields['clipboard-support'].checked, true);
  assert.equal(state.view.fields.password.value, 'in-memory-only');
  await ui.lifecycle().resume({ signal: controller.signal, context: ui.context });
  await ui.lifecycle().dispose({ signal: controller.signal, reason: 'moved', context: ui.context });
  assert.equal(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).length, 0);
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
  assert.equal(ui.calls.filter(c => ['disconnect', 'server.close'].includes(c.method)).length, 0);
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
  assert.equal(ui.calls.filter(c => ['disconnect', 'server.close'].includes(c.method)).length, 0);
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
  assert.equal(target.calls.filter(c => ['disconnect', 'server.close'].includes(c.method)).length, 1);
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
  assert.equal(ui.calls.filter(c => ['disconnect', 'server.close'].includes(c.method)).length, 0);
  ui.submit(); await until(() => attempts === 3 && ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.filter(c => c.method === 'create').length, 1);
  assert.equal(ui.calls.filter(c => ['disconnect', 'server.close'].includes(c.method)).length, 0);
});


for (const ended of ['closed', 'connection_failed', 'missing']) {
  test(`a remotely ended session (${ended}) retains its frame, close actions and reconnect controls`, async t => {
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
    await new Promise(setImmediate);
    await until(() => ui.element('status').textContent === 'Disconnected');
    assert.equal(ui.element('disconnect').disabled, false);
    assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').disabled, false);
    assert.equal(ui.element('desktop').querySelector('canvas'), canvas);
    assert.equal(ui.element('connect').disabled, false);
    assert.equal(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).length, 0);
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
  await new Promise(setImmediate);
  await until(() => ui.element('status').textContent === 'Disconnected');
  assert.equal(ui.element('disconnect').disabled, false);
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').disabled, false);
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
  await until(() => ui.calls.some(call => call.method === 'closeView'));
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
  assert.equal(ui.calls.filter(call => ['disconnect', 'server.close'].includes(call.method)).length, 0);
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
  assert.equal(ui.calls.some(call => ['disconnect', 'server.close'].includes(call.method)), false);
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
  await until(() => ui.calls.some(call => call.method === 'closeView'));
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
  await until(() => ui.calls.some(call => ['disconnect', 'server.close'].includes(call.method)));
  assert.equal(ui.element('delete').disabled, true);
  assert.equal(ui.element('profiles').querySelector('[data-action=edit]').hidden, true);
  stopped.resolve();
  await until(() => !ui.element('delete').disabled);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => ['disconnect', 'server.close'].includes(call.method)).params)), { profile_id: 'fixture' });
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
  const ui = await fixture(t, { find: () => displayFixture });
  await until(() => ui.element('status').textContent === 'Connected');
  await ui.lifecycle().dispose({ signal: new ui.window.AbortController().signal, reason: 'closed' });
  assert.equal(ui.calls.some(call => ['disconnect', 'server.close'].includes(call.method)), false);
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

test('right-click position overrides the default without changing the saved profile or restarting a live connection', async t => {
  const { store, profile, directory } = await profileStore(t);
  const before = await readFile(join(directory, 'profiles.json'), 'utf8');
  const ui = await fixture(t, { manager: true, store, profile });
  contextMenu(ui, profile.id);
  assert.ok(menuItem(ui, 'Start in sidebar'));
  menuItem(ui, 'Start in window').click();
  await until(() => ui.element('status').textContent === 'Connection page opened');
  assert.equal(ui.calls.find(call => call.method === 'openView').params.location, 'window');
  const active = await fixture(t, { manager: true, store, profile, sessions: () => [{ ...runningFixture(), profile }], find: () => displayFixture });
  contextMenu(active, profile.id); menuItem(active, 'Resume in window').click();
  await until(() => active.element('status').textContent === 'Connection page opened');
  assert.deepEqual(JSON.parse(JSON.stringify(active.calls.find(call => call.method === 'moveView').params)), { location: 'window', instanceId: profile.id });
  assert.equal(active.calls.some(call => ['profiles.launch', 'create', 'profiles.password'].includes(call.method)), false);
  assert.equal(await readFile(join(directory, 'profiles.json'), 'utf8'), before);
});

for (const connected of [false, true]) test(`opening, focusing and moving a ${connected ? 'connected' : 'disconnected'} desktop preserves the saved opening preference`, async t => {
  const { store, profile, directory } = await profileStore(t);
  const before = await readFile(join(directory, 'profiles.json'), 'utf8');
  const ui = await fixture(t, { store, profile, location: 'window', find: connected ? () => displayFixture : undefined });
  for (const location of ['sidebar', 'window']) {
    ui.move(location);
    ui.window.dispatchEvent(new ui.window.Event('focus'));
    await until(() => ui.element('connection-header').hidden === (location === 'window'));
  }
  const signal = new ui.window.AbortController().signal;
  const restore = await ui.lifecycle().prepare({ signal });
  await ui.lifecycle().dispose({ signal, reason: 'moved' });
  const moved = await fixture(t, { store, profile, restore, location: 'sidebar' });
  assert.equal(moved.element('error').hidden, true);
  await moved.lifecycle().prepare({ signal: new moved.window.AbortController().signal });
  assert.equal(await readFile(join(directory, 'profiles.json'), 'utf8'), before);
  assert.equal(ui.calls.some(call => ['disconnect', 'server.close'].includes(call.method)), false);
  await moved.lifecycle().dispose({ signal: new moved.window.AbortController().signal, reason: 'moved' });
});




test('disable mouse animation starts unchecked and persists through editing, connection and page handoff', async t => {
  const { store, profile } = await profileStore(t);
  const ui = await fixture(t, { manager: true, store, profile });
  ui.element('new').click();
  assert.equal(ui.element('disable-mouse-animation').checked, false);
  assert.equal(ui.window.document.querySelector('[data-label="disable-mouse-animation"]').textContent, 'Disable mouse animation');
  ui.element('cancel-edit').click();
  await until(() => !ui.element('manager').hidden);
  for (const disabled of [true, false]) {
    ui.element('profiles').querySelector('[data-action=edit]').click();
    await until(() => !ui.element('profile-editor').hidden && !ui.element('save').disabled);
    ui.element('disable-mouse-animation').checked = disabled;
    ui.submit();
    await until(() => !ui.element('manager').hidden && !ui.element('new').disabled);
    assert.equal((await store.call('profiles.get', profile)).disableMouseAnimation, disabled);
    const connection = await fixture(t, { store, profile });
    connection.submit(); await until(() => connection.element('status').textContent === 'Connected');
    assert.equal(connection.calls.find(call => call.method === 'create').params.disableMouseAnimation, disabled);
    assert.equal(connection.window.__disableMouseAnimation, disabled);
    const restore = await connection.lifecycle().prepare({ signal: new connection.window.AbortController().signal });
    const moved = await fixture(t, { restore, location: 'window', profile, store });
    await until(() => moved.element('status').textContent === 'Connected');
    assert.equal(moved.window.__disableMouseAnimation, disabled);
    await connection.lifecycle().dispose({ signal: new connection.window.AbortController().signal, context: connection.context, reason: 'moved' });
    await moved.lifecycle().dispose({ signal: new moved.window.AbortController().signal, context: moved.context, reason: 'moved' });
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

test('closing during helper creation preserves its background connection', async t => {
  const pending = deferred();
  const ui = await fixture(t, { create: () => pending.promise });
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'create'));
  const closed = ui.lifecycle().dispose({ signal: new ui.window.AbortController().signal, reason: 'closed' });
  await until(() => ui.calls.some(call => call.method === 'connection.close'));
  pending.resolve(); await closed;
  assert.equal(ui.calls.some(call => ['disconnect', 'server.close'].includes(call.method)), false);
  assert.equal(ui.calls.some(call => call.method === 'claim'), false);
  assert.equal(ui.hasViewListener(), false);
});


test('moving during a pending connection lets it finish before handoff', async t => {
  const pending = deferred();
  const ui = await fixture(t, { create: () => pending.promise });
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'create'));
  const controller = new ui.window.AbortController();
  t.after(() => controller.abort());
  const prepared = ui.lifecycle().prepare({ signal: controller.signal, context: ui.context });
  prepared.catch(() => {});
  pending.resolve();
  const snapshot = await prepared;
  assert.ok(snapshot.session);
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 1);
  await ui.lifecycle().resume({ signal: controller.signal });
  assert.equal(ui.element('status').textContent, 'Connected');
});


test('connection actions have matching accessible labels in the sidebar and host toolbar', async t => {
  const pending = deferred();
  const ui = await fixture(t, { create: () => pending.promise });
  const stop = ui.element('disconnect');
  assert.equal(stop.textContent, '');
  assert.equal(stop.title, 'Disconnect');
  assert.equal(stop.disabled, false);
  ui.submit();
  await until(() => stop.title === 'Cancel');
  assert.match(stop.querySelector('.action-icon').getAttribute('src'), /assets\/x\.svg/);
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').icon, 'assets/x.svg');
  pending.resolve();
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(stop.title, 'Disconnect');
  assert.match(stop.querySelector('.action-icon').getAttribute('src'), /assets\/unplug\.svg/);
});

test('local input lock uses the same state and action in sidebar and window, follows tools, and remains manually reversible', async t => {
  const ui = await fixture(t);
  await until(() => !ui.element('connect').disabled);
  ui.submit();
  await until(() => !ui.element('ui-lock').disabled);
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'false');
  ui.element('ui-lock').click();
  await until(() => ui.toolbar()?.actions.find(a => a.id === 'ui-lock').pressed === true);
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.element('disconnect').disabled, false);
  assert.equal(ui.calls.filter(c => c.method === 'setUiLocked').at(-1).params.locked, true);
  ui.move('window');
  await until(() => ui.element('connection-header').hidden);
  assert.equal(ui.toolbar().actions.find(a => a.id === 'ui-lock').icon, 'assets/lock.svg');
  await ui.action('ui-lock');
  await until(() => ui.toolbar().actions.find(a => a.id === 'ui-lock').pressed === false);
  ui.window.__remoteLock(true);
  await until(() => ui.toolbar().actions.find(a => a.id === 'ui-lock').pressed === true);
  ui.move('sidebar');
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'true');
  await ui.action('disconnect');
  await until(() => ui.element('ui-lock').disabled);
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'false');
});

test('a failed lock request preserves the current state and permits retry', async t => {
  let fail = true;
  const ui = await fixture(t, { lock: async () => { if (fail) throw new Error('RDP_CONTROL_TIMEOUT'); } });
  await until(() => !ui.element('connect').disabled); ui.submit();
  await until(() => !ui.element('ui-lock').disabled);
  await ui.action('ui-lock');
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.element('ui-lock').disabled, false);
  assert.match(ui.element('error-message').textContent, /local input lock/);
  fail = false;
  await ui.action('ui-lock');
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'true');
});

test('completed lock changes can be immediately reversed while display snapshots are delayed', async t => {
  const ui = await fixture(t, { delayLockSnapshot: true });
  await until(() => !ui.element('connect').disabled); ui.submit();
  await until(() => !ui.element('ui-lock').disabled);
  await ui.action('ui-lock');
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'true');
  await ui.action('ui-lock');
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'false');
  ui.window.__remoteLock(true, 1);
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(ui.calls.filter(call => call.method === 'setUiLocked').map(call => call.params.locked), [true, false]);
});

test('reset input is explicit, shared by sidebar/window, and available while UI input is locked', async t => {
  const ui = await fixture(t, { initialLock: true });
  await until(() => !ui.element('connect').disabled); ui.submit();
  await until(() => !ui.element('reset-input').disabled);
  assert.equal(ui.calls.filter(c => c.method === 'resetInput').length, 0);
  assert.equal(ui.element('reset-input').getAttribute('aria-label'), 'Reset input');
  ui.element('reset-input').click();
  await until(() => ui.calls.some(c => c.method === 'resetInput') && !ui.element('reset-input').disabled);
  assert.equal(ui.element('ui-lock').getAttribute('aria-pressed'), 'true');
  const original = ui.calls.find(c => c.method === 'resetInput').params;
  ui.move('window');
  await until(() => ui.element('connection-header').hidden);
  assert.equal(ui.calls.filter(c => c.method === 'resetInput').length, 1);
  assert.equal(ui.toolbar().actions.find(a => a.id === 'reset-input').icon, 'assets/input-reset.svg');
  await ui.action('reset-input');
  assert.deepEqual(ui.calls.filter(c => c.method === 'resetInput').at(-1).params, original);
  await ui.action('disconnect');
  await until(() => ui.element('reset-input').disabled);
  assert.equal(ui.calls.filter(c => c.method === 'resetInput').length, 2);
});

test('reset input prevents duplicate clicks, reports failures and permits an explicit retry', async t => {
  let fail = true, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const ui = await fixture(t, { resetInput: async () => { if (fail) { await pending; throw new Error('RDP_INPUT_UNAVAILABLE'); } } });
  await until(() => !ui.element('connect').disabled); ui.submit();
  await until(() => !ui.element('reset-input').disabled);
  ui.element('reset-input').click();
  await until(() => ui.element('reset-input').disabled);
  await ui.action('reset-input');
  assert.equal(ui.calls.filter(c => c.method === 'resetInput').length, 1);
  const signal = new ui.window.AbortController().signal;
  let prepared = false;
  const preparing = ui.lifecycle().prepare({ signal }).then(state => { prepared = true; return state; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(prepared, false, 'Handoff must wait for a pending reset receipt.');
  finish();
  assert.equal((await preparing).errorKey, 'errors.input_reset');
  await ui.lifecycle().resume({ signal });
  await until(() => !ui.element('reset-input').disabled);
  assert.match(ui.element('error-message').textContent, /reset keyboard and mouse input/i);
  fail = false;
  await ui.action('reset-input');
  assert.equal(ui.element('error').hidden, true);
  assert.equal(ui.calls.filter(c => c.method === 'resetInput').length, 2);
});


test('a new window uses the configured size and later frames never override manual window sizing', async t => {
  const ui = await fixture(t, { location: 'window', profile: { desktopWidth: 1920, desktopHeight: 1080 } });
  assert.deepEqual({ ...ui.calls.find(call => call.method === 'resizeWindow').params }, { width: 1920, height: 1080 });
  ui.element('session-password').value = 'fixture'; ui.submit();
  await until(() => ui.calls.some(call => call.method === 'resizeWindow' && call.phase === 'active'));
  const sizes = () => ui.calls.filter(call => call.method === 'resizeWindow' && call.phase === 'active');
  assert.deepEqual({ ...sizes()[0].params }, { width: 1944, height: 1104 });
  ui.window.__remoteSize(1024, 768);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(sizes().length, 1, 'Repeated frames must not override manual resizing');
  assert.equal(ui.calls.some(call => call.method === 'resize'), false, 'Fixed resolution does not send a remote resize after fitting the window');
  await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal });
  ui.window.__remoteSize(1280, 800);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sizes().length, 1, 'A source handing off cannot resize');
  await ui.lifecycle().resume({ signal: new ui.window.AbortController().signal });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sizes().length, 1, 'Resuming a failed handoff preserves the source window size');
  const sidebar = await fixture(t);
  sidebar.element('session-password').value = 'fixture'; sidebar.submit();
  await until(() => sidebar.window.document.body.dataset.connected === 'true');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sidebar.calls.some(call => call.method === 'resizeWindow'), false);
});

test('failed window fitting reports the error without disconnecting the desktop', async t => {
  const ui = await fixture(t, { location: 'window', resize: () => { throw new Error('Resize failed'); } });
  ui.element('session-password').value = 'fixture'; ui.submit();
  await until(() => ui.element('error-message').textContent.includes('fit the window'));
  assert.equal(ui.window.document.body.dataset.connected, 'true');
  assert.equal(ui.calls.some(call => ['disconnect', 'server.close'].includes(call.method)), false);
});

test('the window fit button can refit the same desktop and retry a failed automatic fit without reconnecting', async t => {
  let fail = true;
  const ui = await fixture(t, { resizeSupported: false, location: 'window', resize: () => { if (fail) throw new Error('Resize failed'); } });
  ui.element('session-password').value = 'fixture'; ui.submit();
  await until(() => ui.element('error-message').textContent.includes('fit the window'));
  const action = ui.toolbar().actions.find(action => action.id === 'fit-window');
  assert.equal(action.label, 'Fit window to desktop');
  assert.equal(action.disabled, false);
  assert.ok(ui.toolbar().actions.some(action => action.id === 'input-text'));
  fail = false;
  await ui.action('fit-window');
  await ui.action('fit-window');
  assert.equal(ui.element('error').hidden, true);
  const sizes = ui.calls.filter(call => call.method === 'resizeWindow' && call.phase === 'active');
  assert.equal(sizes.length, 3);
  assert.equal(sizes[0].params.restore, undefined);
  assert.equal(sizes[1].params.restore, true);
  assert.equal(sizes[2].params.restore, true);
  assert.equal(ui.calls.some(call => ['disconnect', 'server.close'].includes(call.method)), false);
  ui.move('sidebar');
  await until(() => !ui.toolbar().actions.some(action => action.id === 'fit-window'));
  await ui.action('fit-window');
  assert.equal(ui.calls.filter(call => call.method === 'resizeWindow' && call.phase === 'active').length, 3);
});

test('the first frame enables window fitting without waiting for another connection update', async t => {
  const ui = await fixture(t, { resizeSupported: false, location: 'window', delayFirstFrame: true });
  ui.element('session-password').value = 'fixture'; ui.submit();
  await until(() => ui.element('status').textContent === 'Connected' && !ui.toolbar().actions.find(action => action.id === 'ui-lock').disabled);
  assert.equal(ui.toolbar().actions.find(action => action.id === 'fit-window').disabled, true);
  assert.equal(ui.calls.some(call => call.method === 'resizeWindow' && call.phase === 'active'), false);
  ui.window.__remoteSize(1024, 768);
  await until(() => ui.calls.some(call => call.method === 'resizeWindow' && call.phase === 'active'));
  assert.equal(ui.toolbar().actions.find(action => action.id === 'fit-window').disabled, false);
});


test('clipboard support is opt-in and the shared toggle follows the connection snapshot', async t => {
  const unsupported = await fixture(t);
  const supportLabel = () => unsupported.window.document.querySelector('[data-label="clipboard-support"]').textContent;
  assert.equal(supportLabel(), 'Support clipboard');
  unsupported.info.language = 'zh-CN';
  unsupported.window.dispatchEvent(new unsupported.window.Event('focus'));
  await until(() => supportLabel() === '支持剪贴板');
  assert.equal(unsupported.element('clipboard').hidden, true);
  assert.equal(unsupported.toolbar().actions.some(a => a.id === 'clipboard'), false);
  const ui = await fixture(t, { profile: { clipboardSupport: true } });
  ui.submit(); await until(() => ui.window.document.body.dataset.connected === 'true');
  assert.equal(ui.calls.find(c => c.method === 'create').params.clipboardSupport, true);
  assert.equal(ui.element('clipboard').hidden, false);
  assert.equal(ui.element('clipboard').getAttribute('aria-pressed'), 'false');
  await ui.action('clipboard');
  assert.equal(ui.element('clipboard').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.toolbar().actions.find(a => a.id === 'clipboard').pressed, true);
  for (const [state, label] of [['syncing', 'Syncing'], ['paused', 'Waiting for activation'], ['draining', 'Finishing transfer']]) {
    ui.window.__remoteClipboard(true, state);
    await until(() => ui.toolbar().actions.find(a => a.id === 'clipboard').label.includes(label));
    assert.equal(ui.toolbar().actions.find(a => a.id === 'clipboard').pressed, true);
  }
  ui.window.__remoteClipboard(false);
  assert.equal(ui.element('clipboard').getAttribute('aria-pressed'), 'false');
});
test('clipboard busy leaves its toggle unchanged and reports the transfer', async t => {
  const ui = await fixture(t, { profile: { clipboardSupport: true }, clipboardError: 'RDP_CLIPBOARD_BUSY' });
  ui.submit(); await until(() => ui.window.document.body.dataset.connected === 'true');
  await ui.action('clipboard');
  assert.equal(ui.element('clipboard').getAttribute('aria-pressed'), 'false');
  assert.match(ui.element('error-message').textContent, /file transfer/);
});


for (const location of ['sidebar', 'window']) test('explicit disconnect closes the ' + location + ' after ending its connection', async t => {
  const ui = await fixture(t, { location, find: () => displayFixture });
  await until(() => ui.element('status').textContent === 'Connected');
  if (location === 'window') await ui.action('disconnect'); else ui.element('disconnect').click();
  await until(() => ui.calls.some(call => call.method === 'closeView'));
  assert.equal(ui.calls.find(call => call.method === 'server.close').params.profile_id, 'fixture');
  assert.equal(ui.calls.find(call => call.method === 'closeView').params.instanceId, 'fixture');
  assert.ok(ui.calls.findIndex(call => call.method === 'server.close') < ui.calls.findIndex(call => call.method === 'closeView'));
});

test('a remotely disconnected row can be explicitly closed without a live session', async t => {
  const ui = await fixture(t, { manager: true, openProfiles: () => ['fixture'] });
  contextMenu(ui, 'fixture'); menuItem(ui, 'Disconnect').click();
  await until(() => ui.calls.some(call => call.method === 'closeView'));
  assert.equal(ui.calls.find(call => call.method === 'server.close').params.profile_id, 'fixture');
});

for (const location of ['sidebar', 'window']) test(`explicit disconnect closes a retained ${location} with no remaining session`, async t => {
  let terminal = false;
  const ui = await fixture(t, { location, status: () => ({ state: terminal ? 'closed' : 'connected', certificate: null }) });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  terminal = true;
  ui.window.__remoteState('RDP_DISPLAY_CLOSED');
  await until(() => ui.element('status').textContent === 'Disconnected' && !ui.element('connect').disabled);
  // Let the asynchronous terminal-status refresh discard the old session identity.
  await new Promise(setImmediate);
  assert.equal(ui.calls.some(call => call.method === 'closeView'), false);
  assert.equal(ui.element('disconnect').disabled, false);
  assert.equal(ui.toolbar().actions.find(action => action.id === 'disconnect').disabled, false);
  if (location === 'window') await ui.action('disconnect'); else ui.element('disconnect').click();
  await until(() => ui.calls.some(call => call.method === 'closeView'));
  assert.equal(ui.calls.find(call => call.method === 'server.close').params.profile_id, 'fixture');
  assert.equal(ui.calls.find(call => call.method === 'closeView').params.instanceId, 'fixture');
});

test('a remote connection failure retains the desktop and reconnect controls', async t => {
  const ui = await fixture(t, { connect: () => { throw new Error('Network failed'); } });
  ui.submit(); await until(() => ui.element('status').textContent === 'Disconnected');
  assert.equal(ui.calls.some(call => call.method === 'closeView'), false);
  assert.equal(ui.element('connect').disabled, false);
});

for (const location of ['sidebar', 'window']) test(`a retained disconnected ${location} attaches a tool-created replacement connection`, async t => {
  let live = null;
  const ui = await fixture(t, { location, find: () => live });
  assert.equal(ui.element('connect').disabled, false);
  live = { ...displayFixture, id: 'replacement' };
  await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.calls.some(call => call.method === 'create'), false);
  assert.equal(ui.calls.find(call => call.method === 'claim').params.id, 'replacement');
  assert.equal(ui.calls.some(call => call.method === 'closeView'), false);
});

for (const location of ['sidebar', 'window']) test(`failed ${location} disconnect stays visible until explicit retry`, async t => {
  const ui = await fixture(t, { location, find: () => displayFixture, disconnect: () => { throw new Error('stop failed'); } });
  await until(() => ui.element('status').textContent === 'Connected');
  await ui.action('disconnect');
  const message = ui.element('error-message').textContent;
  assert.match(message, /clean|close|stop/i);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(ui.element('error-message').textContent, message);
  assert.equal(ui.element('error').hidden, false);
  assert.equal(ui.element('status').textContent, 'Disconnected');
  assert.equal(ui.calls.filter(call => call.method === 'claim').length, 1);
  assert.equal(ui.calls.some(call => call.method === 'closeView'), false);
});
test('a toolbar close may dispose its own page before the backend reply', async t => {
  let ui;
  ui = await fixture(t, { find: () => displayFixture, closeView: async () => {
    await ui.lifecycle().dispose({ reason: 'closed', signal: new ui.window.AbortController().signal });
  } });
  await until(() => ui.element('status').textContent === 'Connected');
  await ui.action('disconnect');
  assert.equal(ui.hasToolbarListener(), false);
});
test('clipboard controls wait for protocol readiness independently of the first frame', async t => {
  const ui = await fixture(t, { profile: { clipboardSupport: true }, clipboardState: 'initializing' });
  ui.submit(); await until(() => ui.window.document.body.dataset.connected === 'true');
  assert.equal(ui.element('clipboard').disabled, true);
  assert.match(ui.toolbar().actions.find(action => action.id === 'clipboard').label, /initializing/);
  await ui.action('clipboard');
  assert.equal(ui.calls.some(call => call.method === 'setClipboardEnabled'), false);
  ui.window.__remoteClipboard(false, 'disabled');
  await until(() => !ui.element('clipboard').disabled);
  await ui.action('clipboard');
  assert.equal(ui.element('clipboard').getAttribute('aria-pressed'), 'true');
});
test('a reused connection survives an attachment failure', async t => {
  const ui = await fixture(t, { createReused: true, connect: () => { throw new Error('display failed'); } });
  ui.submit(); await until(() => !ui.element('error').hidden);
  assert.equal(ui.calls.some(call => ['disconnect', 'server.close'].includes(call.method)), false);
});

test('adaptive options are independent, default off, and survive editor handoff and save', async t => {
  const ui = await fixture(t, { manager: true });
  ui.element('profiles').querySelector('[data-action=edit]').click();
  await until(() => !ui.element('profile-editor').hidden);
  assert.equal(ui.element('adaptive-window').checked, false); assert.equal(ui.element('adaptive-sidebar').checked, false);
  ui.element('adaptive-window').checked = true;
  const restore = await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal, context: ui.context });
  const moved = await fixture(t, { manager: true, restore });
  assert.equal(moved.element('adaptive-window').checked, true); assert.equal(moved.element('adaptive-sidebar').checked, false);
  moved.submit(); await until(() => !moved.element('manager').hidden);
  const saved=moved.calls.find(call=>call.method==='profiles.save').params;
  assert.equal(saved.adaptiveWindow,true); assert.equal(saved.adaptiveSidebar,false);
});

test('adaptive detached windows expose size choices, restore the window on selection and retain the saved fixed size', async t => {
  const ui = await fixture(t, { location: 'window', profile: { adaptiveWindow: true, adaptiveSidebar: false, desktopWidth: 1920, desktopHeight: 1080 } });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  await until(() => ui.calls.some(call => call.method === 'resize'));
  assert.deepEqual(ui.calls.filter(call=>call.method==='resize').map(call=>[call.params.width,call.params.height]),[[1920,1080]]);
  assert.equal(ui.calls.filter(call=>call.method==='resizeWindow' && call.phase === 'active').length,1,'The configured size fits the window before adaptation starts');
  assert.equal(ui.toolbar().actions.some(action=>action.id==='fit-window'),false);
  const menu = ui.toolbar().actions.find(action=>action.id==='resolution-menu'); assert.equal(menu.items.length,6);
  await ui.action('resolution-1280-800');
  assert.deepEqual({ ...ui.calls.filter(call=>call.method==='resizeWindow').at(-1).params },{ width:1304,height:824,restore:true });
  assert.equal(ui.calls.some(call=>call.method==='profiles.save'),false);
  ui.move('sidebar'); await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(ui.calls.filter(call => call.method === 'resize').length, 2, 'Only initial adaptation and the manual size are sent; the sidebar keeps that size');
});

test('adaptive windows use the profile size instead of the sidebar frame and wait for fitting before adapting', async t => {
  const fitting = deferred();
  const ui = await fixture(t, { location: 'window', delayFirstFrame: true, profile: { adaptiveWindow: true, desktopWidth: 1280, desktopHeight: 800 }, resize: () => fitting.promise });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(ui.calls.some(call => ['resize', 'resizeWindow'].includes(call.method) && call.phase !== 'preparing'), false, 'Wait for the actual first frame before adapting');
  ui.window.__remoteSize(400, 700);
  await until(() => ui.calls.some(call => call.method === 'resizeWindow' && call.phase === 'active'));
  assert.deepEqual({ ...ui.calls.find(call => call.method === 'resizeWindow' && call.phase === 'active').params }, { width: 1304, height: 824 });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(ui.calls.some(call => call.method === 'resize'), false, 'The default window size cannot override the initial resolution');
  ui.element('desktop').getBoundingClientRect = () => ({ width: 1280, height: 800 });
  fitting.resolve();
  await until(() => ui.calls.some(call => call.method === 'resize'));
  assert.deepEqual(ui.calls.filter(call => call.method === 'resize').map(call => [call.params.width, call.params.height]), [[1280, 800]]);
  ui.element('desktop').getBoundingClientRect = () => ({ width: 1100, height: 700 }); ui.window.__resizeDesktop();
  await until(() => ui.calls.filter(call => call.method === 'resize').length === 2);
  ui.window.__remoteSize(1100, 700);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(ui.calls.filter(call => call.method === 'resizeWindow' && call.phase === 'active').length, 1, 'Later frames follow the window, without reverse fitting');
});

test('hidden adaptive pages defer viewport updates and resume immediately when selected', async t => {
  const ui=await fixture(t,{profile:{adaptiveSidebar:true}});
  ui.submit(); await until(()=>ui.calls.some(call=>call.method==='resize'));
  ui.visibility(false);
  ui.element('desktop').getBoundingClientRect=()=>({width:400,height:700}); ui.window.__resizeDesktop();
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(ui.calls.filter(call=>call.method==='resize').length,1);
  ui.visibility(true);
  await until(()=>ui.calls.filter(call=>call.method==='resize').length===2);
  const size=ui.calls.filter(call=>call.method==='resize').at(-1).params;
  assert.equal(size.width,400);assert.equal(size.height,700);
});

test('the sidebar move icon uses page handoff, prevents duplicate moves and reports failures', async t => {
  const pending = deferred();
  const ui = await fixture(t, { move: () => pending.promise });
  const button = ui.element('move-window');
  assert.equal(ui.element('disconnect').nextElementSibling, button);
  assert.equal(button.hidden, false); assert.equal(button.title, 'Move to separate window');
  assert.match(button.querySelector('img').src, /move-window\.svg$/);
  button.click(); button.click();
  assert.equal(button.disabled, true);
  assert.deepEqual(ui.calls.filter(call => call.method === 'moveView').map(call => call.params.location), ['window']);
  // Preparing the source while the move is pending must not wait on the move itself.
  await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal, context: ui.context });
  await ui.lifecycle().resume({ signal: new ui.window.AbortController().signal, context: ui.context });
  pending.reject(new Error('PANEL_LOAD_FAILED'));
  await until(() => !button.disabled && !ui.element('error').hidden);
  assert.match(ui.element('error-message').textContent, /move/i);
  assert.equal(ui.calls.some(call => ['create', 'disconnect', 'profiles.save'].includes(call.method)), false);
  ui.info.language = 'zh-CN'; ui.window.dispatchEvent(new ui.window.Event('focus'));
  await until(() => button.title === '移到独立窗口');
  ui.move('window'); assert.equal(button.hidden, true);
  const home = await fixture(t, { manager: true }); assert.equal(home.element('move-window').hidden, true);
});

test('unsupported adaptive resolution warns once and keeps the original connected desktop', async t => {
  const ui=await fixture(t,{location:'window',profile:{adaptiveWindow:true},remoteResize:async()=>{throw new Error('RDP_RESIZE_UNSUPPORTED');}});
  ui.submit(); await until(()=>!ui.element('resize-warning').hidden);
  assert.match(ui.element('resize-warning').textContent,/does not support/);
  assert.equal(ui.element('status').textContent,'Connected');
  assert.equal(ui.toolbar().actions.some(action=>action.id==='resolution-menu'),false);
  assert.equal(ui.toolbar().actions.find(action=>action.id==='fit-window').disabled,false);
  ui.window.__resizeDesktop(); await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(ui.calls.filter(call=>call.method==='resize').length,1);
  assert.equal(ui.calls.filter(call=>call.method==='create').length,1);
  assert.equal(ui.calls.some(call=>call.method==='disconnect'),false);
});

test('normal window size survives handoff and background closure, independently of remote frames and fullscreen', async t => {
  let size = null;
  const memory = { get: () => size, set: value => { size = { width: value.width, height: value.height }; } };
  const ui = await fixture(t, { location: 'window', windowState: memory, profile: { adaptiveWindow: true, desktopWidth: 1280, desktopHeight: 800 } });
  ui.submit(); await until(() => ui.calls.some(call => call.method === 'windowState.set'));
  ui.element('desktop').getBoundingClientRect = () => ({ width: 1200, height: 850 }); ui.window.__resizeDesktop();
  // Moving immediately must flush the latest normal viewport, even before the debounce.
  const restore = await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal });
  assert.deepEqual(size, { width: 1224, height: 874 });
  const moved = await fixture(t, { location: 'window', restore, windowState: memory, prepareResize: async (_size, context) => {
    assert.equal(context.phase, 'preparing', 'Restore the hidden window before activation completes');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(size, { width: 1224, height: 874 }, 'Preparation cannot overwrite saved dimensions');
  } });
  await until(() => moved.calls.some(call => call.method === 'resizeWindow'));
  assert.deepEqual({ ...moved.calls.find(call => call.method === 'resizeWindow').params }, { width: 1224, height: 874 });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(size, { width: 1224, height: 874 }, 'The default target window cannot overwrite saved dimensions before fitting');
  moved.element('desktop').getBoundingClientRect = () => ({ width: 1200, height: 850 }); moved.window.__resizeDesktop();
  await until(() => moved.calls.some(call => call.method === 'resize'));
  moved.mode('maximized'); moved.element('desktop').getBoundingClientRect = () => ({ width: 1900, height: 1000 }); moved.window.__resizeDesktop();
  await new Promise(resolve => setTimeout(resolve, 350));
  moved.mode('fullscreen'); moved.window.__remoteSize(1920, 1080); moved.window.__resizeDesktop();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(size, { width: 1224, height: 874 }, 'Maximized/fullscreen frames and viewports are not the normal window size');
  await moved.lifecycle().dispose({ signal: new moved.window.AbortController().signal, reason: 'closed' });
  assert.deepEqual(size, { width: 1224, height: 874 });
  const reopened = await fixture(t, { location: 'window', windowState: memory, profile: restore.view.profile, find: () => restore.session });
  await until(() => reopened.calls.some(call => call.method === 'resizeWindow'));
  assert.deepEqual({ ...reopened.calls.find(call => call.method === 'resizeWindow').params }, { width: 1224, height: 874 });
  assert.equal(reopened.calls.some(call => call.method === 'create'), false, 'Reopening attaches to the live session');
});

test('fractional parent allocation wins over an outward-rounded iframe desktop', async t => {
  const ui = await fixture(t, { location: 'window', profile: { adaptiveWindow: true } });
  ui.submit(); await until(() => ui.calls.some(call => call.method === 'resize'));
  ui.window.innerWidth = 1600; ui.window.innerHeight = 901;
  ui.window.document.documentElement.getBoundingClientRect = () => ({ width: 1600, height: 901 + 1 / 3 });
  ui.element('desktop').getBoundingClientRect = () => ({ width: 1600, height: 901 + 1 / 3 });
  ui.context.viewport = ui.info.view.viewport = { width: 1600, height: 900 + 1 / 3 };
  ui.context.windowResizeRevision = ui.info.view.windowResizeRevision = 1;
  ui.move('window');
  ui.window.__resizeDesktop(false);
  await until(() => ui.calls.filter(call => call.method === 'resize').at(-1)?.params.width === 1600);
  const request = ui.calls.filter(call => call.method === 'resize').at(-1).params;
  assert.equal(request.height, 900);
  await ui.action('resolution-1600-900');
  assert.deepEqual({ ...ui.calls.filter(call => call.method === 'resizeWindow').at(-1).params }, { width: 1600, height: 900, restore: true });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(ui.calls.filter(call => call.method === 'resize').at(-1).params.height, 900);
});

test('window movement and layout rounding never create a remote resize, before or after a manual selection', async t => {
  const ui = await fixture(t, { location: 'window', profile: { adaptiveWindow: true } });
  ui.submit(); await until(() => ui.calls.some(call => call.method === 'resize'));
  for (const select of [false, true]) {
    if (select) await ui.action('resolution-1600-900');
    const count = ui.calls.filter(call => call.method === 'resize').length;
    // Child layout may arrive before the host's movement/viewport notification.
    ui.element('desktop').getBoundingClientRect = () => ({ width: 1600, height: 901 });
    ui.window.__resizeDesktop(false);
    await new Promise(resolve => setTimeout(resolve, 350));
    ui.context.viewport = ui.info.view.viewport = { width: 1624, height: 925 };
    ui.window.innerWidth = 1624; ui.window.innerHeight = 925;
    ui.place({ displayId: 2, x: 100, y: 100 });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(ui.calls.filter(call => call.method === 'resize').length, count);
  }
  ui.element('desktop').getBoundingClientRect = () => ({ width: 1200, height: 700 });
  ui.window.__resizeDesktop(); // A completed user resize has a new host revision.
  await until(() => ui.calls.filter(call => call.method === 'resize').at(-1).params.width === 1200);
  assert.equal(ui.calls.filter(call => call.method === 'resize').at(-1).params.height, 700);
});

test('cross-DPI child layout cannot resize the remote desktop or overwrite native window memory', async t => {
  let size;
  const memory = { get: () => size ?? null, set: value => { size = { width: value.width, height: value.height }; } };
  const ui = await fixture(t, { location: 'window', windowState: memory, profile: { adaptiveWindow: true } });
  ui.submit(); await until(() => ui.calls.some(call => call.method === 'resize') && size);
  const before = ui.calls.filter(call => call.method === 'resize').length, savedSize = { ...size };
  // The owning document still assigns 1024 × 768 while its child changes scale.
  ui.window.innerWidth = 512; ui.window.innerHeight = 384;
  ui.element('desktop').getBoundingClientRect = () => ({ width: 488, height: 360 });
  ui.window.__resizeDesktop(false); ui.place({ displayId: 9, x: 100, y: 50 });
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(ui.calls.filter(call => call.method === 'resize').length, before);
  assert.deepEqual(size, savedSize);
  // Closing during the transition preserves the last deliberate size.
  await ui.lifecycle().dispose({ signal: new ui.window.AbortController().signal, reason: 'closed' });
  assert.deepEqual(size, savedSize);
  const reopened = await fixture(t, { location: 'window', windowState: memory, find: () => ({ id: 'retained', url: 'ws://fixture', token: 'token' }) });
  await until(() => reopened.calls.some(call => call.method === 'resizeWindow'));
  assert.deepEqual({ ...reopened.calls.find(call => call.method === 'resizeWindow').params }, size);
});

test('a failed window restoration preserves memory and pauses adaptive resize until an explicit retry', async t => {
  const writes = [];
  const ui = await fixture(t, { location: 'window', profile: { adaptiveWindow: true }, windowState: { get: () => ({ width: 1200, height: 850 }), set: value => writes.push(value) }, resize: () => { throw new Error('Window closed'); } });
  ui.submit(); await until(() => !ui.element('error').hidden);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(ui.calls.some(call => call.method === 'resize'), false);
  assert.deepEqual(writes, []);
});

test('sidebar connection status uses the same tone as the window toolbar', async t => {
  const ui = await fixture(t);
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  assert.equal(ui.element('status').dataset.tone, 'success');
  assert.equal(ui.element('status').dataset.tone, ui.toolbar().status.tone);
  ui.window.__remoteState('closed');
  await until(() => ui.toolbar().status.tone === 'neutral');
  assert.equal(ui.element('status').dataset.tone, ui.toolbar().status.tone);
});

test('cancelled handoff retries an interrupted initial size restore on the original page', async t => {
  const reading = deferred();
  const ui = await fixture(t, { location: 'window', profile: { adaptiveWindow: true, desktopWidth: 1280, desktopHeight: 800 }, windowState: { get: () => reading.promise, set: () => {} } });
  ui.submit(); await until(() => ui.calls.some(call => call.method === 'windowState.get'));
  const preparing = ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal });
  reading.resolve(null); await preparing;
  assert.equal(ui.calls.some(call => call.method === 'resizeWindow' && call.phase === 'active'), false);
  await ui.lifecycle().resume({ signal: new ui.window.AbortController().signal });
  await until(() => ui.calls.some(call => call.method === 'resizeWindow' && call.phase === 'active'));
  assert.deepEqual({ ...ui.calls.find(call => call.method === 'resizeWindow' && call.phase === 'active').params }, { width: 1304, height: 824 });
});

test('continuous display updates do not postpone remembering a resized window', async t => {
  let size = null;
  const ui = await fixture(t, { location: 'window', windowState: { get: () => size, set: value => { size = { width: value.width, height: value.height }; } } });
  ui.submit(); await until(() => ui.calls.some(call => call.method === 'windowState.set'));
  ui.element('desktop').getBoundingClientRect = () => ({ width: 1150, height: 810 }); ui.window.__resizeDesktop();
  for (let i = 0; i < 10; i++) { ui.window.__remoteState('connected'); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.deepEqual(size, { width: 1174, height: 834 });
  // Confirm a final normal size, then maximize before its write debounce ends.
  ui.element('desktop').getBoundingClientRect = () => ({ width: 1170, height: 830 }); ui.window.__resizeDesktop();
  await new Promise(resolve => setTimeout(resolve, 20));
  ui.mode('maximized'); ui.element('desktop').getBoundingClientRect = () => ({ width: 1900, height: 1000 }); ui.window.__resizeDesktop();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(size, { width: 1194, height: 854 });
});


test('window placement is remembered on movement and refreshed on close before the move event', async t => {
  let state = null;
  const memory = { get: () => state, set: value => { state = JSON.parse(JSON.stringify({ width: value.width, height: value.height, placement: value.placement })); } };
  const ui = await fixture(t, { location: 'window', placement: { displayId: 1, x: 100, y: 50 }, windowState: memory });
  ui.submit(); await until(() => state !== null);
  assert.deepEqual(state.placement, { displayId: 1, x: 100, y: 50 });
  const savedSize = { width: state.width, height: state.height };
  ui.place({ displayId: 9, x: 200, y: 100 });
  await until(() => state.placement.displayId === 9);
  assert.deepEqual(state, { ...savedSize, placement: { displayId: 9, x: 200, y: 100 } });
  ui.mode('fullscreen'); ui.place({ displayId: 1, x: 0, y: 0 });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(state.placement.displayId, 9, 'Fullscreen coordinates must not replace normal placement');
  ui.mode('normal');
  ui.context.windowPlacement = { displayId: 9, x: 350, y: 90 };
  await ui.lifecycle().dispose({ signal: new ui.window.AbortController().signal, reason: 'closed' });
  assert.deepEqual(state.placement, { displayId: 9, x: 350, y: 90 });
  const restored = await fixture(t, { location: 'window', windowState: memory, find: () => ({ id: 'retained', url: 'ws://fixture', token: 'token' }) });
  await until(() => restored.calls.some(call => call.method === 'resizeWindow'));
  const request = JSON.parse(JSON.stringify(restored.calls.find(call => call.method === 'resizeWindow').params));
  assert.deepEqual(request, { width: 1024, height: 768, restorePlacement: { displayId: 9, x: 350, y: 90 } });
  assert.equal(restored.calls.some(call => ['create', 'disconnect', 'profiles.save'].includes(call.method)), false);
});


test('a rebuilt non-adaptive sidebar retains the remote frame and does not resize on visibility or viewport changes', async t => {
  const source = await fixture(t, { location: 'window', profile: { adaptiveWindow: true, adaptiveSidebar: false, desktopWidth: 1920, desktopHeight: 1080 } });
  source.submit(); await until(() => source.calls.some(call => call.method === 'resize'));
  const restore = await source.lifecycle().prepare({ signal: new source.window.AbortController().signal });
  const sidebar = await fixture(t, { restore });
  await until(() => sidebar.element('status').textContent === 'Connected');
  sidebar.window.__remoteSize(1600, 900);
  sidebar.element('desktop').getBoundingClientRect = () => ({ width: 350, height: 700 });
  sidebar.window.__resizeDesktop();
  sidebar.visibility(false); sidebar.visibility(true);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(sidebar.calls.some(call => ['resize', 'create', 'disconnect'].includes(call.method)), false);
  const canvas = sidebar.element('desktop').querySelector('canvas');
  assert.deepEqual([canvas.width, canvas.height], [1600, 900]);
});

test('sidebar resolution menu includes the custom profile size and changes only the remote desktop', async t => {
  const pending = deferred();
  let remembered = { width: 1200, height: 850 };
  const memory = { get: () => remembered, set: value => { remembered = { width: value.width, height: value.height }; } };
  const ui = await fixture(t, { windowState: memory, profile: { adaptiveWindow: true, adaptiveSidebar: false, desktopWidth: 1536, desktopHeight: 864 }, remoteResize: () => pending.promise });
  const button = ui.element('resolution-menu');
  assert.equal(button.hidden, true);
  ui.submit(); await until(() => !button.disabled);
  button.click();
  const items = [...ui.window.document.querySelectorAll('[role=menuitemradio]')];
  assert.equal(items.length, 6);
  assert.equal(items.find(item => item.getAttribute('aria-checked') === 'true').textContent, '1024 × 768');
  const initial = items.find(item => item.textContent === '1536 × 864 (default)');
  assert.equal(initial.getAttribute('aria-checked'), 'false');
  initial.click();
  await until(() => ui.calls.some(call => call.method === 'resize'));
  assert.equal(button.disabled, true, 'Duplicate selections wait for the pending request');
  assert.equal(ui.window.document.querySelector('[role=menu]'), null);
  assert.deepEqual(ui.calls.filter(call => call.method === 'resize').map(call => [call.params.width, call.params.height]), [[1536, 864]]);
  pending.resolve(); await until(() => !button.disabled);
  ui.window.__remoteSize(1536, 864);
  assert.match(button.title, /1536 × 864/);
  button.click();
  assert.equal(ui.window.document.querySelector('[aria-checked=true]').textContent, '1536 × 864 (default)');
  ui.element('desktop').getBoundingClientRect = () => ({ width: 450, height: 600 }); ui.window.__resizeDesktop();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(ui.calls.filter(call => call.method === 'resize').length, 1);
  assert.equal(ui.calls.some(call => ['resizeWindow', 'windowState.set', 'profiles.save', 'moveView'].includes(call.method)), false);
  const restore = await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal });
  assert.deepEqual(remembered, { width: 1200, height: 850 });
  const reopened = await fixture(t, { location: 'window', restore, windowState: memory });
  await until(() => reopened.calls.some(call => call.method === 'resizeWindow'));
  assert.deepEqual({ ...reopened.calls.find(call => call.method === 'resizeWindow').params }, { width: 1200, height: 850 },
    'Restore the complete remembered window viewport, independently of the sidebar resolution');
});

test('sidebar resolution selection reports a busy rejection and clears it after a successful retry', async t => {
  let busy = true;
  const ui = await fixture(t, { profile: { adaptiveWindow: true, adaptiveSidebar: false },
    remoteResize: () => { if (busy) throw new Error('RDP_INPUT_BUSY'); } });
  ui.submit(); await until(() => !ui.element('resolution-menu').disabled);
  const choose = () => {
    ui.element('resolution-menu').click();
    [...ui.window.document.querySelectorAll('[role=menuitemradio]')].find(item => item.textContent === '1600 × 900').click();
  };
  choose();
  await until(() => !ui.element('error').hidden && !ui.element('resolution-menu').disabled);
  assert.match(ui.element('error-message').textContent, /Wait for input operations/);
  assert.equal(ui.element('resize-warning').hidden, true, 'A busy input channel does not disable dynamic resolution');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(ui.calls.filter(call => call.method === 'resize').length, 1, 'A manual selection is not silently retried');
  busy = false; choose();
  await until(() => ui.element('error').hidden && !ui.element('resolution-menu').disabled);
  assert.equal(ui.calls.filter(call => call.method === 'resize').length, 2);
});

test('window menu includes a custom configured size and restores the normal window when selected', async t => {
  const ui = await fixture(t, { location: 'window', profile: { adaptiveWindow: true, desktopWidth: 1536, desktopHeight: 864 } });
  ui.submit(); await until(() => ui.calls.some(call => call.method === 'resize'));
  const menu = ui.toolbar().actions.find(action => action.id === 'resolution-menu');
  assert.equal(menu.items.length, 7);
  assert.equal(menu.items.filter(item => item.id === 'resolution-1536-864').length, 1);
  assert.equal(menu.items.find(item => item.id === 'resolution-1536-864').label, '1536 × 864 (default)');
  await ui.action('resolution-1536-864');
  assert.deepEqual({ ...ui.calls.filter(call => call.method === 'resizeWindow').at(-1).params }, { width: 1560, height: 888, restore: true });
  assert.equal(ui.calls.some(call => call.method === 'profiles.save'), false);
});

test('sidebar manual resolution replaces pending adaptation until its viewport changes', async t => {
  const ui = await fixture(t, { profile: { adaptiveWindow: true, adaptiveSidebar: true } });
  ui.submit(); await until(() => !ui.element('resolution-menu').disabled);
  ui.element('resolution-menu').click();
  const items = [...ui.window.document.querySelectorAll('[role=menuitemradio]')];
  assert.equal(items.length, 5, 'A configured preset is not duplicated');
  items.find(item => item.textContent === '1600 × 900').click();
  await until(() => ui.calls.some(call => call.method === 'resize'));
  ui.window.__remoteSize(1600, 900);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(ui.calls.filter(call => call.method === 'resize').map(call => [call.params.width, call.params.height]), [[1600, 900]]);
  ui.element('desktop').getBoundingClientRect = () => ({ width: 450, height: 600 }); ui.window.__resizeDesktop();
  await until(() => ui.calls.filter(call => call.method === 'resize').length === 2);
  assert.deepEqual(ui.calls.filter(call => call.method === 'resize').map(call => [call.params.width, call.params.height]).at(-1), [450, 600]);
  const fixed = await fixture(t, { profile: { adaptiveWindow: false, adaptiveSidebar: true } });
  assert.equal(fixed.element('resolution-menu').hidden, true);
});


test('server capability controls menus independently of saved preferences, and unavailable windows retain local fit', async t => {
  const ui=await fixture(t,{location:'window',resizeSupported:false,profile:{adaptiveWindow:true}});
  ui.submit(); await until(()=>ui.calls.some(c=>c.method==='resizeWindow'));
  await new Promise(r=>setTimeout(r,350));
  assert.equal(ui.calls.some(c=>c.method==='resize'),false);
  assert.equal(ui.toolbar().actions.some(a=>a.id==='resolution-menu'),false);
  await ui.action('fit-window');
  assert.equal(ui.calls.filter(c=>c.method==='resizeWindow').at(-1).params.restore,true);
  ui.window.__resizeCapability(true);
  await until(()=>ui.toolbar().actions.some(a=>a.id==='resolution-menu'));
  assert.equal(ui.toolbar().actions.some(a=>a.id==='fit-window'),false);
  assert.equal(ui.toolbar().actions.find(a=>a.id==='resolution-menu').items.at(-1).checked,true);
  ui.window.__remoteState('closed');
  await until(()=>ui.toolbar().actions.some(a=>a.id==='fit-window'&&a.disabled));
  const fixed=await fixture(t,{profile:{adaptiveWindow:false,adaptiveSidebar:false}});
  fixed.submit(); await until(()=>!fixed.element('resolution-menu').hidden);
  fixed.element('resolution-menu').click();
  const checkbox=fixed.window.document.querySelector('[role=menuitemcheckbox]');
  assert.equal(checkbox.textContent,'Adaptive resolution');
  assert.equal(checkbox.getAttribute('aria-checked'),'false');
  assert.equal(checkbox.previousElementSibling.getAttribute('role'),'separator');
});

test('menu adaptive checkbox saves only the current location; manual sizes retain it and disabling sends no reset', async t => {
  const {store,profile} = await profileStore(t);
  const ui=await fixture(t,{store,profile});
  ui.submit(); await until(()=>!ui.element('resolution-menu').hidden);
  await ui.action('adaptive-resolution');
  await until(()=>ui.calls.some(c=>c.method==='resize'));
  let saved=await store.call('profiles.get',{id:profile.id});
  assert.equal(saved.adaptiveSidebar,true); assert.equal(saved.adaptiveWindow,false);
  const initial=[saved.desktopWidth,saved.desktopHeight];
  await ui.action('resolution-1600-900');
  assert.equal((await store.call('profiles.get',{id:profile.id})).adaptiveSidebar,true);
  const count=ui.calls.filter(c=>c.method==='resize').length;
  await ui.action('adaptive-resolution'); await new Promise(r=>setTimeout(r,350));
  assert.equal(ui.calls.filter(c=>c.method==='resize').length,count);
  saved=await store.call('profiles.get',{id:profile.id});
  assert.equal(saved.adaptiveSidebar,false); assert.deepEqual([saved.desktopWidth,saved.desktopHeight],initial);
  ui.move('window'); await until(()=>ui.calls.some(c=>c.method==='resizeWindow'));
  await ui.action('adaptive-resolution');
  saved=await store.call('profiles.get',{id:profile.id});
  assert.equal(saved.adaptiveWindow,true); assert.equal(saved.adaptiveSidebar,false);
  const restore=await ui.lifecycle().prepare({signal:new ui.window.AbortController().signal});
  assert.equal(restore.view.profile.adaptiveWindow,true);
  const moved=await fixture(t,{restore,store,profile:saved,location:'window'});
  await until(()=>moved.toolbar().actions.some(a=>a.id==='resolution-menu'));
  assert.equal(moved.toolbar().actions.find(a=>a.id==='resolution-menu').items.at(-1).checked,true);
});

test('re-enabling adaptation after a manual size uses the unchanged current viewport', async t => {
  const ui = await fixture(t, { profile: { adaptiveSidebar: true } });
  ui.submit(); await until(() => ui.calls.some(call => call.method === 'resize'));
  const initial = ui.calls.find(call => call.method === 'resize').params;
  await ui.action('resolution-1600-900');
  await ui.action('adaptive-resolution');
  const count = ui.calls.filter(call => call.method === 'resize').length;
  await ui.action('adaptive-resolution');
  await until(() => ui.calls.filter(call => call.method === 'resize').length > count);
  const current = ui.calls.filter(call => call.method === 'resize').at(-1).params;
  assert.deepEqual([current.width, current.height], [initial.width, initial.height]);
});

test('adaptive save failures keep selection and settings, and page handoff waits for pending persistence', async t => {
  const gate=deferred(); let fail=true;
  const ui=await fixture(t,{location:'window',adaptiveSave:async()=>{if(fail)throw new Error('PROFILE_WRITE_FAILED');await gate.promise;}});
  ui.submit(); await until(()=>ui.toolbar().actions.some(a=>a.id==='resolution-menu'&&!a.disabled));
  await ui.action('adaptive-resolution');
  assert.equal(ui.toolbar().actions.find(a=>a.id==='resolution-menu').items.at(-1).checked,false);
  assert.match(ui.element('error-message').textContent,/save adaptive/);
  fail=false; const save=ui.action('adaptive-resolution');
  let prepared=false;
  const handoff=ui.lifecycle().prepare({signal:new ui.window.AbortController().signal}).then(r=>{prepared=true;return r;});
  await new Promise(r=>setTimeout(r,40)); assert.equal(prepared,false);
  gate.resolve(); await save;
  const restore=await handoff;
  assert.equal(restore.view.profile.adaptiveWindow,true);
  assert.equal(ui.element('error').hidden,true);
});


test('text input preserves Unicode and whitespace across short receipts without sending Enter', async t => {
  const ui = await fixture(t, { location: 'window' });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  await ui.action('input-text');
  const editor = ui.element('text-input-content'), dialog = ui.element('text-input-dialog');
  assert.equal(dialog.open, true); assert.equal(ui.window.document.activeElement, editor);
  const text = ' 你好🐟\t\r\n\\"'.repeat(80) + ' tail ';
  // Native textarea values normalize CRLF to LF; input below is the exact original shown to the user.
  editor.value = text; editor.dispatchEvent(new ui.window.Event('input'));
  const original = editor.value;
  editor.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await until(() => !dialog.open);
  const requests = ui.calls.filter(call => call.method === 'inputText');
  assert.ok(requests.length > 1);
  assert.equal(requests.map(call => call.params.text).join(''), original);
  for (const request of requests) {
    assert.ok(Array.from(request.params.text).length <= 128);
    assert.ok(!/[\uD800-\uDFFF]/u.test(request.params.text));
    assert.ok(Buffer.byteLength(JSON.stringify([{ type: 'text', text: request.params.text }])) <= 12000);
  }
  assert.equal(editor.value, ''); assert.equal(ui.window.__inputBlocked, false);
});

test('text input cancellation waits for the current receipt, preserves the draft and resumes only the remainder', async t => {
  const pending = deferred();
  const ui = await fixture(t, { inputText: () => pending.promise });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  ui.element('input-text').click();
  const dialog = ui.element('text-input-dialog'), editor = ui.element('text-input-content');
  editor.value = '🐟'.repeat(400); editor.dispatchEvent(new ui.window.Event('input'));
  const button = label => [...dialog.querySelectorAll('button')].find(b => b.textContent === label);
  button('Input to remote').click();
  await until(() => ui.calls.some(call => call.method === 'inputText'));
  assert.equal(ui.window.__inputBlocked, true); assert.equal(editor.readOnly, true);
  button('Input to remote').click(); button('Cancel').click(); pending.resolve();
  await until(() => !ui.window.__inputBlocked);
  assert.equal(ui.calls.filter(call => call.method === 'inputText').length, 1);
  assert.equal(editor.value, '🐟'.repeat(400));
  assert.equal(ui.element('text-input-remaining').value, '🐟'.repeat(272));
  button('Input remaining text').click(); await until(() => !dialog.open);
  assert.equal(ui.calls.filter(call => call.method === 'inputText').map(call => call.params.text).join(''), '🐟'.repeat(400));
});

test('failed text delivery and page handoff retain acknowledged progress without replaying the original', async t => {
  let calls = 0;
  const ui = await fixture(t, { inputText: () => { if (++calls === 2) throw new Error('RDP_INPUT_TIMEOUT'); } });
  ui.submit(); await until(() => ui.element('status').textContent === 'Connected');
  ui.element('input-text').click();
  const dialog = ui.element('text-input-dialog'), editor = ui.element('text-input-content');
  editor.value = 'x'.repeat(300); editor.dispatchEvent(new ui.window.Event('input'));
  [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Input to remote').click();
  await until(() => dialog.querySelector('[role=alert]').textContent.includes('failed'));
  assert.equal(ui.element('text-input-remaining').value, 'x'.repeat(172));
  assert.equal([...dialog.querySelectorAll('button')].find(b => b.textContent === 'Input remaining text').disabled, true);
  const restore = await ui.lifecycle().prepare({ signal: new ui.window.AbortController().signal });
  const target = await fixture(t, { location: 'window', restore });
  assert.equal(target.element('text-input-content').value, 'x'.repeat(300));
  assert.equal(target.element('text-input-remaining').value, 'x'.repeat(172));
  assert.equal(target.calls.some(call => call.method === 'inputText'), false);
});
