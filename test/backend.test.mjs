import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { test, after, beforeEach } from 'node:test';
import { createServer, connect } from 'node:net';
import { fork } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const packageDirectory = resolve(process.env.RDP_TEST_PACKAGE ?? 'dist');
const plugin = require(join(packageDirectory, 'backend.cjs'));
const backend = { ...plugin, call: (method, params, context = { caller: null, views: [] }) => plugin.call(method, params, { ...context, host: { ...host, getViews: async () => context.views } }) };
const dataDirectory = await mkdtemp(join(tmpdir(), 'rdp-backend-'));
let toolViews = [];
const host = { onViewsChanged: () => () => {}, getViews: async () => toolViews,
  openView: async options => { if (!toolViews.some(view => view.instanceId === options.instanceId)) toolViews.push({ panelId: options.instanceId, ...options }); },
  moveView: async options => { toolViews.find(view => view.instanceId === options.instanceId).location = options.location; },
  closeView: async ({ instanceId }) => { const view = toolViews.find(view => view.instanceId === instanceId); if (view) await backend.call('connection.close', { owner: instanceId }, { caller: view, views: toolViews }); toolViews = toolViews.filter(view => view.instanceId !== instanceId); }
};
const toolContext = (signal = new AbortController().signal) => ({ host, signal, deadline: Date.now() + 45000 });
async function controlFailure(pending, pattern) {
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, pattern);
  return result;
}
beforeEach(() => backend.activate({ pluginId: 'rdp', packageDirectory, dataDirectory, tempDirectory: join(dataDirectory, 'tmp', 'anas-plugin-rdp'), host }));
after(async () => { await backend.deactivate(); await rm(dataDirectory, { recursive: true, force: true }); });

