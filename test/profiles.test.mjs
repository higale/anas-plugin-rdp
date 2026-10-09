import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/profiles.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { Profiles } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const fields = { name: 'Example', host: 'example.invalid', username: 'tester', passwordAction: 'remove' };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rdp-profiles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new Profiles(directory), read: async () => JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8')) };
}
test('passwords are encrypted, portable, randomized, and explicitly removable', async t => {
  const { store, directory, read } = await fixture(t);
  const password = 'synthetic-password-这是测试';
  let profile = await store.call('profiles.save', { ...fields, openMode: 'window', passwordAction: 'set', password });
  assert.equal(profile.hasPassword, true);
  assert.equal(JSON.stringify(profile).includes(password), false);
  assert.equal((await readFile(join(directory, 'profiles.json'), 'utf8')).includes(password), false);
  const firstCipher = (await read()).profiles[0].password;
  const backup = await fixture(t);
  await cp(join(directory, 'profiles.json'), join(backup.directory, 'profiles.json'));
  assert.equal(await backup.store.call('profiles.password', profile), password);
  assert.equal((await backup.store.call('profiles.list', {}))[0].openMode, 'window');
  profile = await store.call('profiles.save', { ...profile, passwordAction: 'set', password });
  assert.notEqual((await read()).profiles[0].password.iv, firstCipher.iv);
  const copy = await store.call('profiles.copy', { ...profile, name: 'Copy' });
  assert.equal(await store.call('profiles.password', copy), password);
  assert.notEqual((await read()).profiles[1].password.iv, (await read()).profiles[0].password.iv);
  profile = await store.call('profiles.save', { ...profile, passwordAction: 'remove' });
  assert.equal(profile.hasPassword, false);
  assert.equal(await store.call('profiles.password', profile), null);
  assert.equal((await read()).profiles[0].password, undefined);
});
test('empty password differs from no saved password, and keep does not change revision', async t => {
  const { store } = await fixture(t);
  const profile = await store.call('profiles.save', { ...fields, passwordAction: 'set', password: '' });
  assert.equal(await store.call('profiles.password', profile), '');
  assert.equal((await store.call('profiles.save', { ...profile, passwordAction: 'keep' })).revision, profile.revision);
});
test('concurrent edits reject stale revisions instead of losing changes', async t => {
  const { store } = await fixture(t);
  const profile = await store.call('profiles.save', fields);
  const results = await Promise.allSettled(['One', 'Two'].map(name => store.call('profiles.save', { ...profile, name, passwordAction: 'keep' })));
  assert.equal(results[0].status, 'fulfilled');
  assert.match(results[1].reason.message, /PROFILE_CONFLICT/);
  await assert.rejects(store.call('profiles.delete', profile), /PROFILE_CONFLICT/);
  const updated = results[0].value;
  await store.call('profiles.delete', updated);
  await assert.rejects(store.call('profiles.password', updated), /PROFILE_MISSING/);
  assert.deepEqual(await store.call('profiles.list', {}), []);
});
test('migration preserves old connection and valid trust; deleted profiles stay deleted', async t => {
  const { store, directory } = await fixture(t);
  const legacy = JSON.stringify({ version: 0, values: { connection: { host: 'old.invalid', username: 'old' }, certificate_trust: [null, {host:'old.invalid',port:3389,sha256:'a'.repeat(64)}] } });
  await writeFile(join(directory, 'state.json'), legacy);
  const [profile] = await store.call('profiles.list', {});
  assert.equal(profile.port, 3389);
  assert.equal(profile.domain, '');
  assert.equal(profile.openMode, 'sidebar');
  assert.equal(profile.hasPassword, false);
  assert.equal((await store.call('trusts.list', {})).length, 1);
  await store.call('profiles.delete', profile);
  assert.deepEqual(await new Profiles(directory).call('profiles.list', {}), []);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), legacy);
});
test('corrupt or unsupported files are preserved, never reset', async t => {
  const { store, directory } = await fixture(t);
  for (const raw of ['{broken', JSON.stringify({version:99,profiles:[]})]) {
    await writeFile(join(directory, 'profiles.json'), raw);
    await assert.rejects(store.call('profiles.save', fields), /PROFILE_READ_FAILED/);
    assert.equal(await readFile(join(directory, 'profiles.json'), 'utf8'), raw);
  }
});
test('damaged or transplanted password fails decryption; explicit replacement repairs it', async t => {
  const { store, directory, read } = await fixture(t);
  const a = await store.call('profiles.save', { ...fields, passwordAction: 'set', password: 'fixture' });
  const b = await store.call('profiles.save', fields);
  const state = await read(); state.profiles[1].password = state.profiles[0].password;
  await writeFile(join(directory, 'profiles.json'), JSON.stringify(state));
  await assert.rejects(store.call('profiles.password', b), /PASSWORD_UNREADABLE/);
  assert.equal(await store.call('profiles.password', a), 'fixture');
  const repaired = await store.call('profiles.save', { ...b, passwordAction: 'set', password: 'fixed' });
  assert.equal(await store.call('profiles.password', repaired), 'fixed');
});
test('parallel trust decisions merge without overwriting another target', async t => {
  const { store } = await fixture(t);
  await Promise.all(['one.invalid','two.invalid'].map(host => store.call('trusts.save', {host,port:3389,sha256:'a'.repeat(64)})));
  assert.equal((await store.call('trusts.list', {})).length, 2);
  await store.call('trusts.save', {host:'one.invalid',port:3389,sha256:'b'.repeat(64)});
  assert.equal((await store.call('trusts.list', {})).length, 2);
});
test('invalid modes, ports and password actions never modify a profile', async t => {
  const { store } = await fixture(t);
  const original = await store.call('profiles.save', fields);
  for (const change of [{port:0},{openMode:'other'},{passwordAction:'other'},{host:''}]) {
    await assert.rejects(store.call('profiles.save', {...original,passwordAction:'keep',...change}), /PROFILE_INVALID/);
  }
  assert.deepEqual(await store.call('profiles.list', {}), [original]);
});

