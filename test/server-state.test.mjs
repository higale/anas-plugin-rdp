import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
async function controlFailure(pending, pattern) {
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, pattern);
  return result;
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rdp-state-'));
  const commands = [], helpers = [], views = [{ panelId: 'home', instanceId: 'main', location: 'sidebar' }];
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      if (request.method) { commands.push({ helper: helpers.indexOf(child), ...request }); if (!child.holdInput || request.method !== 'input') child.stdout.write(JSON.stringify(options.failMethod === request.method
        ? { request: request.request, error: 'Synthetic command failure' }
        : { request: request.request, uiLocked: request.locked, result: options.results?.[request.method] ?? { accepted: true, ui_locked: request.locked, toggle_flags: 0, helper: helpers.indexOf(child) } }) + '\n'); callback(); return; }
      child.start = () => {
        child.stdout.write(JSON.stringify({ status: 'ready', port: 1234 }) + '\n');
        if (options.connected !== false) child.stdout.write(JSON.stringify({ status: 'connected' }) + '\n');
      };
      if (!options.deferStartup) child.start();
      options.onStart?.(); callback();
    } });
    child.stdin.on('finish', () => child.emit('close', 0)); child.kill = () => child.emit('close', 0);
    helpers.push(child); return child;
  };
  const module = { exports: {} };
  runInNewContext(await readFile('dist/backend.cjs', 'utf8'), { module, exports: module.exports, process, Buffer, console, Date, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn } : name === 'node:fs/promises' ? { ...require(name), ...options.files } : require(name) });
  const backend = module.exports;
  const call = (method, params, caller = null) => backend.call(method, params, { caller, views });
  const host = { onViewsChanged: () => () => {}, getViews: async () => views.map(view => ({ ...view })),
    openView: async options => {
      if (!views.some(view => view.instanceId === options.instanceId)) views.push({ panelId: options.instanceId, ...options });
      await call('connection.open', { owner: options.instanceId });
    },
    moveView: async options => { views.find(view => view.instanceId === options.instanceId).location = options.location; },
    closeView: async ({ instanceId }) => {
      const index = views.findIndex(view => view.instanceId === instanceId);
      if (index < 0) return;
      await call('connection.close', { owner: instanceId }, views[index]); views.splice(index, 1);
    }
  };
  const tempDirectory = join(directory, 'tmp', 'anas-plugin-rdp');
  await backend.activate({ pluginId: 'rdp', dataDirectory: directory, tempDirectory: options.withoutTemp ? undefined : tempDirectory, packageDirectory: resolve('dist'), host });
  t.after(async () => { await backend.deactivate(); await rm(directory, { recursive: true, force: true }); });
  const profile = await call('profiles.save', { name: 'Test', host: 'test.invalid', username: 'test', passwordAction: 'set', password: 'synthetic' });
  const ctx = { host, signal: new AbortController().signal, deadline: Date.now() + 60000 };
  const set = (state, extra = {}, context = ctx) => backend.tools.control({ profile_id: profile.id, state, ...extra }, context);
  return { backend, call, host, commands, helpers, views, profile, set, ctx, directory, tempDirectory };
}