test('UI and tool connections pass fixed dimensions to the native process and reject invalid sizes before spawning', async t => {
  const source = await readFile(join(packageDirectory, 'backend.cjs'), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'rdp-resolution-'));
  const configurations = [];
  let spawned = 0;
  const spawn = () => {
    spawned++;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      configurations.push(JSON.parse(chunk.toString()));
      child.stdout.write(JSON.stringify({ status: 'ready', port: 1234 }) + '\n');
      child.stdout.write(JSON.stringify({ status: 'connected' }) + '\n');
      callback();
    }});
    child.stdin.on('finish', () => child.emit('close', 0));
    child.kill = () => child.emit('close', 0);
    return child;
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn } : require(name) });
  const isolated = module.exports, host = { onViewsChanged: () => () => {}, getViews: async () => [], openView: async () => {}, moveView: async () => {}, closeView: async () => {} };
  const caller = { caller: null, views: [] }, ctx = { host, signal: new AbortController().signal, deadline: Date.now() + 45000 };
  isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, tempDirectory: join(directory, 'tmp', 'anas-plugin-rdp'), host });
  t.after(async () => { await isolated.deactivate(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(isolated.call('create', { owner: 'invalid', host: 'test.invalid', username: '', password: '', desktopWidth: 8192, desktopHeight: 8192 }, caller), /RDP_INVALID_RESOLUTION/);
  await assert.rejects(isolated.call('create', { owner: 'invalid', host: 'test.invalid', username: '', password: '', disableMouseAnimation: null }, caller), /Invalid mouse animation setting/);
  assert.equal(spawned, 0);
  await isolated.call('create', { owner: 'ui', host: 'test.invalid', username: '', password: '', disableMouseAnimation: true, desktopWidth: 1024, desktopHeight: 768 }, caller);
  await isolated.call('create', { owner: 'default', host: 'test.invalid', username: '', password: '' }, caller);
  const profile = await isolated.call('profiles.save', { name: 'Tool', host: 'test.invalid', username: '', passwordAction: 'set', password: '', disableMouseAnimation: true, adaptiveWindow: true, adaptiveSidebar: false, desktopWidth: 1920, desktopHeight: 1080 }, caller);
  await isolated.tools.control({ profile_id: profile.id, state: 'background' }, ctx);
  assert.deepEqual(configurations.map(config => [config.desktop_width, config.desktop_height]), [[1024,768],[1280,800],[1920,1080]]);
  const sessions = await isolated.tools.list({}, ctx);
  assert.equal(sessions.find(session => session.profile.profile_id === profile.id).profile.desktop_width, 1920);
  assert.equal(sessions.find(session => session.profile.profile_id === profile.id).profile.adaptive_window, true);
  assert.equal(sessions.find(session => session.profile.profile_id === profile.id).profile.adaptive_sidebar, false);
  assert.equal(sessions.find(session => session.profile.profile_id === profile.id).profile.disable_mouse_animation, true);
  assert.equal(sessions.find(session => session.profile.profile_id === 'ui').profile.disable_mouse_animation, true);
  assert.equal(sessions.find(session => session.profile.profile_id === 'default').profile.disable_mouse_animation, false);
  assert.ok(configurations.every(config => !Object.hasOwn(config, 'disable_mouse_animation')), 'Visual preference is not a remote connection setting');
  assert.equal(spawned, 3);
});

test('each connection keeps its clipboard switch while activity serially transfers publication', async t => {
  const source = await readFile(join(packageDirectory, 'backend.cjs'), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'rdp-clipboard-'));
  const helpers = [], commands = [];
  let onViews, views = [];
  const clipboardHost = { getViews: async () => views, onViewsChanged: listener => { onViews = listener; return () => { onViews = undefined; }; } };
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.busy = false;
    const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const value = JSON.parse(chunk.toString());
      if (value.method) {
        commands.push({ helper: helpers.indexOf(child), ...value });
        if (value.method === 'setClipboardEnabled' && child.busy && !value.enabled) emit({ request: value.request, error: 'RDP_CLIPBOARD_BUSY' });
        else emit({ request: value.request, result: { enabled: value.enabled, active: value.active, revision: commands.length } });
      } else { child.config = value; emit({ status: 'ready', port: 1234 }); emit({ status: 'connected' }); }
      callback();
    }});
    child.stdin.on('finish', () => child.emit('close', 0));
    child.kill = () => { throw new Error('Activity must not kill a helper'); };
    helpers.push(child); return child;
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn } : require(name) });
  const isolated = module.exports, caller = { caller: null, views: [] };
  await isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, tempDirectory: join(directory, 'tmp', 'anas-plugin-rdp'), host: clipboardHost });
  t.after(async () => { await isolated.deactivate(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(isolated.call('create', { owner: 'invalid', host: 'test.invalid', username: '', password: '', clipboardSupport: null }, caller), /Invalid clipboard setting/);
  assert.equal(helpers.length, 0);
  const create = async owner => ({ ...await isolated.call('create', { owner, host: 'test.invalid', username: '', password: '', clipboardSupport: true }, caller), owner });
  const first = await create('first'), second = await create('second');
  const toggle = (session, enabled) => isolated.call('setClipboardEnabled', { ...session, enabled }, caller);
  const activity = async owner => {
    views = [first, second].map(session => ({ panelId: session.owner, instanceId: session.owner, location: 'window', activity: { visible: true, active: session.owner === owner } }));
    onViews(views);
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  await toggle(first, true); await toggle(second, true);
  await activity('first'); helpers[0].busy = true;
  await activity('second');
  const changes = commands.filter(command => command.method === 'setClipboardActivity');
  assert.deepEqual(changes.map(({ helper, active, publish }) => [helper, active, publish]), [[0,true,true],[0,false,false],[1,true,true]]);
  assert.equal((await isolated.call('status', first, caller)).clipboardEnabled, true);
  assert.equal((await isolated.call('status', second, caller)).clipboardEnabled, true);
  await assert.rejects(toggle(first, false), /RDP_CLIPBOARD_BUSY/);
  await activity(null);
  assert.deepEqual(commands.at(-1).active, false);
  assert.equal(commands.at(-1).publish, true, 'An already requested copy may finish after returning to a local window');
  helpers[0].busy = false;
  await toggle(first, false);
  assert.equal((await isolated.call('status', second, caller)).clipboardEnabled, true);
  // Only the final target can acquire new synchronization after a burst of focus changes.
  onViews([{ panelId: 'first', instanceId: 'first', activity: { active: true } }]);
  onViews([{ panelId: 'second', instanceId: 'second', activity: { active: true } }]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(commands.at(-1).helper, 1);
  assert.equal(commands.at(-1).active, true);
  helpers[1].stdout.write(JSON.stringify({ clipboardState: 'syncing' }) + '\n');
  helpers[1].emit('close', 0);
  const ended = await isolated.call('status', second, caller);
  assert.equal(ended.clipboardEnabled, false);
  assert.equal(ended.clipboardState, 'disabled');
  const listed = await isolated.tools.list({}, { host: clipboardHost, signal: new AbortController().signal });
  assert.equal(listed.find(session => session.session_id === second.id).clipboard_state, 'disabled');
  const unsupported = { ...await isolated.call('create', { owner: 'off', host: 'test.invalid', username: '', password: '' }, caller), owner: 'off' };
  assert.equal(helpers[2].config.clipboard_support, false);
  await assert.rejects(toggle(unsupported, true), /RDP_CLIPBOARD_UNAVAILABLE/);
});

test('native input waits for its real receipt beyond five seconds and propagates the original deadline', async t => {
  const source = await readFile(join(packageDirectory, 'backend.cjs'), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'rdp-delayed-receipt-'));
  const child = new EventEmitter(), commands = [];
  const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const value = JSON.parse(chunk.toString());
    if (value.method) commands.push(value);
    else { emit({ status: 'ready', port: 1234 }); emit({ status: 'connected' }); }
    callback();
  }});
  child.stdin.on('finish', () => child.emit('close', 0));
  child.kill = () => { throw new Error('A request must not kill the helper'); };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn: () => child } : require(name) });
  const isolated = module.exports;
  isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, tempDirectory: join(directory, 'tmp', 'anas-plugin-rdp'), host });
  t.after(async () => { await isolated.deactivate(); t.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); });
  const session = await isolated.call('create', { owner: 'test', host: 'test.invalid', username: 'test', password: '' }, { caller: null, views: [] });
  const controller = new AbortController(), deadline = Date.now() + 300000;
  let settled = false;
  const pending = isolated.tools.input({ profile_id: 'test', actions: [{ type: 'text', text: 'Delayed text' }] }, { signal: controller.signal, deadline });
  void pending.then(() => { settled = true });
  const request = commands.at(-1);
  assert.equal(request.deadline_ms, deadline);
  t.mock.timers.tick(31000);
  controller.abort(new Error('Conversation ended'));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal((await isolated.tools.list({}, { host, signal: new AbortController().signal }))[0].connection_state, 'connected');
  emit({ request: request.request, result: { accepted: true } });
  assert.equal((await pending).accepted, true);
  await assert.rejects(isolated.tools.input({ profile_id: 'test', actions: [{ type: 'press', key: 'A' }] }, {
    signal: new AbortController().signal, deadline: Date.now() - 1
  }), /RDP_INPUT_TIMEOUT/);
  assert.equal(commands.length, 1, 'Expired work is rejected before dispatch.');
});

