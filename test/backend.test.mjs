import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { test, after } from 'node:test';
import { createServer, connect } from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const packageDirectory = resolve(process.env.RDP_TEST_PACKAGE ?? 'dist');
const plugin = require(join(packageDirectory, 'backend.cjs'));
const backend = { ...plugin, call: (method, params, context = { caller: null, views: [] }) => plugin.call(method, params, context) };
const dataDirectory = await mkdtemp(join(tmpdir(), 'rdp-backend-'));
backend.activate({ pluginId: 'rdp', packageDirectory, dataDirectory });
after(async () => { await backend.deactivate(); await rm(dataDirectory, { recursive: true, force: true }); });

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