const screenshot = [
  { type: 'text', text: JSON.stringify({ width: 1, height: 1, frame_revision: 7, input_revision: 3, cursor_drawn: true }) },
  { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEioAAAAASUVORK5CYII=' }
];
test('a retained page cannot discover a connection before its display endpoint is ready', async t => {
  const started = Promise.withResolvers();
  const f = await fixture(t, { deferStartup: true, onStart: started.resolve });
  const pending = f.set('background');
  await started.promise;
  assert.equal(await f.call('find', { owner: f.profile.id }), null);
  assert.equal((await f.backend.tools.list({}, f.ctx))[0].connection_state, 'starting');
  f.helpers[0].start();
  const connected = await pending;
  assert.equal(connected.ok, true);
  const display = await f.call('find', { owner: f.profile.id });
  assert.equal(display.id, connected.session_id);
  assert.equal(display.url, 'ws://127.0.0.1:1234/display');
  assert.equal(f.helpers.length, 1);
});

test('screenshot saves only when requested and rejects invalid save flags before capture', async t => {
  const f = await fixture(t, { results: { screenshot } }); await f.set('background');
  for (const save of [undefined, false]) {
    const result = await f.backend.tools.screenshot({ profile_id: f.profile.id, save }, f.ctx);
    assert.equal(JSON.stringify(result), JSON.stringify(screenshot));
  }
  await assert.rejects(stat(f.tempDirectory), { code: 'ENOENT' });
  const count = f.commands.length;
  await assert.rejects(f.backend.tools.screenshot({ profile_id: f.profile.id, save: 'true' }, f.ctx), /save setting/);
  assert.equal(f.commands.length, count);
});

test('saved PNGs match returned images, have unique paths and survive cleared temp directories on the next save', async t => {
  const f = await fixture(t, { results: { screenshot } }); await f.set('background');
  const capture = () => f.backend.tools.screenshot({ profile_id: f.profile.id, save: true }, f.ctx);
  const first = await capture();
  const firstPath = JSON.parse(first[0].text).saved_path;
  assert.equal(await stat(firstPath).then(info => info.isFile()), true);
  await rm(f.tempDirectory, { recursive: true });
  const results = await Promise.all([capture(), capture()]);
  const paths = [firstPath];
  for (const result of results) {
    const { saved_path, ...metadata } = JSON.parse(result[0].text);
    assert.equal(JSON.stringify(metadata), screenshot[0].text);
    assert.equal(JSON.stringify(result[1]), JSON.stringify(screenshot[1]));
    assert.equal(join(saved_path, '..'), join(f.tempDirectory, 'screenshots'));
    assert.deepEqual(await readFile(saved_path), Buffer.from(result[1].data, 'base64'));
    paths.push(saved_path);
  }
  assert.equal(new Set(paths).size, 3);
  assert.equal((await readdir(join(f.tempDirectory, 'screenshots'))).length, 2);
  assert.equal(f.commands.filter(command => command.method === 'screenshot').length, 3);
});

for (const withoutTemp of [false, true]) test(`save failure preserves the image and reports no saved path (missing interface: ${withoutTemp})`, async t => {
  const f = await fixture(t, { results: { screenshot }, withoutTemp }); await f.set('background');
  if (!withoutTemp) { const { mkdir } = await import('node:fs/promises'); await mkdir(join(f.directory, 'tmp')); await writeFile(f.tempDirectory, 'blocking file'); }
  const result = await f.backend.tools.screenshot({ profile_id: f.profile.id, save: true }, f.ctx);
  assert.equal(JSON.stringify(result[1]), JSON.stringify(screenshot[1]));
  const metadata = JSON.parse(result[0].text);
  assert.equal(metadata.saved_path, undefined); assert.ok(metadata.save_error);
  if (withoutTemp) assert.match(metadata.save_error, /tempDirectory.*unavailable/);
});

for (const cancel of [false, true]) test(`incomplete PNGs are removed after ${cancel ? 'cancellation' : 'write failure'}`, async t => {
  const controller = new AbortController();
  const f = await fixture(t, { results: { screenshot }, files: { writeFile: async (path, data, options) => {
    if (!path.endsWith('.part')) return writeFile(path, data, options);
    await writeFile(path, data.subarray(0, 12));
    if (cancel) controller.abort(new Error('cancelled during save'));
    else throw new Error('disk full');
  } } });
  await f.set('background');
  const capture = f.backend.tools.screenshot({ profile_id: f.profile.id, save: true }, { ...f.ctx, signal: controller.signal });
  if (cancel) await assert.rejects(capture, /cancelled during save/);
  else {
    const result = await capture;
    assert.match(JSON.parse(result[0].text).save_error, /disk full/);
    assert.equal(JSON.parse(result[0].text).saved_path, undefined);
    assert.equal(JSON.stringify(result[1]), JSON.stringify(screenshot[1]));
  }
  assert.deepEqual(await readdir(join(f.tempDirectory, 'screenshots')), []);
});

test('foreground/background/closed share one connection; presentation never writes the profile', async t => {
  const f = await fixture(t), file = join(f.directory, 'profiles.json');
  const before = await readFile(file, 'utf8');
  const first = await f.set('background');
  assert.equal(first.state, 'background'); assert.equal(first.view, null);
  assert.equal(first.connection_state, 'connected'); assert.ok(first.session_id);
  const front = await f.set('foreground', { location: 'window' });
  assert.equal(front.session_id, first.session_id); assert.equal(front.view.location, 'window');
  assert.equal((await f.set('foreground')).view.location, 'window');
  await f.host.closeView({ instanceId: f.profile.id });
  assert.equal((await f.set('foreground')).view.location, 'sidebar', 'A newly opened desktop uses the saved preference.');
  const background = await f.set('background');
  assert.equal(background.session_id, first.session_id); assert.equal(background.view, null);
  assert.equal(f.helpers.length, 1); assert.equal(await readFile(file, 'utf8'), before);
  await f.set('foreground');
  const closed = await f.set('closed');
  assert.equal(closed.session_id, null); assert.equal(closed.view, null); assert.equal(closed.state, 'closed');
  assert.equal((await f.set('closed')).state, 'closed');
  assert.deepEqual(f.views.map(view => view.instanceId), ['main']);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('closed removes disconnected and orphan desktops; list exposes their actual view and saved status', async t => {
  const f = await fixture(t);
  await f.set('foreground');
  f.helpers[0].emit('close', 0);
  let rows = await f.backend.tools.list({}, f.ctx);
  assert.equal(rows[0].state, 'closed'); assert.ok(rows[0].view); assert.equal(rows[0].saved, true);
  const raw = JSON.parse(await readFile(join(f.directory, 'profiles.json'), 'utf8')); raw.profiles = [];
  await writeFile(join(f.directory, 'profiles.json'), JSON.stringify(raw));
  rows = await f.backend.tools.list({}, f.ctx);
  assert.equal(rows[0].saved, false); assert.equal(rows[0].profile.name, 'Test');
  await f.set('closed');
  assert.equal((await f.backend.tools.list({}, f.ctx)).length, 0);
  f.views.push({ panelId: 'orphan', instanceId: f.profile.id, location: 'window' });
  assert.equal((await f.backend.tools.list({}, f.ctx))[0].profile, null);
  await f.set('closed'); assert.equal(f.views.length, 1);
});

for (const location of ['sidebar', 'window']) test(`foreground reconnects an existing disconnected ${location} without duplicating it`, async t => {
  const f = await fixture(t);
  const first = await f.set('foreground', { location });
  f.helpers[0].emit('close', 0);
  const again = await f.set('foreground');
  assert.equal(again.connection_state, 'connected');
  assert.notEqual(again.session_id, first.session_id);
  assert.equal(again.view.location, location);
  assert.equal(f.views.filter(view => view.instanceId === f.profile.id).length, 1);
  assert.equal(f.helpers.length, 2);
});

test('state changes serialize, close callbacks stay reentrant, and failed closes preserve a retryable connection', async t => {
  const f = await fixture(t); await f.set('foreground');
  const close = f.host.closeView;
  f.host.closeView = async () => { throw new Error('Cannot close'); };
  await controlFailure(f.set('background'), /Cannot close/);
  assert.equal((await f.backend.tools.list({}, f.ctx))[0].connection_state, 'connected');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), closing = new Promise(resolve => { entered = resolve; });
  f.host.closeView = async options => { entered(); await gate; await close(options); };
  const background = controlFailure(f.set('background'), /RDP_OPERATION_SUPERSEDED/); await closing;
  const ended = f.set('closed');
  release(); await background;
  assert.equal((await ended).state, 'closed'); assert.equal(f.helpers.length, 1);
  await assert.rejects(f.set('foreground', {}, { ...f.ctx, signal: AbortSignal.abort(new Error('cancel')) }), /cancel/);
  assert.equal(f.helpers.length, 1);
  for (const args of [{ state: 'disconnected' }, { state: 'background', location: 'window' }, { state: 'foreground', location: 'elsewhere' }, { state: 'closed', profile_id: 'main' }]) {
    await assert.rejects(f.backend.tools.control({ profile_id: f.profile.id, ...args }, f.ctx));
  }
});

test('UI close and tool foreground share one ordered transition and leave no orphan view', async t => {
  const f = await fixture(t), open = f.host.openView;
  let release, entered;
  const opening = new Promise(resolve => { entered = resolve; });
  f.host.openView = async options => { entered(); await new Promise(resolve => { release = resolve; }); await open(options); };
  const front = controlFailure(f.set('foreground'), /RDP_OPERATION_SUPERSEDED/); await opening;
  const closed = f.call('server.close', { profile_id: f.profile.id });
  release(); await front; await closed;
  const result = await f.backend.tools.list({}, f.ctx);
  assert.equal(result[0].state, 'closed'); assert.equal(result[0].view, null);
});
test('UI open reads the latest profile; failed opening cancels the launch intent', async t => {
  const f = await fixture(t);
  const updated = await f.call('profiles.save', { ...f.profile, name: 'Updated', passwordAction: 'keep' });
  await f.call('server.open', { profile_id: updated.id, state:'foreground' });
  assert.equal(f.views.find(view => view.instanceId === updated.id).title, 'Updated');
  await f.call('server.close', { profile_id: updated.id });
  f.host.openView = async () => { throw new Error('open failed'); };
  await assert.rejects(f.call('server.open', {profile_id:updated.id,state:'foreground'}), /open failed/);
  assert.equal(await f.call('profiles.consumeLaunch', {id:updated.id}), null);
});
test('disposed pages cannot create a connection after a queued close', async t => {
  const f = await fixture(t); await f.set('foreground');
  const caller = { ...f.views.find(view => view.instanceId === f.profile.id) };
  const closed = f.call('server.close', { profile_id: f.profile.id });
  const creating = f.call('create', { ...f.profile, owner:f.profile.id, password:'' }, caller);
  await closed; await assert.rejects(creating, /RDP_PAGE_CLOSED/);
  assert.equal(f.helpers.length, 1);
});
test('all desktop tools resolve the stable profile to its replacement connection without reconnecting implicitly', async t => {
  const f = await fixture(t), profile_id = f.profile.id;
  await assert.rejects(f.backend.tools.screenshot({ profile_id }, f.ctx), /RDP_NOT_CONNECTED/);
  const first = await f.set('background');
  await f.backend.tools.control({ profile_id, ui_locked:true }, f.ctx);
  f.helpers[0].emit('close', 0);
  await assert.rejects(f.backend.tools.input({profile_id,actions:[{type:'press',key:'A'}]}, f.ctx), /RDP_NOT_CONNECTED/);
  const second = await f.set('background'); assert.notEqual(first.session_id, second.session_id);
  await f.backend.tools.screenshot({profile_id}, f.ctx);
  await f.backend.tools.input({profile_id,actions:[{type:'press',key:'A'}]}, f.ctx);
  assert.equal((await f.backend.tools.control({profile_id, reset_input: true}, f.ctx)).session_id, second.session_id);
  assert.equal((await f.backend.tools.control({profile_id,ui_locked:false}, f.ctx)).session_id, second.session_id);
  assert.ok(f.commands.slice(1).every(command => command.helper === 1));
});
test('an in-flight input remains pinned to its original connection when the same profile reconnects', async t => {
  const f = await fixture(t), profile_id = f.profile.id;
  await f.set('background'); f.helpers[0].holdInput = true;
  const input = f.backend.tools.input({profile_id, actions:[{type:'press',key:'A'},{type:'press',key:'B'}]}, f.ctx);
  const rejected = assert.rejects(input, /RDP_SESSION_CLOSED/);
  f.helpers[0].emit('close', 0); await rejected; await f.set('background');
  assert.equal(f.commands.length, 1); assert.equal(f.commands[0].helper, 0);
});

test('explicit close interrupts authentication instead of waiting for the connection timeout', async t => {
  const f = await fixture(t, { connected:false });
  const connecting = controlFailure(f.set('foreground'), /RDP_OPERATION_SUPERSEDED/);
  while (!f.helpers.length) await new Promise(resolve => setImmediate(resolve));
  await f.call('server.close', {profile_id:f.profile.id}); await connecting;
  assert.equal((await f.backend.tools.list({}, f.ctx))[0].session_id, null);
  assert.equal(f.views.length, 1);
});

test('an earlier page disposal cannot discard the launch requested by reopening', async t => {
  const f = await fixture(t), open = f.host.openView;
  const old = {panelId:'old',instanceId:f.profile.id,location:'sidebar'};
  f.views.push(old);
  f.host.openView = async options => {
    await f.call('connection.close', {owner:options.instanceId}, old);
    f.views.splice(f.views.indexOf(old), 1);
    await open(options);
  };
  await f.call('server.open', {profile_id:f.profile.id,state:'foreground'});
  assert.equal((await f.call('profiles.consumeLaunch', {id:f.profile.id})).id, f.profile.id);
});

test('control validates the whole request before connecting or dispatching input', async t => {
  const f = await fixture(t), profile_id = f.profile.id;
  for (const args of [{}, { state: null }, { state: ['foreground'] }, { location: 'window' }, { state: 'background', location: 'window' },
    { state: 'foreground', ui_locked: null }, { state: 'foreground', reset_input: false }, { state: 'foreground', extra: true },
    { state: 'closed', ui_locked: false }, { state: 'closed', reset_input: true },
    { state: 'foreground', reset_keyboard: true }]) {
    await assert.rejects(f.backend.tools.control({ profile_id, ...args }, f.ctx));
  }
  for (const args of [{ ui_locked: false }, { reset_input: true }]) {
    await assert.rejects(f.backend.tools.control({ profile_id, ...args }, f.ctx), /RDP_NOT_CONNECTED/);
  }
  assert.equal(f.helpers.length, 0); assert.equal(f.commands.length, 0); assert.equal(f.views.length, 1);
});

test('combined control connects, locks and resets before presenting, preserving unspecified state', async t => {
  const f = await fixture(t), profile_id = f.profile.id, open = f.host.openView;
  f.host.openView = async options => {
    assert.deepEqual(f.commands.map(command => command.method), ['setUiLocked', 'resetInput']);
    assert.equal((await f.backend.tools.list({}, f.ctx))[0].ui_locked, true);
    await open(options);
  };
  const result = await f.set('foreground', { location: 'window', ui_locked: true, reset_input: true });
  assert.equal(result.ok, true); assert.equal(result.ui_locked, true); assert.equal(result.view.location, 'window');
  assert.equal(result.applied.reset_input.accepted, true); assert.equal(result.applied.reset_input.toggle_flags, 0);
  const unlocked = await f.backend.tools.control({ profile_id, ui_locked: false }, f.ctx);
  assert.equal(unlocked.ok, true); assert.equal(unlocked.ui_locked, false); assert.equal(unlocked.view.location, 'window');
  assert.equal(unlocked.session_id, result.session_id); assert.equal(f.helpers.length, 1);
  assert.equal(f.commands.filter(command => command.method === 'resetInput').length, 1);
  const rows = await f.backend.tools.list({}, f.ctx);
  assert.equal(rows[0].profile.profile_id, profile_id); assert.equal(rows[0].profile.open_mode, 'sidebar');
  assert.equal(rows[0].profile.has_password, true); assert.equal(rows[0].profile.revision, f.profile.revision);
});

test('failed presentation reports the connection and completed lock/reset without undoing them', async t => {
  const f = await fixture(t);
  f.host.openView = async () => { throw new Error('Open failed'); };
  const failed = await controlFailure(f.set('foreground', { ui_locked: true, reset_input: true }), /Open failed/);
  assert.equal(failed.failed_step, 'presentation'); assert.equal(failed.state, 'background');
  assert.equal(failed.connection_state, 'connected'); assert.equal(failed.ui_locked, true);
  assert.equal(failed.applied.ui_locked, true); assert.equal(failed.applied.reset_input.accepted, true);
  assert.equal(failed.view, null); assert.ok(failed.session_id);
  assert.equal(f.helpers.length, 1); assert.equal(f.commands.length, 2);
});

test('a standalone queued control never resets a replacement connection', async t => {
  const f = await fixture(t); await f.set('background');
  let release, entered;
  const enteredView = new Promise(resolve => { entered = resolve; });
  f.host.openView = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const showing = f.set('foreground'); await enteredView;
  const reconnect = f.set('background');
  const reset = f.backend.tools.control({ profile_id: f.profile.id, reset_input: true }, f.ctx);
  f.helpers[0].emit('close', 0); release();
  assert.equal((await showing).ok, false); assert.equal((await reconnect).ok, true);
  assert.equal((await reset).ok, false); assert.equal(f.helpers.length, 2); assert.equal(f.commands.length, 0);
});

test('profile actions reject unrelated fields and preserve configuration on invalid requests', async t => {
  const f = await fixture(t), profile_id = f.profile.id, revision = f.profile.revision;
  const before = await readFile(join(f.directory, 'profiles.json'), 'utf8');
  for (const args of [{}, { action: 'unknown' }, { action: 'get', profile_id, changes: {} }, { action: 'get', profile_id, revision },
    { action: 'add', profile_id, changes: { host: 'new.invalid' } }, { action: 'add', changes: { name: 'Missing host' } },
    { action: 'update', profile_id, changes: { name: 'Missing revision' } }, { action: 'delete', profile_id, revision, changes: {} },
    { action: 'delete', profile_id, revision: 0 }]) {
    await assert.rejects(f.backend.tools.profile(args, f.ctx));
  }
  assert.equal(await readFile(join(f.directory, 'profiles.json'), 'utf8'), before);
  const profile = await f.backend.tools.profile({ action: 'get', profile_id }, f.ctx);
  assert.equal(profile.profile_id, profile_id); assert.equal(profile.revision, revision);
  assert.equal(profile.has_password, true); assert.equal(profile.open_mode, 'sidebar');
});

test('a failed reset retains the completed lock and skips presentation', async t => {
  const f = await fixture(t, { failMethod: 'resetInput' });
  const failed = await controlFailure(f.set('foreground', { ui_locked: true, reset_input: true }), /Synthetic command failure/);
  assert.equal(failed.failed_step, 'reset_input'); assert.equal(failed.ui_locked, true);
  assert.equal(failed.applied.ui_locked, true); assert.equal(failed.applied.reset_input, undefined);
  assert.equal(failed.view, null); assert.equal(failed.connection_state, 'connected');
  assert.equal(f.helpers.length, 1);
});

test('a failed status read reports completed effects without inventing a snapshot', async t => {
  const f = await fixture(t), getViews = f.host.getViews;
  f.host.getViews = async () => { if (f.commands.length) throw new Error('Views unavailable'); return getViews(); };
  const result = await f.set('background', { ui_locked: true });
  assert.equal(result.ok, false); assert.equal(result.failed_step, 'status');
  assert.match(result.status_error, /Views unavailable/); assert.equal(result.applied.ui_locked, true);
  assert.equal(result.connection_state, undefined); assert.equal(result.view, undefined);
});

test('an open disconnected desktop blocks profile deletion but can save its connection password', async t => {
  const f = await fixture(t), profile_id = f.profile.id;
  f.views.push({ panelId: 'password-page', instanceId: profile_id, location: 'sidebar' });
  await assert.rejects(f.backend.tools.profile({ action: 'delete', profile_id, revision: f.profile.revision }, f.ctx), /RDP_PROFILE_OPEN/);
  const updated = await f.call('profiles.savePassword', { id: profile_id, revision: f.profile.revision, password: 'new-synthetic' });
  assert.equal(updated.hasPassword, true);
});