for (const ready of [false, true]) test(`explicit stop closes helpers during ${ready ? 'input' : 'startup'} without waiting for receipts first`, async t => {
  const source = await readFile(join(packageDirectory, 'backend.cjs'), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'rdp-stop-receipt-'));
  const child = new EventEmitter();
  let spawned = 0;
  const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const value = JSON.parse(chunk.toString());
    if (!value.method && ready) { emit({ status: 'ready', port: 1234 }); emit({ status: 'connected' }); }
    callback();
  }});
  child.stdin.on('finish', () => child.emit('close', 0));
  child.kill = () => { throw new Error('Cooperative stop must not kill the helper'); };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn: () => { spawned++; return child; } } : require(name) });
  const isolated = module.exports;
  isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, tempDirectory: join(directory, 'tmp', 'anas-plugin-rdp'), host });
  t.after(async () => { await isolated.deactivate(); await rm(directory, { recursive: true, force: true }); });
  const create = () => isolated.call('create', { owner: 'test', host: 'test.invalid', username: 'test', password: '' }, { caller: null, views: [] });
  let pending = create();
  if (ready) {
    const session = await pending;
    pending = isolated.tools.input({ profile_id: 'test', actions: [{ type: 'text', text: 'Pending input' }] }, {
      signal: new AbortController().signal, deadline: Date.now() + 300000
    });
  }
  const receipt = assert.rejects(pending, ready ? /RDP_SESSION_CLOSED/ : /closed before becoming ready/);
  // Allow creation to reach the helper, but never emit its outstanding receipt.
  await new Promise(resolve => setImmediate(resolve));
  const queued = create();
  const rejected = assert.rejects(queued, /RDP_BACKEND_STOPPING/);
  await isolated.deactivate();
  await Promise.all([receipt, rejected]);
  assert.equal(spawned, 1, 'Queued resource creation must not start during cleanup.');
});

test('server state uses saved credentials and reconciles closed editors with current host views', async () => {
  const profile = await backend.call('profiles.save', { name: 'Connect fixture', host: 'test.invalid', username: 'fixture', passwordAction: 'remove' });
  const args = { profile_id: profile.id, state: 'background' }, context = toolContext();
  await controlFailure(backend.tools.control(args, context), /RDP_PASSWORD_REQUIRED/);
  toolViews = [{ panelId: 'home', instanceId: 'main', location: 'sidebar' }];
  await backend.call('profiles.beginEdit', profile, { caller: toolViews[0], views: toolViews });
  await controlFailure(backend.tools.control(args, context), /RDP_PROFILE_EDITING/);
  toolViews = [];
  await controlFailure(backend.tools.control(args, context), /RDP_PASSWORD_REQUIRED/);
  assert.equal((await backend.tools.list({}, context)).find(server => server.profile_id === profile.id).session_id, null);
  await backend.call('profiles.delete', profile);
});

