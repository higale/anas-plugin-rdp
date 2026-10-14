import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

assert.equal(process.platform, 'darwin', 'This proof preserves the native macOS clipboard.');
const require = createRequire(import.meta.url);
const backend = require(resolve('dist/backend.cjs'));
const config = JSON.parse(await readFile('.local/rdp-test.json', 'utf8'));
const targetKey = createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex');
let pin;
try {
  const trust = JSON.parse(await readFile('.local/rdp-trust.json', 'utf8'));
  if (trust.target_key === targetKey) pin = trust.certificate_sha256;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!pin) {
  const stored = JSON.parse(await readFile(join(homedir(), '.galeAnas/plugins_data/rdp/profiles.json'), 'utf8'));
  pin = stored.certificate_trust?.find(item => item.host === config.host && item.port === (config.port ?? 3389))?.sha256;
}
assert.ok(pin, 'A previously verified certificate is required.');
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/unicode-'));
const snapshotHelper = join(directory, 'clipboard-snapshot');
const snapshot = join(directory, 'clipboard.plist');
const marker = 'anas-unicode-' + randomUUID();
const results = [];
let views = [], viewsChanged, session, profile, saved = false, fixtureOpened = false, phase = 'prepare';
const host = { openView: async () => {}, moveView: async () => {}, closeView: async () => {}, getViews: async () => views, onViewsChanged: listener => { viewsChanged = listener; return () => { viewsChanged = undefined; }; } };
const context = () => ({ host, signal: new AbortController().signal, deadline: Date.now() + 45000 });
const call = (method, params) => backend.call(method, params, { caller: null, views });
const input = (actions, interval_ms = 80) => backend.tools.input({ profile_id: profile.id, actions, interval_ms }, context());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { assert.ok(Date.now() < deadline, label); await sleep(100); }
}
const clipboard = () => execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8', timeout: 5000 });
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
try {
  execFileSync('clang', ['-framework', 'AppKit', 'test/fixtures/clipboard-snapshot.m', '-o', snapshotHelper], { stdio: 'ignore' });
  execFileSync(snapshotHelper, ['save', snapshot]); saved = true;
  await backend.activate({ pluginId: 'rdp', packageDirectory: resolve('dist'), dataDirectory: join(directory, 'data'), tempDirectory: join(directory, 'tmp', 'anas-plugin-rdp'), host });
  await call('trusts.save', { host: config.host, port: config.port ?? 3389, sha256: pin });
  profile = await call('profiles.save', { ...config, name: 'Unicode verification', clipboardSupport: true, passwordAction: 'set' });
  phase = 'connect';
  session = await backend.tools.control({ profile_id: profile.id, state: 'background' }, context());
  assert.equal(session.connection_state, 'connected');
  views = [{ panelId: 'unicode-proof', instanceId: profile.id, location: 'window', activity: { active: true } }];
  viewsChanged(views);
  await until(async () => {
    try { await backend.tools.screenshot({ profile_id: profile.id }, context()); return true; }
    catch (error) { if (!String(error).includes('RDP_FRAME_UNAVAILABLE')) throw error; return false; }
  }, 'first frame');
  await until(async () => {
    try { await call('setClipboardEnabled', { owner: profile.id, id: session.session_id, enabled: true }); return true; }
    catch (error) { if (!String(error).includes('RDP_CLIPBOARD_UNAVAILABLE')) throw error; return false; }
  }, 'clipboard negotiation');
  assert.equal((await backend.tools.control({ profile_id: profile.id, reset_input: true }, context())).ok, true);
  phase = 'open isolated remote text box';
  await input([{ type: 'hotkey', keys: ['WIN', 'R'] }]); await sleep(500);
  await input([{ type: 'text', text: 'cmd.exe /d /q' }, { type: 'press', key: 'ENTER' }]); await sleep(700);
  const fixture = await readFile('test/fixtures/unicode-input.ps1', 'utf8');
  const script = `& { ${fixture} } -Marker '${marker}'`;
  const command = 'powershell.exe -NoProfile -STA -WindowStyle Hidden -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64') + ' & exit';
  assert.ok(command.length < 8000, 'Keep bootstrap within the Windows command-line limit.');
  for (let start = 0; start < command.length; start += 1000) await input([{ type: 'text', text: command.slice(start, start + 1000) }]);
  await input([{ type: 'press', key: 'ENTER' }]);
  await until(() => clipboard() === marker + ':ready', 'remote text box ready', 40000);
  fixtureOpened = true;
  const cases = [
    ['mixed Unicode', [{ type: 'text', text: '中文 🐟🙂 e\u0301 café "quotes" \'single\' `backtick` \\path 重复重复  ' }]],
    ['4096 repeated characters', [{ type: 'text', text: 'A'.repeat(4096) }]],
    ['1000 emoji', [{ type: 'text', text: '🐟'.repeat(1000) }]],
    ['text followed by Enter', [{ type: 'text', text: '第一行 🐟' }, { type: 'press', key: 'ENTER' }, { type: 'text', text: 'second line 中文' }]],
    ['text followed by Ctrl+Enter', [{ type: 'text', text: 'first' }, { type: 'hotkey', keys: ['CTRL', 'ENTER'] }, { type: 'text', text: 'second' }]],
  ];
  for (const [name, actions] of cases) {
    phase = name;
    await input([{ type: 'hotkey', keys: ['CTRL', 'HOME'] }, { type: 'hotkey', keys: ['CTRL', 'SHIFT', 'END'] }, { type: 'press', key: 'BACKSPACE' }]);
    await input(actions);
    const expected = actions.map(action => action.type === 'text' ? action.text : '\r\n').join('');
    await input([{ type: 'hotkey', keys: ['CTRL', 'F12'] }]);
    const prefix = marker + ':' + (results.length + 1) + ':';
    await until(() => clipboard().startsWith(prefix), 'remote content receipt');
    assert.equal(clipboard(), prefix + expected.length + ':' + hash(expected), name + ' must match the remote text box, including UTF-16 length and UTF-8 SHA-256.');
    results.push({ name, utf16Length: expected.length, sha256: hash(expected) });
    console.log('Passed:', name);
  }
  await input([{ type: 'hotkey', keys: ['CTRL', 'SHIFT', 'F12'] }]); fixtureOpened = false;
  await writeFile(join(directory, 'result.json'), JSON.stringify({ date: new Date().toISOString(), platform: process.platform, arch: process.arch, results }, null, 2) + '\n');
} catch (error) {
  console.error('Unicode verification failed during:', phase);
  if (session) {
    const blocks = await backend.tools.screenshot({ profile_id: profile.id }, context()).catch(() => []);
    const image = blocks.find(block => block.type === 'image');
    if (image) await writeFile(join(directory, 'failure.png'), Buffer.from(image.data, 'base64'));
  }
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.host, config.username, config.password]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(message);
  process.exitCode = 1;
} finally {
  try {
    if (fixtureOpened) await input([{ type: 'hotkey', keys: ['CTRL', 'SHIFT', 'F12'] }]).catch(() => {});
  } finally {
    try { await backend.deactivate(); }
    finally {
      if (saved) execFileSync(snapshotHelper, ['restore', snapshot]);
      await rm(join(directory, 'data'), { recursive: true, force: true });
      await rm(snapshot, { force: true });
    }
  }
}
