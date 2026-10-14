import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, connect } from 'node:net';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const config = JSON.parse(await readFile('.local/rdp-test.json', 'utf8'));
const trust = JSON.parse(await readFile('.local/rdp-trust.json', 'utf8'));
assert.equal(trust.target_key, createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex'));
const directory = await mkdtemp(join(tmpdir(), 'rdp-disconnection-'));
const sockets = new Set(), children = [];
// Break only this test's transport, without changing the machine's network.
const proxy = createServer(client => {
  const remote = connect(config.port ?? 3389, config.host);
  for (const socket of [client, remote]) {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  }
  client.pipe(remote).pipe(client);
  client.on('close', () => remote.destroy()); remote.on('close', () => client.destroy());
});
const childProcess = require('node:child_process'), spawn = childProcess.spawn;
childProcess.spawn = (...args) => { const child = spawn(...args); children.push(child); return child; };
const backend = require(resolve('dist/backend.cjs'));
const host = { onViewsChanged: () => () => {}, getViews: async () => [] };
const call = (method, params) => backend.call(method, params, { caller: null, views: [], host });
async function until(check, label, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
try {
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await backend.activate({ pluginId: 'rdp', packageDirectory: resolve('dist'), dataDirectory: directory, tempDirectory: join(directory, 'tmp'), host });
  const session = await call('create', { ...config, host: '127.0.0.1', port: proxy.address().port,
    owner: 'disconnection-proof', trustedSha256: trust.certificate_sha256 });
  const target = { owner: 'disconnection-proof', id: session.id };
  await until(async () => (await call('status', target)).state === 'connected', 'Connection did not complete');
  assert.equal(children.length, 1);
  for (const socket of sockets) socket.destroy();
  await until(async () => (await call('status', target)).state !== 'connected', 'Disconnected transport remained connected');
  await assert.rejects(call('resetInput', target), /RDP_(NOT_CONNECTED|SESSION_CLOSED|HELPER_CLOSED)/);
  await backend.deactivate();
  await until(() => children.every(child => child.exitCode !== null || child.signalCode !== null), 'Stopped helper did not exit', 10000);
  console.log('Transport disconnection: status updated, input rejected, backend stopped with no remaining native process.');
} catch (error) {
  let message = String(error?.stack ?? error);
  for (const value of [config.host, config.username, config.password]) if (value) message = message.split(value).join('[redacted]');
  console.error(message); process.exitCode = 1;
} finally {
  await backend.deactivate();
  childProcess.spawn = spawn;
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
  // Test failure cleanup targets only children created by this isolated backend.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true });
}