test('cancelling queued or unfinished state changes cleans up only their new connection and leaves reused connections intact', async t => {
  const peers = new Set();
  const server = createServer(socket => { peers.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await backend.deactivate(); for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  {
    const profile = await backend.call('profiles.save', { name: 'Cancel fixture', host: '127.0.0.1', port: server.address().port,
      username: 'fixture', password: 'synthetic', passwordAction: 'set' });
    const args = { profile_id: profile.id, state: 'background' };
    const controller = new AbortController(), context = toolContext(controller.signal);
    const connecting = backend.tools.control(args, context);
    const rejected = controlFailure(connecting, /Cancelled connect/);
    const deadline = Date.now() + 4000;
    while (!(await backend.tools.list({}, toolContext())).some(session => session.profile_id === profile.id && session.session_id)) {
      if (Date.now() > deadline) throw new Error('Helper was not created');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort(new Error('Cancelled connect'));
    await rejected;
    assert.equal(await backend.call('find', { owner: profile.id }), null);
    const first = new AbortController(), second = new AbortController();
    const firstResult = assert.rejects(backend.tools.control(args, toolContext(first.signal)), /First cancelled/);
    const secondResult = assert.rejects(backend.tools.control(args, toolContext(second.signal)), /Second cancelled/);
    second.abort(new Error('Second cancelled'));
    first.abort(new Error('First cancelled'));
    await Promise.all([firstResult, secondResult]);
    assert.equal(await backend.call('find', { owner: profile.id }), null);
    await controlFailure(backend.tools.control(args, { ...toolContext(), deadline: Date.now() }), /RDP_CONNECT_TIMEOUT/);
    assert.equal(await backend.call('find', { owner: profile.id }), null, 'An expired new attempt must reclaim its unfinished connection.');
    const userSession = await backend.call('create', { ...profile, owner: profile.id, password: 'synthetic' });
    const borrowed = new AbortController(), borrowedContext = toolContext(borrowed.signal);
    const borrowing = backend.tools.control(args, borrowedContext);
    const borrowRejected = controlFailure(borrowing, /Cancelled borrow/);
    await new Promise(resolve => setTimeout(resolve, 50));
    borrowed.abort(new Error('Cancelled borrow'));
    await borrowRejected;
    assert.equal((await backend.call('find', { owner: profile.id })).id, userSession.id);
    await backend.call('disconnect', { owner: profile.id, id: userSession.id });
    await backend.call('profiles.delete', profile);
  }
});

test('model tools use existing resources without page identities, expose no credentials, and honor cancellation', async t => {
  const peers = new Set();
  const server = createServer(socket => { peers.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await backend.deactivate(); for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const toolContext = { host, signal: new AbortController().signal, deadline: Date.now() + 300000 };
  const profile = await backend.call('profiles.save', { name: 'Tools fixture', host: '127.0.0.1', port: server.address().port,
    username: 'fixture', password: 'synthetic-secret', passwordAction: 'set' });
  const saved = (await backend.tools.list({}, toolContext)).find(item => item.profile_id === profile.id).profile;
  assert.equal(saved.has_password, true);
  assert.equal(JSON.stringify(saved).includes('synthetic-secret'), false);
  const session = await backend.call('create', { ...profile, owner: profile.id, password: 'synthetic-secret' });
  const listed = (await backend.tools.list({}, toolContext)).find(item => item.session_id === session.id);
  assert.equal(listed.profile.profile_id, profile.id);
  assert.equal(listed.certificate, null);
  assert.equal(listed.ui_locked, false);
  await assert.rejects(backend.tools.control({ profile_id: profile.id, ui_locked: 'false' }, toolContext), /RDP_INVALID_LOCK/);
  await assert.rejects(backend.tools.control({ profile_id: profile.id, ui_locked: true }, toolContext), /RDP_NOT_CONNECTED/);
  await assert.rejects(backend.tools.control({ profile_id: 'missing', ui_locked: true }, toolContext), /RDP_NOT_CONNECTED/);
  await assert.rejects(backend.tools.control({ profile_id: profile.id, ui_locked: true }, { signal: AbortSignal.abort(new Error('cancel-lock')) }), /cancel-lock/);
  await assert.rejects(backend.call('setUiLocked', { owner: 'wrong', id: session.id, locked: true }), /does not belong/);
  for (const value of ['synthetic-secret', session.token, session.url]) assert.equal(JSON.stringify(listed).includes(value), false);
  for (const text of ['', null, 42, '\ud800', '\udfff', 'A'.repeat(4097), '中'.repeat(4096), '\0'.repeat(2000)]) {
    await assert.rejects(backend.tools.input({profile_id: profile.id,actions:[{type:'text',text}]},toolContext), /RDP_INVALID_INPUT/);
  }
  await assert.rejects(backend.tools.input({profile_id: profile.id,actions:Array.from({length:3},()=>({type:'text',text:'A'.repeat(4000)}))},toolContext), /RDP_INVALID_INPUT/);
  await assert.rejects(backend.tools.input({profile_id: profile.id,actions:[{type:'text',text:'你好，Anas 🐟\r\n'}]},toolContext), /RDP_NOT_CONNECTED/);
  await assert.rejects(backend.tools.screenshot({ profile_id: profile.id }, toolContext), /RDP_NOT_CONNECTED/);
  await assert.rejects(backend.tools.screenshot({ profile_id: profile.id, include_cursor: 'false' }, toolContext), /Invalid cursor/);
  const aborted = { signal: AbortSignal.abort(new Error('Test cancellation')) };
  await assert.rejects(backend.tools.screenshot({ profile_id: profile.id }, aborted), /Test cancellation/);
  await assert.rejects(backend.tools.control({ profile_id: profile.id, state: 'closed' }, aborted), /Test cancellation/);
  assert.equal((await backend.call('find', { owner: profile.id })).id, session.id);
  await assert.rejects(backend.tools.screenshot({ profile_id: profile.id }, toolContext), /RDP_NOT_CONNECTED/);
  await backend.tools.control({ profile_id: profile.id, state: 'closed' }, toolContext);
  await backend.tools.control({ profile_id: profile.id, state: 'closed' }, toolContext);
  assert.equal(await backend.call('find', { owner: profile.id }), null);
  await assert.rejects(backend.tools.screenshot({ profile_id: profile.id }, toolContext), /RDP_NOT_CONNECTED/);
  await backend.call('profiles.delete', profile);
});

test('page ownership and disconnect reclaim the listener', async () => {
  const session = await backend.call('create', { owner: 'first-page', host: 'test.invalid', port: 3389, username: 'test', password: 'test' });
  assert.ok(['ready', 'connection_failed'].includes((await backend.call('status', { owner: 'first-page', id: session.id })).state));
  await assert.rejects(backend.call('disconnect', { owner: 'second-page', id: session.id }), /does not belong/);
  await backend.call('disconnect', { owner: 'first-page', id: session.id });
  await backend.call('disconnect', { owner: 'first-page', id: session.id });
  await assert.rejects(backend.call('status', { owner: 'first-page', id: session.id }), /RDP_SESSION_CLOSED/);
  const port = Number(new URL(session.url).port);
  await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); reject(new Error('Listener remained open')); });
    socket.on('error', resolve);
  });
});

test('invalid targets are rejected before creating a helper', async () => {
  for (const params of [{ host: '', port: 3389 }, { host: 'test.invalid', port: 0 }, { host: 'test.invalid', trustedSha256: '' }]) {
    await assert.rejects(backend.call('create', { owner: 'page', ...params }), /Invalid/);
  }
});