test('reordering persists without changing profile revisions, passwords or concurrent edits', async t => {
  const { store, directory } = await fixture(t);
  const a = await store.call('profiles.save', { ...fields, passwordAction:'set', password:'synthetic' });
  const b = await store.call('profiles.save', { ...fields, name:'B' });
  const c = await store.call('profiles.save', { ...fields, name:'C' });
  const [moved, edited] = await Promise.all([
    store.call('profiles.move', { ...a, direction:1, neighborId:b.id }),
    store.call('profiles.save', { ...b, name:'Updated B', passwordAction:'keep' }),
  ]);
  assert.deepEqual(moved.map(item => item.id), [b.id,a.id,c.id]);
  const restored = await new Profiles(directory).call('profiles.list', {});
  assert.deepEqual(restored, [edited,a,c]);
  assert.equal(await store.call('profiles.password', a), 'synthetic');
  await assert.rejects(store.call('profiles.move', { ...a,direction:1,neighborId:b.id }), /PROFILE_CONFLICT/);
  await assert.rejects(store.call('profiles.move', { ...a,direction:0,neighborId:c.id }), /PROFILE_INVALID/);
  assert.deepEqual(await store.call('profiles.move', { ...c,direction:1,neighborId:null }), restored);
});

test('launch requests are scoped, single-use, cancellable and never survive backend restart', async t => {
  const { store, directory } = await fixture(t);
  const profile = await store.call('profiles.save', { ...fields, openMode:'window' });
  const consume = (location='window') => store.call('profiles.consumeLaunch', { id:profile.id,location });
  assert.equal(await consume(), null);
  const oldToken = await store.call('profiles.launch', profile);
  assert.equal(await store.call('profiles.consumeLaunch', { id: '00000000-0000-0000-0000-000000000000', location: 'sidebar' }), null);
  const token = await store.call('profiles.launch', profile);
  await store.call('profiles.cancelLaunch', { id:profile.id,location:'window',token:oldToken });
  assert.deepEqual(await consume('sidebar'), profile); // A moved page consumes the same profile's launch.
  assert.equal(await consume(), null);
  await store.call('profiles.launch', profile);
  assert.equal(await new Profiles(directory).call('profiles.consumeLaunch', { id:profile.id,location:'window' }), null);
  await store.call('profiles.cancelLaunch', { id:profile.id,location:'window',token });
  const cancel = await store.call('profiles.launch', profile);
  await store.call('profiles.cancelLaunch', { id:profile.id,location:'window',token:cancel });
  assert.equal(await consume(), null);
});

