import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/ui/adaptive-resolution.ts'], bundle: true, write: false, format: 'iife', globalName: 'ResolutionControl' });
function fixture(apply) {
  let time = 0, serial = 0, resized, available = true;
  const timers = new Map(), bounds = { width: 1200, height: 800 };
  const api = runInNewContext(compiled.outputFiles[0].text + ';ResolutionControl', {
    ResizeObserver: class { constructor(callback) { resized = callback; } observe() {} disconnect() { resized = () => {}; } },
    setTimeout(callback, delay) { timers.set(++serial, { callback, at: time + delay }); return serial; }, clearTimeout(id) { timers.delete(id); }
  });
  const calls = [], control = new api.AdaptiveResolution({ getBoundingClientRect: () => bounds }, async (size, current) => {
    calls.push({ width: size.width, height: size.height }); return apply ? apply(size, current) : true;
  }, () => available ? bounds : undefined);
  return { control, calls, api, resize(width, height) { Object.assign(bounds, { width, height }); resized(); },
    measurementAvailable(value) { available = value; resized(); },
    async advance(ms) { time += ms; for (const [id, entry] of timers) if (entry.at <= time) { timers.delete(id); entry.callback(); } for (let i=0;i<6;i++) await Promise.resolve(); } };
}
test('adaptive sizes use the viewport without the saved resolution as a lower bound; protocol limits remain valid', async () => {
  const f = fixture(); f.control.update(true);
  f.resize(351, 600); await f.advance(299); assert.equal(f.calls.length, 0);
  f.resize(401, 700); await f.advance(300); assert.deepEqual(f.calls, [{ width: 400, height: 700 }]);
  f.control.refresh(); await f.advance(300); assert.equal(f.calls.length, 1);
  for (const [w,h] of [[10,10],[8192,8192],[10000,5000]]) {
    const size=f.api.viewportResolution(w,h); assert.ok(size.width >= 200 && size.height >= 200);
    assert.ok(size.width % 2 === 0 && size.width * size.height <= 16777216);
  }
  assert.equal(f.api.viewportResolution(0,800), undefined);
});
test('disabling adaptation retains the remote size and cancels pending work', async () => {
  const f=fixture(); f.control.update(false); await f.advance(500); assert.equal(f.calls.length,0);
  f.control.update(true); await f.advance(300);
  f.control.update(false); f.resize(800,600); await f.advance(300);
  assert.deepEqual(f.calls,[{width:1200,height:800}]);
  f.control.update(true); f.control.suspend(); await f.advance(500); assert.equal(f.calls.length,1);
  f.control.dispose(); f.resize(1400,900); await f.advance(500); assert.equal(f.calls.length,1);
});
test('an in-flight context lookup is invalidated by a newer viewport and is not restarted by identical updates', async () => {
  const pending=[]; const f=fixture((size,current)=>new Promise(resolve=>pending.push({current,resolve})));
  f.control.update(true); await f.advance(300);
  for(let i=0;i<5;i++) f.control.refresh(); await f.advance(500);
  assert.equal(f.calls.length,1); assert.equal(pending[0].current(),true);
  f.resize(1400,900); assert.equal(pending[0].current(),false); pending[0].resolve(false); await f.advance(300);
  assert.equal(f.calls.length,2); f.control.suspend(); assert.equal(pending[1].current(),false); pending[1].resolve(false);
});

test('returning to the previous size still sends a new request while the intermediate resize is in flight', async () => {
  const pending=[]; let block=false;
  const f=fixture((size,current)=>block?new Promise(resolve=>pending.push({current,resolve})):Promise.resolve(true));
  f.control.update(true); await f.advance(300);
  block=true; f.resize(1400,900); await f.advance(300);
  f.resize(1200,800); await f.advance(300);
  assert.deepEqual(f.calls,[{width:1200,height:800},{width:1400,height:900},{width:1200,height:800}]);
  assert.equal(pending[0].current(),false); assert.equal(pending[1].current(),true);
  pending[0].resolve(false); await f.advance(1); f.control.refresh(); await f.advance(500);
  assert.equal(f.calls.length,3,'The old completion cannot reset the new in-flight request');
  pending[1].resolve(true); await f.advance(1); f.control.refresh(); await f.advance(500); assert.equal(f.calls.length,3);
});

test('manual selection cancels pending adaptation, persists through refresh and yields to the next viewport change', async () => {
  const f = fixture();
  f.control.update(true);
  assert.equal(await f.control.request({ width: 1536, height: 864 }), true);
  f.control.refresh(); await f.advance(500);
  assert.deepEqual(f.calls, [{ width: 1536, height: 864 }]);
  f.resize(1400, 900); await f.advance(300);
  assert.deepEqual(f.calls.at(-1), { width: 1400, height: 900 });
});

test('manual selection works without adaptation and suspension invalidates its pending context lookup', async () => {
  let finish, valid;
  const f = fixture((_size, current) => new Promise(resolve => { finish = resolve; valid = current; }));
  f.control.update(false);
  const request = f.control.request({ width: 1536, height: 864 });
  f.control.refresh(); assert.equal(valid(), true);
  f.control.suspend(); assert.equal(valid(), false);
  finish(false); assert.equal(await request, false);
  await f.advance(500); assert.equal(f.calls.length, 1);
});

test('an unsettled iframe cannot dispatch a resize or erase the last applied size', async () => {
  const f = fixture(); f.control.update(true); await f.advance(300);
  f.measurementAvailable(false); f.resize(600, 400); await f.advance(1000);
  assert.deepEqual(f.calls, [{ width: 1200, height: 800 }]);
  f.resize(1200, 800); f.measurementAvailable(true); await f.advance(1000);
  assert.equal(f.calls.length, 1, 'Returning from a DPI transition needs no remote resize');
  f.resize(1400, 900); await f.advance(300);
  assert.deepEqual(f.calls.at(-1), { width: 1400, height: 900 });
});