test('forced backend process termination reclaims its native helper', { timeout: 10000 }, async () => {
  const parent = fork(resolve('test/fixtures/backend-owner.cjs'), [packageDirectory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  let helperPid;
  try {
    helperPid = await new Promise((resolve, reject) => {
      parent.on('message', message => { if (message.ready) resolve(message.pid); });
      parent.on('error', reject);
      parent.on('exit', () => reject(new Error('Fixture failed before ready')));
    });
    const exited = once(parent, 'exit');
    parent.kill();
    await exited;
    const deadline = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(helperPid, 0); } catch { alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, 'Native helper survived its owner');
  } finally {
    parent.kill();
    if (helperPid) { try { process.kill(helperPid); } catch {} }
  }
});


test('active resources are listed without credentials and block concurrent edits/deletion until disconnected', async t => {
  const peers = new Set();
  const server = createServer(socket => { peers.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await backend.deactivate(); for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const profile = await backend.call('profiles.save', { name: 'Background fixture', host: '127.0.0.1', port: server.address().port, username: 'fixture', passwordAction: 'remove' });
  const creating = backend.call('create', { ...profile, owner: profile.id, password: 'synthetic-secret' });
  const rejected = Promise.all([
    assert.rejects(backend.call('profiles.save', { ...profile, name: 'Wrong', passwordAction: 'keep' }), /RDP_PROFILE_ACTIVE/),
    assert.rejects(backend.call('profiles.savePassword', { ...profile, password: 'wrong' }), /RDP_PROFILE_ACTIVE/),
    assert.rejects(backend.call('profiles.delete', profile), /RDP_PROFILE_ACTIVE/),
  ]);
  const session = await creating;
  await rejected;
  const { sessions: summaries } = await backend.call('runtime.state', {});
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, session.id);
  assert.equal(summaries[0].profile.id, profile.id);
  assert.equal(summaries[0].profile.name, profile.name);
  assert.equal(JSON.stringify(summaries).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(summaries).includes(session.token), false);
  assert.equal(JSON.stringify(summaries).includes(session.url), false);
  assert.equal((await backend.call('profiles.get', profile)).name, profile.name);
  assert.equal((await backend.call('find', { owner: profile.id })).id, session.id);
  await backend.call('disconnect', { owner: profile.id, id: session.id });
  assert.deepEqual((await backend.call('runtime.state', {})).sessions, []);
  const saved = await backend.call('profiles.save', { ...profile, name: 'Stopped', passwordAction: 'keep' });
  await backend.call('profiles.delete', saved);
  assert.deepEqual(await backend.call('profiles.list', {}), []);
});

test('connection pages and edits exclude each other across moves, pending opens, close and failed opens', async () => {
  const profile = await backend.call('profiles.save', { name: 'Mutual fixture', host: 'test.invalid', username: 'fixture', passwordAction: 'remove' });
  const home = { panelId: 'home', instanceId: 'main', location: 'sidebar' };
  const window = { panelId: 'connection', instanceId: profile.id, location: 'window' };
  const editor = { caller: home, views: [home] };
  const open = { caller: home, views: [home, window] };
  await assert.rejects(backend.call('profiles.beginEdit', profile, open), /RDP_PROFILE_OPEN/);
  await assert.rejects(backend.call('profiles.save', { ...profile, passwordAction: 'keep' }, open), /RDP_PROFILE_OPEN/);
  await backend.call('profiles.beginEdit', profile, editor);
  assert.deepEqual((await backend.call('runtime.state', {}, editor)).editingProfiles, [profile.id]);
  await assert.rejects(backend.call('profiles.launch', profile, editor), /RDP_PROFILE_EDITING/);
  await assert.rejects(backend.call('connection.open', { owner: profile.id }, { caller: window, views: [home, window] }), /RDP_PROFILE_EDITING/);
  await assert.rejects(backend.call('create', { owner: profile.id }, editor), /RDP_PROFILE_EDITING/);
  // Moving the home preserves its stable identity and lock.
  const moved = { caller: { ...home, location: 'window' }, views: [{ ...home, location: 'window' }] };
  await backend.call('profiles.beginEdit', profile, moved);
  assert.deepEqual((await backend.call('runtime.state', {}, moved)).editingProfiles, [profile.id]);
  await backend.call('profiles.endEdit', profile, moved);
  const token = await backend.call('profiles.launch', profile, editor);
  await assert.rejects(backend.call('profiles.beginEdit', profile, editor), /RDP_PROFILE_OPEN/);
  await backend.call('profiles.cancelLaunch', { id: profile.id, token: 'stale' }, editor);
  await assert.rejects(backend.call('profiles.beginEdit', profile, editor), /RDP_PROFILE_OPEN/);
  await backend.call('profiles.cancelLaunch', { id: profile.id, token }, editor);
  await backend.call('profiles.beginEdit', profile, editor);
  // Closing the owning home releases the lock even without a disposal callback.
  const closed = { caller: window, views: [window] };
  await backend.call('connection.open', { owner: profile.id }, closed);
  assert.deepEqual((await backend.call('runtime.state', {}, closed)).editingProfiles, []);
  await backend.call('profiles.delete', profile);
});

test('desktop placement uses the saved profile as its single preference source, with an orphan recovery snapshot', async t => {
  const peers = new Set();
  const server = createServer(socket => { peers.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await backend.deactivate(); for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const profile = await backend.call('profiles.save', { name: 'Placement fixture', host: '127.0.0.1', port: server.address().port, username: 'fixture', passwordAction: 'remove' });
  const resource = await backend.call('create', { ...profile, owner: profile.id, password: 'synthetic' });
  const context = { caller: { panelId: 'desktop', instanceId: profile.id }, views: [{ panelId: 'desktop', instanceId: profile.id, location: 'window' }] };
  const summary = async () => (await backend.call('runtime.state', {}, context)).sessions.find(item => item.id === resource.id);
  assert.equal((await summary()).profile.openMode, 'sidebar', 'Actual desktop placement does not change its configured opening preference.');
  assert.deepEqual(await backend.call('profiles.get', { id: profile.id }), profile);
  assert.equal((await backend.call('find', { owner: profile.id })).id, resource.id);
  const file = join(dataDirectory, 'profiles.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.profiles.find(item => item.id === profile.id).open_mode = 'window';
  await writeFile(file, JSON.stringify(state));
  assert.equal((await summary()).profile.openMode, 'window', 'The saved preference overrides the older session snapshot.');
  state.profiles = state.profiles.filter(item => item.id !== profile.id);
  await writeFile(file, JSON.stringify(state));
  assert.equal((await summary()).profile.openMode, 'sidebar');
  assert.equal((await backend.call('profiles.list', {})).some(item => item.id === profile.id), false);
});


test('desktop close preserves resources and cancels queued launch intents; explicit disconnect ends them', async t => {
  const peers = new Set();
  const server = createServer(socket => { peers.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await backend.deactivate(); for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const settings = { host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'synthetic' };
  const ownPage = owner => ({ caller: { panelId: owner, instanceId: owner }, views: [{ panelId: owner, instanceId: owner, location: 'window' }] });
  const foreground = await backend.call('profiles.save', { ...settings, name: 'Foreground', passwordAction: 'remove' });
  await backend.call('profiles.launch', foreground);
  const creating = backend.call('create', { ...settings, owner: foreground.id });
  const closing = backend.call('connection.close', { owner: foreground.id }, ownPage(foreground.id));
  const resource = await creating;
  await closing;
  assert.equal((await backend.call('find', { owner: foreground.id })).id, resource.id);
  await backend.call('server.close', { profile_id: foreground.id });
  assert.equal(await backend.call('find', { owner: foreground.id }), null);
  assert.equal(await backend.call('profiles.consumeLaunch', { id: foreground.id }), null);
  await backend.call('connection.close', { owner: foreground.id }, ownPage(foreground.id));
  const background = await backend.call('create', { ...settings, owner: 'background' });
  await assert.rejects(backend.call('connection.close', { owner: 'background' }, ownPage('another')), /RDP_PAGE_OWNER/);
  await backend.call('connection.close', { owner: 'background' }, ownPage('background'));
  assert.equal((await backend.call('find', { owner: 'background' })).id, background.id);
  await backend.call('disconnect', { owner: 'background', id: background.id });
  assert.equal(await backend.call('find', { owner: 'background' }), null);
});


test('profile tools share UI storage, preserve credentials and omitted fields, and reject stale/invalid writes', async () => {
  const ctx = toolContext();
  toolViews = [];
  let profile = await backend.tools.profile({ action: 'add', changes: { host: 'tool.invalid', name: 'Tool server', port: 3390, username: 'fixture', disable_mouse_animation: true, adaptive_window: true, adaptive_sidebar: false, desktop_width: 1024, desktop_height: 768 } }, ctx);
  assert.equal(profile.open_mode, 'sidebar');
  assert.equal(profile.has_password, false);
  await backend.call('profiles.savePassword', { id: profile.profile_id, revision: profile.revision, password: 'synthetic-profile-secret' });
  profile = await backend.tools.profile({ action: 'get', profile_id: profile.profile_id }, ctx);
  const updated = await backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: profile.revision, changes: { name: 'Renamed', domain: '' } }, ctx);
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.host, profile.host);
  assert.equal(updated.port, 3390);
  assert.equal(updated.disable_mouse_animation, true);
  assert.equal(updated.adaptive_window, true); assert.equal(updated.adaptive_sidebar, false);
  assert.equal(updated.has_password, true);
  assert.equal(updated.desktop_width, 1024);
  assert.equal(updated.desktop_height, 768);
  assert.equal(await backend.call('profiles.password', { id: updated.profile_id, revision: updated.revision }), 'synthetic-profile-secret');
  assert.equal((await backend.call('profiles.get', { id: updated.profile_id })).name, updated.name);
  assert.deepEqual(await backend.tools.profile({ action: 'get', profile_id: profile.profile_id }, ctx), updated);
  assert.equal(JSON.stringify(updated).includes('synthetic-profile-secret'), false);
  const before = await readFile(join(dataDirectory, 'profiles.json'), 'utf8');
  await assert.rejects(backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: profile.revision, changes: { host: 'stale.invalid' } }, ctx), /PROFILE_CONFLICT/);
  await assert.rejects(backend.tools.profile({ action: 'delete', profile_id: profile.profile_id, revision: profile.revision }, ctx), /PROFILE_CONFLICT/);
  for (const changes of [{}, { port: 0 }, { host: null }, { password: 'not-supported' }]) {
    await assert.rejects(backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: updated.revision, changes }, ctx), /PROFILE_INVALID/);
  }
  await assert.rejects(backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: updated.revision, changes: { name: 'cancelled' } }, toolContext(AbortSignal.abort(new Error('cancel-write')))), /cancel-write/);
  assert.equal(await readFile(join(dataDirectory, 'profiles.json'), 'utf8'), before);
  await assert.rejects(backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: updated.revision, changes: { desktop_width: 8192, desktop_height: 8192 } }, ctx), /RDP_INVALID_RESOLUTION/);
  const resized = await backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: updated.revision, changes: { desktop_width: 1920, disable_mouse_animation: false, adaptive_window: false, adaptive_sidebar: true } }, ctx);
  assert.equal(resized.disable_mouse_animation, false);
  assert.equal(resized.adaptive_window, false); assert.equal(resized.adaptive_sidebar, true);
  assert.equal(resized.desktop_width, 1920); assert.equal(resized.desktop_height, 768);
  assert.equal(await backend.call('profiles.password', { id: resized.profile_id, revision: resized.revision }), 'synthetic-profile-secret');
  assert.deepEqual(await backend.tools.profile({ action: 'delete', profile_id: profile.profile_id, revision: resized.revision }, ctx), { profile_id: profile.profile_id, deleted: true });
  await assert.rejects(backend.tools.profile({ action: 'get', profile_id: profile.profile_id }, ctx), /PROFILE_MISSING/);
});