test('expired launches and changed or deleted profiles cannot connect', async t => {
  const { store } = await fixture(t);
  const profile = await store.call('profiles.save', fields);
  const consume = () => store.call('profiles.consumeLaunch', { id:profile.id,location:'sidebar' });
  const now = Date.now;
  t.after(() => { Date.now = now; });
  await store.call('profiles.launch', profile);
  Date.now = () => now() + 31000;
  assert.equal(await consume(), null);
  Date.now = now;
  await store.call('profiles.launch', profile);
  const next = await store.call('profiles.save', { ...profile,host:'changed.invalid',passwordAction:'keep' });
  await assert.rejects(consume(), /PROFILE_CONFLICT/);
  assert.equal(await consume(), null);
  await store.call('profiles.launch', next);
  await store.call('profiles.delete', next);
  await assert.rejects(consume(), /PROFILE_MISSING/);
});


test('getting the latest profile is read-only, omits secrets, and rejects deleted profiles', async t => {
  const { store, directory } = await fixture(t);
  const original = await store.call('profiles.save', { ...fields, passwordAction: 'set', password: 'saved-only' });
  const latest = await store.call('profiles.save', { ...original, host: 'latest.invalid', passwordAction: 'keep' });
  const before = await readFile(join(directory, 'profiles.json'), 'utf8');
  assert.deepEqual(await store.call('profiles.get', { id: original.id }), latest);
  assert.equal(await readFile(join(directory, 'profiles.json'), 'utf8'), before);
  await store.call('profiles.delete', latest);
  await assert.rejects(store.call('profiles.get', { id: original.id }), /PROFILE_MISSING/);
});


test('connection password saves only the credential and survives a portable backup', async t => {
  const { store, directory, read } = await fixture(t);
  const original = await store.call('profiles.save', { ...fields, domain: 'fixture-domain', openMode: 'window' });
  const second = await store.call('profiles.save', { ...fields, name: 'Second' });
  const trust = { host: original.host, port: original.port, sha256: 'a'.repeat(64) };
  await store.call('trusts.save', trust);
  const password = 'connection-secret-测试';
  const saved = await store.call('profiles.savePassword', { id: original.id, revision: original.revision, password, host: 'ignored.invalid' });
  assert.deepEqual(saved, { ...original, revision: original.revision + 1, hasPassword: true });
  assert.deepEqual(await store.call('profiles.list', {}), [saved, second]);
  assert.deepEqual(await store.call('trusts.list', {}), [trust]);
  assert.equal(JSON.stringify(await read()).includes(password), false);
  assert.equal(JSON.stringify(saved).includes(password), false);
  const backup = await fixture(t);
  await cp(join(directory, 'profiles.json'), join(backup.directory, 'profiles.json'));
  assert.equal(await backup.store.call('profiles.password', saved), password);
  const empty = await store.call('profiles.savePassword', { id: saved.id, revision: saved.revision, password: '' });
  assert.equal(empty.hasPassword, true);
  assert.equal(await store.call('profiles.password', empty), '');
});

