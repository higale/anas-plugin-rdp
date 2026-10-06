import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { test, after } from 'node:test';
import { connect } from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const packageDirectory = resolve(process.env.RDP_TEST_PACKAGE ?? 'dist');
const backend = require(join(packageDirectory, 'backend.cjs'));
backend.activate({ pluginId: 'rdp', packageDirectory, dataDirectory: resolve('.local') });
after(() => backend.deactivate());

test('page ownership and disconnect reclaim the listener', async () => {
  const session = await backend.call('create', { owner: 'first-page', host: 'test.invalid', port: 3389 });
  assert.equal((await backend.call('status', { owner: 'first-page', id: session.id })).state, 'ready');
  await assert.rejects(backend.call('disconnect', { owner: 'second-page', id: session.id }), /does not belong/);
  await backend.call('disconnect', { owner: 'first-page', id: session.id });
  await backend.call('disconnect', { owner: 'first-page', id: session.id });
  await assert.rejects(backend.call('status', { owner: 'first-page', id: session.id }), /does not belong/);
  const port = Number(new URL(session.proxy).port);
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