test('profile tool writes respect live editors, open reservations and fresh views after queueing', async () => {
  const ctx = toolContext();
  toolViews = [];
  const profile = await backend.tools.profile({ action: 'add', changes: { host: 'locked.invalid' } }, ctx);
  const args = { profile_id: profile.profile_id, revision: profile.revision };
  const home = { panelId: 'profile-home', instanceId: 'main', location: 'sidebar' };
  toolViews = [home];
  await backend.call('profiles.beginEdit', { id: profile.profile_id }, { caller: home, views: toolViews });
  await assert.rejects(backend.tools.profile({ action: 'update', ...args, changes: { name: 'Blocked' } }, ctx), /RDP_PROFILE_EDITING/);
  await assert.rejects(backend.tools.profile({ action: 'delete', ...args }, ctx), /RDP_PROFILE_EDITING/);
  toolViews = []; // Closing the editor clears its lock on the next fresh lookup.
  const changed = await backend.tools.profile({ action: 'update', ...args, changes: { name: 'Unlocked' } }, ctx);
  const token = await backend.call('profiles.launch', { id: changed.profile_id, revision: changed.revision });
  await assert.rejects(backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: changed.revision, changes: { name: 'Opening' } }, ctx), /RDP_PROFILE_OPEN/);
  await assert.rejects(backend.tools.profile({ action: 'delete', profile_id: profile.profile_id, revision: changed.revision }, ctx), /RDP_PROFILE_OPEN/);
  await backend.call('profiles.cancelLaunch', { id: profile.profile_id, token });
  toolViews = [{ panelId: 'desktop', instanceId: profile.profile_id, location: 'window' }];
  await assert.rejects(backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: changed.revision, changes: { name: 'Open' } }, ctx), /RDP_PROFILE_OPEN/);
  await assert.rejects(backend.tools.profile({ action: 'delete', profile_id: profile.profile_id, revision: changed.revision }, ctx), /RDP_PROFILE_OPEN/);
  toolViews = [];
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = backend.tools.profile({ action: 'update', profile_id: profile.profile_id, revision: changed.revision, changes: { name: 'Must not save' } },
    { ...ctx, signal: controller.signal, host: { getViews: async () => { entered(); await gate; return []; } } });
  const rejection = assert.rejects(pending, /cancel-queued/);
  await waiting; controller.abort(new Error('cancel-queued')); release(); await rejection;
  assert.equal((await backend.tools.profile({ action: 'get', profile_id: args.profile_id }, ctx)).name, 'Unlocked');
  await backend.tools.profile({ action: 'delete', profile_id: profile.profile_id, revision: changed.revision }, ctx);
});