test('password-only saves reject stale, invalid and deleted targets without overwriting or recreating them', async t => {
  const { store, directory } = await fixture(t);
  const original = await store.call('profiles.save', fields);
  const changed = await store.call('profiles.save', { ...original, name: 'Changed', passwordAction: 'keep' });
  const before = await readFile(join(directory, 'profiles.json'), 'utf8');
  await assert.rejects(store.call('profiles.savePassword', { ...original, password: 'stale' }), /PROFILE_CONFLICT/);
  for (const password of [null, 12, 'x'.repeat(4097)]) {
    await assert.rejects(store.call('profiles.savePassword', { ...changed, password }), /PROFILE_INVALID/);
  }
  await assert.rejects(store.call('profiles.savePassword', { password: 'missing-id' }), /PROFILE_MISSING/);
  assert.equal(await readFile(join(directory, 'profiles.json'), 'utf8'), before);
  await store.call('profiles.delete', changed);
  await assert.rejects(store.call('profiles.savePassword', { ...changed, password: 'deleted' }), /PROFILE_MISSING/);
  assert.deepEqual(await store.call('profiles.list', {}), []);
});

test('remembering placement changes only the latest open mode, preserves credentials, and keeps a valid launch', async t => {
  const { store, read } = await fixture(t);
  const original = await store.call('profiles.save', { ...fields, passwordAction: 'set', password: 'synthetic-position-password' });
  const edited = await store.call('profiles.save', { ...original, name: 'Latest name', passwordAction: 'keep' });
  const cipher = (await read()).profiles[0].password;
  await store.call('profiles.launch', edited);
  const placed = await store.call('profiles.setOpenMode', { id: edited.id, openMode: 'window' });
  assert.deepEqual(placed, { ...edited, openMode: 'window', revision: edited.revision + 1 });
  assert.deepEqual((await read()).profiles[0].password, cipher);
  assert.equal(await store.call('profiles.password', placed), 'synthetic-position-password');
  assert.deepEqual(await store.call('profiles.consumeLaunch', { id: edited.id }), placed);
  assert.deepEqual(await store.call('profiles.setOpenMode', { id: edited.id, openMode: 'window' }), placed);
});

test('placement does not revive a deleted profile or validate a launch made stale by other edits', async t => {
  const { store } = await fixture(t);
  const original = await store.call('profiles.save', fields);
  await store.call('profiles.launch', original);
  const edited = await store.call('profiles.save', { ...original, name: 'Changed after Start', passwordAction: 'keep' });
  const placed = await store.call('profiles.setOpenMode', { id: edited.id, openMode: 'window' });
  await assert.rejects(store.call('profiles.consumeLaunch', { id: edited.id }), /PROFILE_CONFLICT/);
  await store.call('profiles.delete', placed);
  assert.equal(await store.call('profiles.setOpenMode', { id: edited.id, openMode: 'sidebar' }), null);
  assert.deepEqual(await store.call('profiles.list', {}), []);
});


test('background running is optional, defaults off and preserves explicit choices across updates and copies', async t => {
  const { store, directory, read } = await fixture(t);
  let profile = await store.call('profiles.save', { ...fields, passwordAction: 'set', password: 'synthetic' });
  assert.equal(profile.runInBackground, false);
  const old = await read(); delete old.profiles[0].run_in_background;
  await writeFile(join(directory, 'profiles.json'), JSON.stringify(old));
  assert.equal((await store.call('profiles.get', profile)).runInBackground, false);
  assert.equal((await read()).profiles[0].run_in_background, undefined, 'Normal reads do not migrate or rewrite the old profile.');
  for (const value of [null, 0, 'true']) await assert.rejects(store.call('profiles.save', { ...profile, runInBackground: value, passwordAction: 'keep' }), /PROFILE_INVALID/);
  profile = await store.call('profiles.save', { ...profile, runInBackground: true, passwordAction: 'keep' });
  assert.equal(profile.runInBackground, true);
  assert.equal((await read()).profiles[0].run_in_background, true);
  assert.equal((await read()).version, 0);
  const moved = await store.call('profiles.setOpenMode', { id: profile.id, openMode: 'window' });
  assert.equal(moved.runInBackground, true);
  const copy = await store.call('profiles.copy', { ...moved, name: 'Copy' });
  assert.equal(copy.runInBackground, true);
  const disabled = await store.call('profiles.save', { ...moved, runInBackground: false, passwordAction: 'keep' });
  assert.equal(disabled.runInBackground, false);
  assert.equal(await store.call('profiles.password', disabled), 'synthetic');
  assert.equal((await read()).profiles[0].run_in_background, false);
});
