import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const require = createRequire(import.meta.url), packageDirectory = resolve('dist');
const backend = require(join(packageDirectory, 'backend.cjs'));
const config = JSON.parse(await readFile('.local/rdp-test.json', 'utf8'));
let pin;
try {
  const trust = JSON.parse(await readFile('.local/rdp-trust.json', 'utf8'));
  if (trust.target_key === createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex')) pin = trust.certificate_sha256;
} catch {}
if (!pin) {
  const stored = JSON.parse(await readFile(resolve(homedir(), '.galeAnas/plugins_data/rdp/profiles.json'), 'utf8'));
  pin = stored.certificate_trust?.find(item => item.host === config.host && item.port === (config.port ?? 3389))?.sha256;
}
assert.ok(pin, 'A previously verified certificate is required.');
const dataDirectory = await mkdtemp(join(tmpdir(), 'rdp-session-tools-'));
let views = [], phase = 'prepare';
const host = { onViewsChanged: () => () => {}, getViews: async () => views };
const context = () => ({ host, signal: new AbortController().signal, deadline: Date.now() + 45000 });
const call = (method, params, caller = null) => backend.call(method, params, { caller, views });
const connect = profile => backend.tools.connect({ profile_id: profile.id, revision: profile.revision }, context());
try {
  await backend.activate({ pluginId: 'rdp', packageDirectory, dataDirectory, host });
  await call('trusts.save', { host: config.host, port: config.port ?? 3389, sha256: pin });
  const profile = await call('profiles.save', { ...config, name: 'Independent connection verification', passwordAction: 'set' });
  phase = 'overlapping calls without caller metadata';
  const [first, second] = await Promise.all([connect(profile), connect(profile)]);
  assert.equal(first.state, 'connected');
  assert.equal(second.id, first.id);
  assert.equal(first.view, null);
  assert.equal(second.view, null);
  phase = 'connection-scoped local input lock';
  assert.equal(first.ui_locked, false);
  const locked = await backend.tools.set_ui_locked({ session_id: first.id, locked: true }, context());
  assert.deepEqual(locked, { session_id: first.id, ui_locked: true });
  assert.equal((await backend.tools.list_sessions({}, context())).find(session => session.id === first.id).ui_locked, true);
  assert.equal((await connect(profile)).ui_locked, true, 'Reusing a connection must preserve its lock.');
  assert.deepEqual(await backend.tools.set_ui_locked({ session_id: first.id, locked: true }, context()), locked);
  phase = 'model input and cancellation';
  let frame;
  for (let n = 0; n < 100; n++) {
    try { frame = await backend.tools.screenshot({ session_id: first.id }, context()); break; }
    catch (error) { if (!String(error).includes('RDP_FRAME_UNAVAILABLE')) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(frame);
  const beforeInput = JSON.parse(frame[0].text).input_revision;
  const aborted = new AbortController(); aborted.abort(new Error('cancelled before dispatch'));
  await assert.rejects(backend.tools.input({ session_id: first.id, actions: [{type:'move',x:40,y:40}] }, {...context(),signal:aborted.signal}), /cancelled before dispatch/);
  assert.equal(JSON.parse((await backend.tools.screenshot({ session_id: first.id }, context()))[0].text).input_revision, beforeInput);
  assert.equal((await backend.tools.input({ session_id: first.id, actions: [{type:'move',x:40,y:40},{type:'key',code:42,down:true}] }, context())).accepted, true);
  assert.equal((await call('lease', { owner: profile.id, id: first.id })).owner, null);
  assert.equal((await call('find', { owner: profile.id })).id, first.id);
  assert.equal((await backend.tools.input({ session_id: first.id, actions: [{type:'move',x:41,y:41}] }, context())).accepted, true);
  assert.equal((await backend.tools.input({ session_id: first.id, actions: [{type:'key',code:42,down:false}] }, context())).accepted, true);
  phase = 'timed gestures stay responsive and reject overlapping tool input';
  const revision = async () => JSON.parse((await backend.tools.screenshot({ session_id: first.id }, context()))[0].text).input_revision;
  const beforeTimed = await revision();
  const timedContext = new AbortController();
  const startedAt = performance.now();
  const timed = backend.tools.input({ session_id: first.id, interval_ms: 250, actions: [
    { type: 'key', code: 42, down: true }, { type: 'move', x: 43, y: 43 },
    { type: 'move', x: 44, y: 44 }, { type: 'key', code: 42, down: false }
  ] }, { ...context(), signal: timedContext.signal });
  // Observe the first dispatched step through the ordinary screenshot interface.
  while (await revision() === beforeTimed) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await backend.tools.list_sessions({}, context())).find(session => session.id === first.id).state, 'connected');
  await assert.rejects(backend.tools.input({ session_id: first.id, interval_ms: 0, actions: [{ type: 'move', x: 45, y: 45 }] }, context()), /RDP_INPUT_BUSY/);
  timedContext.abort(new Error('cancelled after dispatch'));
  assert.equal((await timed).accepted, true, 'An accepted sequence must finish the requested actions after caller cancellation.');
  assert.ok(performance.now() - startedAt >= 750, 'Receipt must wait for the real action spacing.');
  assert.equal(await revision(), beforeTimed + 4);
  for (const interval_ms of [null, -1, 1.5, '80', 1001]) {
    await assert.rejects(backend.tools.input({ session_id: first.id, interval_ms, actions: [{ type: 'move', x: 45, y: 45 }] }, context()), /RDP_INVALID_INPUT/);
  }
  await assert.rejects(backend.tools.input({ session_id: first.id, interval_ms: 1000, actions: Array.from({length:6}, () => ({type:'move',x:45,y:45})) }, { ...context(), deadline: Date.now() + 500 }), /RDP_INPUT_TIMEOUT/);
  await assert.rejects(backend.tools.input({ session_id: first.id, interval_ms: 80, actions: [{type:'key',code:42,down:true},{type:'key',code:0,down:false}] }, context()), /RDP_INVALID_INPUT/);
  assert.equal(await revision(), beforeTimed + 4, 'Invalid parameters must not dispatch even the valid prefix.');
  assert.equal((await backend.tools.input({ session_id: first.id, interval_ms: 0, actions: [{type:'move',x:45,y:45},{type:'move',x:46,y:46}] }, context())).accepted, true);
  assert.equal(await revision(), beforeTimed + 5, 'Explicit zero retains single-batch dispatch.');
  phase = 'named keys and chords use their own hold time';
  const beforeNamed = await revision();
  const namedAt = performance.now();
  assert.equal((await backend.tools.input({ session_id: first.id, interval_ms: 100, actions: [
    {type:'press',key:'SHIFT'},{type:'press',key:'SHIFT'},{type:'hotkey',keys:['CTRL','SHIFT']}
  ] }, context())).accepted, true);
  assert.ok(performance.now() - namedAt >= 350);
  assert.equal(await revision(), beforeNamed + 6);
  await assert.rejects(backend.tools.input({ session_id: first.id, actions: [{type:'press',key:'SHIFT'},{type:'hotkey',keys:['CTRL','NOT-A-KEY']}] }, context()), /RDP_INVALID_INPUT/);
  await assert.rejects(backend.tools.input({ session_id: first.id, interval_ms: 1000, actions: Array.from({length:5}, () => ({type:'press',key:'SHIFT'})) }, { ...context(), deadline: Date.now() + 500 }), /RDP_INPUT_TIMEOUT/);
  assert.equal(await revision(), beforeNamed + 6);
  phase = 'invalid text cannot dispatch a prefix or break the helper';
  const beforeText = await revision();
  for (const text of ['', 42, '\ud800', 'A'.repeat(4097), '中'.repeat(4096), '\0'.repeat(2000)]) {
    await assert.rejects(backend.tools.input({session_id:first.id,actions:[{type:'press',key:'SHIFT'},{type:'text',text}]},context()), /RDP_INVALID_INPUT/);
  }
  await assert.rejects(backend.tools.input({session_id:first.id,actions:[{type:'press',key:'SHIFT'},{type:'text',text:'valid',extra:true}]},context()), /RDP_INVALID_INPUT/);
  assert.equal(await revision(),beforeText);
  phase = 'long input waits beyond old five-second receipt limit while screenshots and the session stay available';
  const longStarted = performance.now();
  const longInput = backend.tools.input({ session_id: first.id, interval_ms: 1000,
    actions: Array.from({ length: 12 }, (_, i) => ({ type: 'move', x: 45 + i, y: 45 })) }, context());
  const observed = await backend.tools.screenshot({ session_id: first.id }, context());
  assert.ok(observed.some(block => block.type === 'image'));
  assert.equal((await longInput).accepted, true);
  assert.ok(performance.now() - longStarted >= 11000);
  assert.equal((await backend.tools.list_sessions({}, context())).find(session => session.id === first.id).state, 'connected');
  phase = 'explicit keyboard reset shared by tools and UI, including interrupting pending input';
  const resetAborted = new AbortController(); resetAborted.abort(new Error('cancelled reset'));
  const beforeReset = await revision();
  await assert.rejects(backend.tools.reset_keyboard({session_id:first.id}, {...context(),signal:resetAborted.signal}), /cancelled reset/);
  assert.equal(await revision(), beforeReset);
  const reset = await backend.tools.reset_keyboard({session_id:first.id}, context());
  assert.equal(reset.session_id, first.id); assert.equal(reset.accepted,true); assert.equal(reset.toggle_flags,0);
  assert.equal((await backend.tools.list_sessions({}, context())).find(s => s.id === first.id).ui_locked,true);
  const beforeInterrupt = await revision();
  const sequence = backend.tools.input({session_id:first.id,interval_ms:1000,actions:[
    {type:'key',code:29,down:true},{type:'key',code:30,down:true},{type:'key',code:30,down:false}
  ]},context());
  const resetRejection = assert.rejects(sequence,/RDP_INPUT_RESET/);
  while (await revision() === beforeInterrupt) await new Promise(resolve => setTimeout(resolve,10));
  const uiReset = await call('resetKeyboard',{owner:profile.id,id:first.id});
  assert.equal(uiReset.accepted,true); assert.equal(uiReset.toggle_flags,0);
  await resetRejection;
  await new Promise(resolve => setTimeout(resolve,1100));
  assert.equal(await revision(),beforeInterrupt+2,'Explicit reset must stop later sequence events.');
  const completed = new AbortController();
  const again = await backend.tools.connect({ profile_id: profile.id, revision: profile.revision }, { ...context(), signal: completed.signal });
  completed.abort(new Error('The caller has finished.'));
  assert.equal(again.id, first.id);
  assert.equal((await call('find', { owner: profile.id })).id, first.id);
  assert.equal(again.ui_locked, true);
  await call('setUiLocked', { owner: profile.id, id: first.id, locked: false });
  assert.equal((await backend.tools.list_sessions({}, context())).find(session => session.id === first.id).ui_locked, false);
  phase = 'disconnect interrupts timed gestures without waiting for their remaining spacing';
  const beforeStop = await revision();
  const interrupted = backend.tools.input({ session_id: first.id, interval_ms: 1000, actions: [
    {type:'key',code:42,down:true},{type:'move',x:48,y:48},{type:'move',x:49,y:49},{type:'key',code:42,down:false}
  ] }, context());
  const rejected = assert.rejects(interrupted, /RDP_SESSION_CLOSED/);
  while (await revision() === beforeStop) await new Promise(resolve => setTimeout(resolve, 10));
  const stopAt = performance.now();
  await backend.tools.disconnect({ session_id: first.id }, context());
  await rejected;
  assert.ok(performance.now() - stopAt < 2500, 'Disconnect must not wait for a three-second gesture.');
  assert.equal(await call('find', { owner: profile.id }), null);

  phase = 'desktop close policy';
  const taken = await connect(profile);
  assert.equal(taken.state, 'connected');
  assert.equal(taken.ui_locked, false, 'A new connection must start unlocked.');
  views = [{ panelId: 'desktop', instanceId: profile.id, location: 'sidebar' }];
  await call('connection.open', { owner: profile.id }, views[0]);
  assert.equal((await call('find', { owner: profile.id })).id, taken.id);
  views = [];
  await call('connection.close', { owner: profile.id }, { panelId: 'desktop', instanceId: profile.id });
  assert.equal(await call('find', { owner: profile.id }), null);

  phase = 'borrowed user connection';
  const owned = await call('create', { ...profile, owner: profile.id, password: config.password, trustedSha256: pin });
  const borrowed = await connect(profile);
  assert.equal(borrowed.state, 'connected');
  assert.equal(borrowed.reused, true);
  assert.equal(borrowed.id, owned.id);
  assert.equal((await call('find', { owner: profile.id })).id, owned.id);
  await call('disconnect', { owner: profile.id, id: owned.id });

  phase = 'background connection';
  const background = await call('profiles.save', { ...profile, runInBackground: true, passwordAction: 'keep' });
  const retained = await connect(background);
  assert.equal(retained.state, 'connected');
  assert.equal((await call('find', { owner: profile.id })).id, retained.id);
  await backend.tools.disconnect({ session_id: retained.id }, context());
  assert.equal(await call('find', { owner: profile.id }), null);
  console.log('RDP session tools passed: independent calls, timed input, cancellation, responsive disconnect, reused UI sessions and desktop close policy.');
} catch (error) {
  let message = String(error);
  for (const value of [config.host, config.username, config.password]) if (value) message = message.split(value).join('[redacted]');
  console.error('RDP session tool phase:', phase, message);
  process.exitCode = 1;
} finally {
  await backend.deactivate();
  await rm(dataDirectory, { recursive: true, force: true });
}