test('window size belongs to the live session, survives page closure and rejects retired input owners', async t => {
  const source = await readFile(join(packageDirectory, 'backend.cjs'), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'rdp-window-memory-'));
  let lease = { owner: 'page-1', epoch: 1 };
  const textCommands = [];
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const value = JSON.parse(chunk.toString());
      if (value.method) {
        if (value.method === 'input') textCommands.push(value);
        emit({ request: value.request, result: value.method === 'lease' ? lease : { accepted: true } });
      }
      else { emit({ status: 'ready', port: 1234 }); emit({ status: 'connected' }); }
      callback();
    }});
    child.stdin.on('finish', () => child.emit('close', 0)); child.kill = () => child.emit('close', 0);
    return child;
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn } : require(name) });
  const isolated = module.exports, host = { onViewsChanged: () => () => {}, getViews: async () => [] };
  isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, tempDirectory: join(directory, 'tmp'), host });
  t.after(async () => { await isolated.deactivate(); await rm(directory, { recursive: true, force: true }); });
  const caller = { caller: { panelId: 'panel', instanceId: 'fixture' }, views: [{ panelId: 'panel', instanceId: 'fixture', location: 'window' }] };
  const call = (method, params) => isolated.call(method, params, { ...caller, host: { ...host, getViews: async () => caller.views } });
  const connection = { owner: 'fixture', host: 'test.invalid', username: '', password: '' };
  const resource = await call('create', connection), params = { owner: 'fixture', id: resource.id };
  const textParams = { ...params, pageId: 'page-1', expectedEpoch: 1, text: ' 你好🐟\n\t ' };
  assert.equal((await call('inputText', textParams)).accepted, true);
  assert.equal(textCommands[0].actions[0].text, textParams.text);
  assert.equal(textCommands[0].interval_ms, 0);
  for (const text of ['', 'x'.repeat(129), '\uD800']) await assert.rejects(call('inputText', { ...textParams, text }), /RDP_INVALID_INPUT/);
  await assert.rejects(call('inputText', { ...textParams, pageId: 'retired' }), /RDP_OWNERSHIP_CHANGED/);
  await assert.rejects(isolated.call('inputText', textParams, { caller: { instanceId: 'other' }, views: [] }), /RDP_PAGE_OWNER/);
  assert.equal(textCommands.length, 1);
  assert.equal(await call('windowState.get', params), null);
  const placement = { displayId: 9, x: 100, y: 60 };
  await call('windowState.set', { ...params, pageId: 'page-1', expectedEpoch: 1, width: 1234.5, height: 789, placement });
  await call('connection.close', { owner: 'fixture' });
  assert.equal((await call('find', { owner: 'fixture' })).id, resource.id);
  assert.deepEqual(JSON.parse(JSON.stringify(await call('windowState.get', params))), { width: 1234.5, height: 789, placement });
  lease = { owner: 'page-2', epoch: 2 };
  await assert.rejects(call('windowState.set', { ...params, pageId: 'page-1', expectedEpoch: 1, width: 500, height: 600 }), /RDP_OWNERSHIP_CHANGED/);
  await assert.rejects(call('windowState.set', { ...params, pageId: 'page-2', expectedEpoch: 2, width: NaN, height: 600 }), /RDP_INVALID_WINDOW_STATE/);
  assert.deepEqual(JSON.parse(JSON.stringify(await call('windowState.get', params))), { width: 1234.5, height: 789, placement });
  const read = await call('windowState.get', params); read.placement.x = 999;
  assert.equal((await call('windowState.get', params)).placement.x, 100);
  for (const placement of [null, {}, { displayId: 9, x: NaN, y: 0 }, { displayId: 9, x: 0, y: Infinity }]) {
    await assert.rejects(call('windowState.set', { ...params, pageId: 'page-2', expectedEpoch: 2, width: 500, height: 600, placement }), /RDP_INVALID_WINDOW_STATE/);
  }
  await call('disconnect', params);
  const replacement = await call('create', connection);
  assert.notEqual(replacement.id, resource.id);
  assert.equal(await call('windowState.get', { owner: 'fixture', id: replacement.id }), null);
});

