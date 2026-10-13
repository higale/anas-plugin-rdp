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
const backend = { ...plugin, call: (method, params, context = { caller: null, views: [] }) => plugin.call(method, params, context) };
const dataDirectory = await mkdtemp(join(tmpdir(), 'rdp-backend-'));
let toolViews = [];
const host = { onViewsChanged: () => () => {}, getViews: async () => toolViews };
const toolContext = (signal = new AbortController().signal) => ({ host, signal, deadline: Date.now() + 45000 });
beforeEach(() => backend.activate({ pluginId: 'rdp', packageDirectory, dataDirectory, host }));
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
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn } : require(name) });
  const isolated = module.exports, host = { onViewsChanged: () => () => {}, getViews: async () => [] };
  const caller = { caller: null, views: [] }, ctx = { host, signal: new AbortController().signal, deadline: Date.now() + 45000 };
  isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, host });
  t.after(async () => { await isolated.deactivate(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(isolated.call('create', { owner: 'invalid', host: 'test.invalid', username: '', password: '', desktopWidth: 8192, desktopHeight: 8192 }, caller), /RDP_INVALID_RESOLUTION/);
  assert.equal(spawned, 0);
  await isolated.call('create', { owner: 'ui', host: 'test.invalid', username: '', password: '', desktopWidth: 1024, desktopHeight: 768 }, caller);
  await isolated.call('create', { owner: 'default', host: 'test.invalid', username: '', password: '' }, caller);
  const profile = await isolated.call('profiles.save', { name: 'Tool', host: 'test.invalid', username: '', passwordAction: 'set', password: '', desktopWidth: 1920, desktopHeight: 1080 }, caller);
  await isolated.tools.connect({ profile_id: profile.id, revision: profile.revision }, ctx);
  assert.deepEqual(configurations.map(config => [config.desktop_width, config.desktop_height]), [[1024,768],[1280,800],[1920,1080]]);
  const sessions = await isolated.tools.list_sessions({}, ctx);
  assert.equal(sessions.find(session => session.profile.id === profile.id).profile.desktopWidth, 1920);
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
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn } : require(name) });
  const isolated = module.exports, caller = { caller: null, views: [] };
  await isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, host: clipboardHost });
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
  const listed = await isolated.tools.list_sessions({}, { signal: new AbortController().signal });
  assert.equal(listed.find(session => session.id === second.id).clipboard_state, 'disabled');
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
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn: () => child } : require(name) });
  const isolated = module.exports;
  isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, host });
  t.after(async () => { await isolated.deactivate(); t.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); });
  const session = await isolated.call('create', { owner: 'test', host: 'test.invalid', username: 'test', password: '' }, { caller: null, views: [] });
  const controller = new AbortController(), deadline = Date.now() + 300000;
  let settled = false;
  const pending = isolated.tools.input({ session_id: session.id, actions: [{ type: 'text', text: 'Delayed text' }] }, { signal: controller.signal, deadline });
  void pending.then(() => { settled = true });
  const request = commands.at(-1);
  assert.equal(request.deadline_ms, deadline);
  t.mock.timers.tick(31000);
  controller.abort(new Error('Conversation ended'));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal((await isolated.tools.list_sessions({}, { signal: new AbortController().signal }))[0].state, 'connected');
  emit({ request: request.request, result: { accepted: true } });
  assert.equal((await pending).accepted, true);
  await assert.rejects(isolated.tools.input({ session_id: session.id, actions: [{ type: 'press', key: 'A' }] }, {
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
  runInNewContext(source, { module, exports: module.exports, process, Buffer, console, Date, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? { spawn: () => { spawned++; return child; } } : require(name) });
  const isolated = module.exports;
  isolated.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: directory, host });
  t.after(async () => { await isolated.deactivate(); await rm(directory, { recursive: true, force: true }); });
  const create = () => isolated.call('create', { owner: 'test', host: 'test.invalid', username: 'test', password: '' }, { caller: null, views: [] });
  let pending = create();
  if (ready) {
    const session = await pending;
    pending = isolated.tools.input({ session_id: session.id, actions: [{ type: 'text', text: 'Pending input' }] }, {
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

test('connect uses saved credentials, rejects stale revisions and reconciles closed editors with current host views', async () => {
  const profile = await backend.call('profiles.save', { name: 'Connect fixture', host: 'test.invalid', username: 'fixture', passwordAction: 'remove' });
  const args = { profile_id: profile.id, revision: profile.revision }, context = toolContext();
  assert.equal((await backend.tools.connect(args, context)).state, 'password_required');
  await assert.rejects(backend.tools.connect({ ...args, revision: profile.revision + 1 }, context), /PROFILE_CONFLICT/);
  toolViews = [{ panelId: 'home', instanceId: 'main', location: 'sidebar' }];
  await backend.call('profiles.beginEdit', profile, { caller: toolViews[0], views: toolViews });
  await assert.rejects(backend.tools.connect(args, context), /RDP_PROFILE_EDITING/);
  toolViews = [];
  assert.equal((await backend.tools.connect(args, context)).state, 'password_required');
  assert.equal((await backend.tools.list_sessions({}, context)).length, 0);
  await backend.call('profiles.delete', profile);
});

test('cancelling unfinished connections cleans up only after all pending calls cancel, and leaves reused connections intact', async t => {
  const peers = new Set();
  const server = createServer(socket => { peers.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await backend.deactivate(); for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  for (const runInBackground of [false, true]) {
    const profile = await backend.call('profiles.save', { name: 'Cancel fixture', host: '127.0.0.1', port: server.address().port,
      username: 'fixture', password: 'synthetic', passwordAction: 'set', runInBackground });
    const args = { profile_id: profile.id, revision: profile.revision };
    const controller = new AbortController(), context = toolContext(controller.signal);
    const connecting = backend.tools.connect(args, context);
    const rejected = assert.rejects(connecting, /Cancelled connect/);
    const deadline = Date.now() + 4000;
    while (!(await backend.tools.list_sessions({}, toolContext())).some(session => session.profile.id === profile.id)) {
      if (Date.now() > deadline) throw new Error('Helper was not created');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort(new Error('Cancelled connect'));
    await rejected;
    assert.equal(await backend.call('find', { owner: profile.id }), null);
    const first = new AbortController(), second = new AbortController();
    const firstResult = assert.rejects(backend.tools.connect(args, toolContext(first.signal)), /First cancelled/);
    const secondResult = assert.rejects(backend.tools.connect(args, toolContext(second.signal)), /Second cancelled/);
    // Wait for both starts to finish the serialized resource setup before canceling.
    await backend.call('profiles.cancelLaunch', { id: profile.id });
    const shared = await backend.call('find', { owner: profile.id });
    assert.ok(shared);
    first.abort(new Error('First cancelled'));
    await firstResult;
    assert.equal((await backend.call('find', { owner: profile.id })).id, shared.id, 'One cancelled call must not release another pending connection attempt.');
    second.abort(new Error('Second cancelled'));
    await secondResult;
    assert.equal(await backend.call('find', { owner: profile.id }), null);
    await assert.rejects(backend.tools.connect(args, { ...toolContext(), deadline: Date.now() }), /RDP_CONNECT_TIMEOUT/);
    assert.equal(await backend.call('find', { owner: profile.id }), null, 'An expired new attempt must reclaim its unfinished connection.');
    const userSession = await backend.call('create', { ...profile, owner: profile.id, password: 'synthetic' });
    const borrowed = new AbortController(), borrowedContext = toolContext(borrowed.signal);
    const borrowing = backend.tools.connect(args, borrowedContext);
    const borrowRejected = assert.rejects(borrowing, /Cancelled borrow/);
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
  const toolContext = { signal: new AbortController().signal, deadline: Date.now() + 300000 };
  const profile = await backend.call('profiles.save', { name: 'Tools fixture', host: '127.0.0.1', port: server.address().port,
    username: 'fixture', password: 'synthetic-secret', passwordAction: 'set' });
  const saved = (await backend.tools.list_profiles({}, toolContext)).find(item => item.id === profile.id);
  assert.equal(saved.hasPassword, true);
  assert.equal(JSON.stringify(saved).includes('synthetic-secret'), false);
  const session = await backend.call('create', { ...profile, owner: profile.id, password: 'synthetic-secret' });
  const listed = (await backend.tools.list_sessions({}, toolContext)).find(item => item.id === session.id);
  assert.equal(listed.profile.id, profile.id);
  assert.equal(listed.certificate, null);
  assert.equal(listed.ui_locked, false);
  await assert.rejects(backend.tools.set_ui_locked({ session_id: session.id, locked: 'false' }, toolContext), /RDP_INVALID_LOCK/);
  await assert.rejects(backend.tools.set_ui_locked({ session_id: session.id, locked: true }, toolContext), /RDP_NOT_CONNECTED/);
  await assert.rejects(backend.tools.set_ui_locked({ session_id: 'missing', locked: true }, toolContext), /RDP_SESSION_CLOSED/);
  await assert.rejects(backend.tools.set_ui_locked({ session_id: session.id, locked: true }, { signal: AbortSignal.abort(new Error('cancel-lock')) }), /cancel-lock/);
  await assert.rejects(backend.call('setUiLocked', { owner: 'wrong', id: session.id, locked: true }), /does not belong/);
  for (const value of ['synthetic-secret', session.token, session.url]) assert.equal(JSON.stringify(listed).includes(value), false);
  for (const text of ['', null, 42, '\ud800', '\udfff', 'A'.repeat(4097), '中'.repeat(4096), '\0'.repeat(2000)]) {
    await assert.rejects(backend.tools.input({session_id:session.id,actions:[{type:'text',text}]},toolContext), /RDP_INVALID_INPUT/);
  }
  await assert.rejects(backend.tools.input({session_id:session.id,actions:Array.from({length:3},()=>({type:'text',text:'A'.repeat(4000)}))},toolContext), /RDP_INVALID_INPUT/);
  await assert.rejects(backend.tools.input({session_id:session.id,actions:[{type:'text',text:'你好，Anas 🐟\r\n'}]},toolContext), /RDP_NOT_CONNECTED/);
  await assert.rejects(backend.tools.screenshot({ session_id: session.id }, toolContext), /RDP_FRAME_UNAVAILABLE/);
  await assert.rejects(backend.tools.screenshot({ session_id: session.id, include_cursor: 'false' }, toolContext), /Invalid cursor/);
  const aborted = { signal: AbortSignal.abort(new Error('Test cancellation')) };
  await assert.rejects(backend.tools.screenshot({ session_id: session.id }, aborted), /Test cancellation/);
  const controller = new AbortController();
  const pendingCapture = backend.tools.screenshot({ session_id: session.id }, { signal: controller.signal });
  controller.abort(new Error('Capture cancelled after dispatch'));
  await assert.rejects(pendingCapture, /Capture cancelled after dispatch/);
  await assert.rejects(backend.tools.disconnect({ session_id: session.id }, aborted), /Test cancellation/);
  assert.equal((await backend.call('find', { owner: profile.id })).id, session.id);
  await assert.rejects(backend.tools.screenshot({ session_id: session.id }, toolContext), /RDP_FRAME_UNAVAILABLE/);
  await backend.tools.disconnect({ session_id: session.id }, toolContext);
  await backend.tools.disconnect({ session_id: session.id }, toolContext);
  assert.equal(await backend.call('find', { owner: profile.id }), null);
  await assert.rejects(backend.tools.screenshot({ session_id: session.id }, toolContext), /RDP_SESSION_CLOSED/);
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
  assert.deepEqual(await backend.call('find', { owner: profile.id }), session);
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
  const placed = await backend.call('connection.setLocation', { id: profile.id, location: 'sidebar' }, context);
  assert.equal(placed.location, 'window', 'The host snapshot determines placement, not renderer parameters.');
  assert.equal(placed.profile.openMode, 'window');
  const summary = async () => (await backend.call('runtime.state', {})).sessions.find(item => item.id === resource.id);
  assert.equal((await summary()).profile.openMode, 'window');
  assert.equal((await backend.call('find', { owner: profile.id })).id, resource.id);
  await assert.rejects(backend.call('connection.setLocation', { id: profile.id }), /RDP_LOCATION_UNAVAILABLE/);
  await assert.rejects(backend.call('profiles.setOpenMode', { id: profile.id, openMode: 'sidebar' }, context), /RDP_LOCATION_UNAVAILABLE/);
  const file = join(dataDirectory, 'profiles.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.profiles.find(item => item.id === profile.id).open_mode = 'sidebar';
  await writeFile(file, JSON.stringify(state));
  assert.equal((await summary()).profile.openMode, 'sidebar', 'The saved preference overrides the older session snapshot.');
  state.profiles = state.profiles.filter(item => item.id !== profile.id);
  await writeFile(file, JSON.stringify(state));
  assert.equal((await summary()).profile.openMode, 'window');
  assert.equal((await backend.call('connection.setLocation', { id: profile.id }, context)).profile, null);
  assert.equal((await backend.call('profiles.list', {})).some(item => item.id === profile.id), false);
});


test('desktop close ends foreground resources, cancels queued launch intents and preserves opted-in background connections', async t => {
  const peers = new Set();
  const server = createServer(socket => { peers.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await backend.deactivate(); for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const settings = { host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'synthetic' };
  const ownPage = owner => ({ caller: { panelId: owner, instanceId: owner }, views: [{ panelId: owner, instanceId: owner, location: 'window' }] });
  for (const value of [null, 'true', 1]) await assert.rejects(backend.call('create', { ...settings, owner: 'invalid', runInBackground: value }), /Invalid background/);
  const foreground = await backend.call('profiles.save', { ...settings, name: 'Foreground', passwordAction: 'remove' });
  await backend.call('profiles.launch', foreground);
  const creating = backend.call('create', { ...settings, owner: foreground.id });
  const closing = backend.call('connection.close', { owner: foreground.id }, ownPage(foreground.id));
  const resource = await creating;
  await closing;
  assert.equal(await backend.call('find', { owner: foreground.id }), null);
  await assert.rejects(backend.call('status', { owner: foreground.id, id: resource.id }), /RDP_SESSION_CLOSED/);
  assert.equal(await backend.call('profiles.consumeLaunch', { id: foreground.id }), null);
  await backend.call('connection.close', { owner: foreground.id }, ownPage(foreground.id));
  const background = await backend.call('create', { ...settings, owner: 'background', runInBackground: true });
  await assert.rejects(backend.call('connection.close', { owner: 'background' }, ownPage('another')), /RDP_PAGE_OWNER/);
  await backend.call('connection.close', { owner: 'background' }, ownPage('background'));
  assert.equal((await backend.call('find', { owner: 'background' })).id, background.id);
  await backend.call('disconnect', { owner: 'background', id: background.id });
  assert.equal(await backend.call('find', { owner: 'background' }), null);
});


test('server list selection is transient, restricted to its consumer and safe against stale acknowledgements', async () => {
  const profile = await backend.call('profiles.save', { name: 'Selection fixture', host: 'test.invalid', username: 'fixture', passwordAction: 'remove' });
  const home = { panelId: 'home', instanceId: 'main', location: 'sidebar' };
  const connection = { panelId: 'connection', instanceId: 'server-one', location: 'window' };
  const manager = { caller: home, views: [home, connection] };
  const desktop = { caller: connection, views: [home, connection] };
  const original = await readFile(join(dataDirectory, 'profiles.json'));
  await backend.call('profiles.select', { id: 'server-one' }, desktop);
  const first = (await backend.call('runtime.state', {}, manager)).selection;
  assert.equal(first.id, 'server-one');
  assert.equal((await backend.call('runtime.state', {}, desktop)).selection, undefined);
  await assert.rejects(backend.call('profiles.ackSelection', { token: first.token }, desktop), /RDP_EDITOR_OWNER/);
  await backend.call('profiles.select', { id: 'server-two' }, desktop);
  await backend.call('profiles.ackSelection', { token: first.token }, manager);
  const next = (await backend.call('runtime.state', {}, manager)).selection;
  assert.equal(next.id, 'server-two');
  assert.notEqual(next.token, first.token);
  await backend.call('profiles.ackSelection', { token: next.token }, manager);
  assert.equal((await backend.call('runtime.state', {}, manager)).selection, undefined);
  assert.deepEqual(await readFile(join(dataDirectory, 'profiles.json')), original);
  await backend.call('profiles.delete', profile);
  await backend.call('profiles.select', { id: 'server-one' }, desktop);
  await backend.deactivate();
  assert.equal((await backend.call('runtime.state', {}, manager)).selection, undefined);
});

test('profile tools share UI storage, preserve credentials and omitted fields, and reject stale/invalid writes', async () => {
  const ctx = toolContext();
  toolViews = [];
  let profile = await backend.tools.add_profile({ changes: { host: 'tool.invalid', name: 'Tool server', port: 3390, username: 'fixture', run_in_background: true, desktop_width: 1024, desktop_height: 768 } }, ctx);
  assert.equal(profile.openMode, 'sidebar');
  assert.equal(profile.hasPassword, false);
  profile = await backend.call('profiles.savePassword', { ...profile, password: 'synthetic-profile-secret' });
  const updated = await backend.tools.update_profile({ profile_id: profile.id, revision: profile.revision, changes: { name: 'Renamed', run_in_background: false, domain: '' } }, ctx);
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.host, profile.host);
  assert.equal(updated.port, 3390);
  assert.equal(updated.runInBackground, false);
  assert.equal(updated.hasPassword, true);
  assert.equal(updated.desktopWidth, 1024);
  assert.equal(updated.desktopHeight, 768);
  assert.equal(await backend.call('profiles.password', updated), 'synthetic-profile-secret');
  assert.deepEqual(await backend.call('profiles.get', updated), updated);
  assert.deepEqual(await backend.tools.get_profile({ profile_id: profile.id }, ctx), updated);
  assert.equal(JSON.stringify(updated).includes('synthetic-profile-secret'), false);
  const before = await readFile(join(dataDirectory, 'profiles.json'), 'utf8');
  await assert.rejects(backend.tools.update_profile({ profile_id: profile.id, revision: profile.revision, changes: { host: 'stale.invalid' } }, ctx), /PROFILE_CONFLICT/);
  await assert.rejects(backend.tools.delete_profile({ profile_id: profile.id, revision: profile.revision }, ctx), /PROFILE_CONFLICT/);
  for (const changes of [{}, { port: 0 }, { host: null }, { password: 'not-supported' }]) {
    await assert.rejects(backend.tools.update_profile({ profile_id: profile.id, revision: updated.revision, changes }, ctx), /PROFILE_INVALID/);
  }
  await assert.rejects(backend.tools.update_profile({ profile_id: profile.id, revision: updated.revision, changes: { name: 'cancelled' } }, toolContext(AbortSignal.abort(new Error('cancel-write')))), /cancel-write/);
  assert.equal(await readFile(join(dataDirectory, 'profiles.json'), 'utf8'), before);
  await assert.rejects(backend.tools.update_profile({ profile_id: profile.id, revision: updated.revision, changes: { desktop_width: 8192, desktop_height: 8192 } }, ctx), /RDP_INVALID_RESOLUTION/);
  const resized = await backend.tools.update_profile({ profile_id: profile.id, revision: updated.revision, changes: { desktop_width: 1920 } }, ctx);
  assert.equal(resized.desktopWidth, 1920); assert.equal(resized.desktopHeight, 768);
  assert.equal(await backend.call('profiles.password', resized), 'synthetic-profile-secret');
  assert.deepEqual(await backend.tools.delete_profile({ profile_id: profile.id, revision: resized.revision }, ctx), { profile_id: profile.id, deleted: true });
  await assert.rejects(backend.tools.get_profile({ profile_id: profile.id }, ctx), /PROFILE_MISSING/);
});

test('profile tool writes respect live editors, open reservations and fresh views after queueing', async () => {
  const ctx = toolContext();
  toolViews = [];
  const profile = await backend.tools.add_profile({ changes: { host: 'locked.invalid' } }, ctx);
  const args = { profile_id: profile.id, revision: profile.revision };
  const home = { panelId: 'profile-home', instanceId: 'main', location: 'sidebar' };
  toolViews = [home];
  await backend.call('profiles.beginEdit', profile, { caller: home, views: toolViews });
  await assert.rejects(backend.tools.update_profile({ ...args, changes: { name: 'Blocked' } }, ctx), /RDP_PROFILE_EDITING/);
  await assert.rejects(backend.tools.delete_profile(args, ctx), /RDP_PROFILE_EDITING/);
  toolViews = []; // Closing the editor clears its lock on the next fresh lookup.
  const changed = await backend.tools.update_profile({ ...args, changes: { name: 'Unlocked' } }, ctx);
  const token = await backend.call('profiles.launch', changed);
  await assert.rejects(backend.tools.update_profile({ profile_id: profile.id, revision: changed.revision, changes: { name: 'Opening' } }, ctx), /RDP_PROFILE_OPEN/);
  await assert.rejects(backend.tools.delete_profile({ profile_id: profile.id, revision: changed.revision }, ctx), /RDP_PROFILE_OPEN/);
  await backend.call('profiles.cancelLaunch', { id: profile.id, token });
  toolViews = [{ panelId: 'desktop', instanceId: profile.id, location: 'window' }];
  await assert.rejects(backend.tools.update_profile({ profile_id: profile.id, revision: changed.revision, changes: { name: 'Open' } }, ctx), /RDP_PROFILE_OPEN/);
  toolViews = [];
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = backend.tools.update_profile({ profile_id: profile.id, revision: changed.revision, changes: { name: 'Must not save' } },
    { ...ctx, signal: controller.signal, host: { getViews: async () => { entered(); await gate; return []; } } });
  const rejection = assert.rejects(pending, /cancel-queued/);
  await waiting; controller.abort(new Error('cancel-queued')); release(); await rejection;
  assert.equal((await backend.tools.get_profile(args, ctx)).name, 'Unlocked');
  await backend.tools.delete_profile({ profile_id: profile.id, revision: changed.revision }, ctx);
});

test('show desktop reuses and moves a live session without holding its resource lock across page preparation', async t => {
  const server = createServer(socket => { socket.on('data',()=>{}); socket.on('error',()=>{}); socket.on('close',()=>{}); peers.add(socket); });
  const peers = new Set();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const session = await backend.call('create', { owner:'display-tool',name:'Display',host:'127.0.0.1',port:server.address().port,username:'fixture',password:'synthetic' });
  t.after(async () => { await backend.call('disconnect',{owner:'display-tool',id:session.id}); for(const peer of peers) peer.destroy(); await new Promise(resolve=>server.close(resolve)); });
  let views = [], moves = 0, opens = 0;
  const host = { onViewsChanged: () => () => {}, getViews: async()=>views,
    openView: async options => {
      opens++;
      if (!views.length) views = [{panelId:'view',instanceId:options.instanceId,location:options.location}];
      await backend.call('connection.open',{owner:'display-tool'},{caller:views[0],views});
    },
    moveView: async options => { moves++; views[0].location=options.location; }
  };
  const context = {...toolContext(),host};
  assert.equal((await backend.tools.show_desktop({session_id:session.id},context)).view.location,'sidebar');
  assert.equal((await backend.tools.show_desktop({session_id:session.id,location:'window'},context)).view.location,'window');
  await backend.tools.show_desktop({session_id:session.id},context);
  assert.equal(moves,1); assert.equal(opens,3); assert.equal(views.length,1);
  assert.equal((await backend.call('find',{owner:'display-tool'})).id,session.id);
  const cancel = new AbortController(); cancel.abort(new Error('cancel display'));
  await assert.rejects(backend.tools.show_desktop({session_id:session.id},{...context,signal:cancel.signal}),/cancel display/);
  assert.equal(opens,3);
});