test('live adaptive preferences persist without unlocking full edits or accepting retired pages', async t => {
  const source = await readFile(join(packageDirectory, 'backend.cjs'), 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'rdp-live-preferences-'));
  let lease = { owner: 'page-1', epoch: 1 };
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const value = JSON.parse(chunk.toString());
      if (value.method) emit({ request: value.request, result: value.method === 'lease' ? lease : {} });
      else { emit({ status: 'ready', port: 1234 }); emit({ status: 'connected' }); }
      callback();
    }});
    child.stdin.on('finish', () => child.emit('close', 0)); child.kill = () => child.emit('close', 0);
    return child;
  };
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn } : require(name) });
  const isolated = module.exports, host = { onViewsChanged: () => () => {}, getViews: async () => [] };
  isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, tempDirectory: join(directory, 'tmp'), host });
  t.after(async () => { await isolated.deactivate(); await rm(directory, { recursive: true, force: true }); });
  const caller = { caller: { panelId: 'panel', instanceId: 'fixture' }, views: [{ panelId: 'panel', instanceId: 'fixture', location: 'window' }] };
  const call = (method, params) => isolated.call(method, params, { ...caller, host: { ...host, getViews: async () => caller.views } });

  const profile=await isolated.call('profiles.save',{name:'Fixture',host:'test.invalid',username:'',passwordAction:'set',password:'fixture',desktopWidth:1536,desktopHeight:864},{caller:null,views:[]});
  caller.caller.instanceId=profile.id; caller.views[0].instanceId=profile.id;
  const resource=await call('create',{...profile,owner:profile.id,password:'fixture'});
  const params={owner:profile.id,id:resource.id,pageId:'page-1',expectedEpoch:1,location:'window',enabled:true};
  await call('setAdaptive',params);
  const saved=await call('profiles.get',{id:profile.id});
  assert.equal(saved.adaptiveWindow,true);assert.equal(saved.adaptiveSidebar,false);assert.equal(saved.desktopWidth,1536);
  assert.equal((await call('status',params)).adaptiveWindow,true);
  assert.equal((await call('runtime.state',{})).sessions[0].profile.adaptiveWindow,true);
  await assert.rejects(call('profiles.save',{...saved,passwordAction:'keep'}),/RDP_PROFILE_ACTIVE/);
  await assert.rejects(call('setAdaptive',{...params,name:'Changed'}),/PROFILE_INVALID/);
  lease={owner:'page-2',epoch:2};
  await assert.rejects(call('setAdaptive',{...params,enabled:false}),/RDP_OWNERSHIP_CHANGED/);
  await assert.rejects(call('setAdaptive',{...params,pageId:'page-2',expectedEpoch:2,location:'sidebar'}),/RDP_PAGE_OWNER/);
  await call('setAdaptive',{...params,pageId:'page-2',expectedEpoch:2,enabled:false});
  assert.equal((await call('status',params)).adaptiveWindow,false);
  await call('disconnect',params);
  assert.equal((await call('profiles.get',{id:profile.id})).adaptiveWindow,false);
  await assert.rejects(call('setAdaptive',params),/RDP_SESSION_CLOSED|RDP_NOT_CONNECTED/);
});
