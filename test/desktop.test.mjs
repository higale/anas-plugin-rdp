import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/ui/desktop.ts'], bundle: true, write: false, format: 'iife', globalName: 'RdpDesktop' });

function cursorFixture(t, { disableMouseAnimation = false, reducedMotion = false } = {}) {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  const { window } = dom;
  const sent = [], draws = [], resizeErrors = [], capabilities = [];
  let socket, resized, time = 0, nextFrame = 0;
  const frames = new Map();
  window.performance.now = () => time;
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.matchMedia = () => ({ matches: reducedMotion });
  window.ResizeObserver = class { constructor(callback) { resized = callback; } observe() {} disconnect() {} };
  window.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  window.HTMLCanvasElement.prototype.getContext = function () { return { putImageData: image => draws.push({ canvas: this, image }) }; };
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,fixture';
  window.HTMLCanvasElement.prototype.hasPointerCapture = () => false;
  window.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    constructor() { socket = this; }
    send(value) { sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  };
  window.eval(compiled.outputFiles[0].text + '\nwindow.RdpDesktop = RdpDesktop;');
  const desktop = new window.RdpDesktop.Desktop(window.document.querySelector('main'), { url: 'ws://test.invalid', token: 'fixture', pageId: 'page' }, () => {}, undefined, undefined, disableMouseAnimation, error => resizeErrors.push(error), supported => capabilities.push(supported));
  let bounds = { left: 10, top: 20, width: 200, height: 100 };
  desktop.canvas.getBoundingClientRect = () => bounds;
  const shape = { kind: 'bitmap', width: 2, height: 2, x: 1, y: 1, pixels: [255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255] };
  const snapshot = (fields = {}) => socket.onmessage({ data: JSON.stringify({ type: 'snapshot', revision: 1, state: 'connected', owner: 'page', epoch: 1,
    uiLocked: false, uiRevision: 0, image: false, cursorPosition: { x: 30, y: 40 }, cursorAnimate: false, mouseSequence: 0, ...fields }) });
  snapshot({ cursor: shape, cursorPosition: null, image: true });
  const image = new ArrayBuffer(8 + 100 * 100 * 4), header = new DataView(image);
  header.setUint32(0, 100, true); header.setUint32(4, 100, true);
  socket.onmessage({ data: image });
  socket.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  const move = (x, y) => desktop.canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y }));
  const layer = window.document.querySelector('.remote-cursor-layer'), icon = layer.querySelector('img');
  t.after(() => { desktop.dispose(); window.close(); });
  return { window, desktop, snapshot, move, sent, draws, shape, layer, icon, resizeErrors, capabilities,
    advance(ms) { time += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); },
    animations: () => frames.size, close: () => socket.onclose(), resize: value => { bounds = value; resized(); } };
}

test('remote cursor uses an independent clipped layer, hotspot and desktop scale, including while input is locked', t => {
  const ui = cursorFixture(t);
  assert.equal(ui.layer.hidden, true, 'Unknown position must not invent a cursor location');
  const frames = ui.draws.length;
  ui.snapshot();
  assert.equal(ui.layer.hidden, false);
  assert.equal(ui.layer.style.left, '60px', 'Center the 100px desktop within the 200px canvas');
  assert.equal(ui.icon.style.left, '29px');
  assert.equal(ui.icon.style.top, '39px');
  assert.equal(ui.draws.length, frames, 'Movement must reuse the cursor bitmap and not redraw the desktop');
  ui.resize({ left: 10, top: 20, width: 50, height: 100 });
  assert.equal(ui.layer.style.top, '45px');
  assert.equal(ui.layer.style.height, '50px');
  assert.equal(ui.icon.style.left, '14.5px');
  assert.equal(ui.icon.style.width, '1px');
  ui.snapshot({ uiLocked: true, uiRevision: 1, cursorPosition: { x: 0, y: 0 } });
  assert.equal(ui.icon.style.left, '-0.5px', 'The layer clips the cursor at the desktop edge');
  ui.move(30, 60);
  assert.equal(ui.sent.some(message => message.type === 'mouse'), false);
  assert.equal(ui.desktop.canvas.style.cursor, 'not-allowed');
  assert.equal(ui.layer.hidden, false);
  ui.snapshot({ cursor: { kind: 'hidden' } });
  assert.equal(ui.layer.hidden, true);
  ui.snapshot({ cursor: ui.shape });
  assert.equal(ui.layer.hidden, false);
  ui.desktop.dispose();
  assert.equal(ui.window.document.querySelector('.remote-cursor-layer'), null);
});

test('local motion predicts immediately, ignores stale echoes after leaving, and accepts later remote moves', t => {
  const ui = cursorFixture(t);
  ui.snapshot();
  ui.move(90, 60);
  assert.equal(ui.icon.style.left, '29px');
  assert.equal(ui.desktop.canvas.style.cursor, 'none');
  assert.equal(ui.sent.at(-1).mouseSequence, 1);
  ui.move(100, 70);
  assert.equal(ui.icon.style.left, '39px');
  assert.equal(ui.sent.at(-1).mouseSequence, 2);
  ui.desktop.canvas.dispatchEvent(new ui.window.MouseEvent('pointerleave'));
  assert.equal(ui.desktop.canvas.style.cursor, 'default');
  const messages = ui.sent.length;
  ui.move(20, 70); // Letterbox, not part of the remote desktop.
  assert.equal(ui.sent.length, messages);
  ui.snapshot({ cursorPosition: { x: 30, y: 40 }, mouseSequence: 1 });
  assert.equal(ui.icon.style.left, '39px', 'Late echoes must not move the cursor backwards');
  ui.snapshot({ cursorPosition: { x: 40, y: 50 }, mouseSequence: 2 });
  ui.snapshot({ cursorPosition: { x: 60, y: 70 }, mouseSequence: 2 });
  assert.equal(ui.icon.style.left, '59px', 'Tool/server movement is shown after the local events are accepted');
  ui.move(80, 50);
  ui.snapshot({ uiLocked: true, uiRevision: 1, cursorPosition: { x: 70, y: 80 }, mouseSequence: 2 });
  assert.equal(ui.icon.style.left, '69px', 'A rejected local event must not block remote updates after locking');
});

test('tool movement animates only the overlay, coalesces new targets and never delays acknowledgements or sends input', t => {
  const ui = cursorFixture(t);
  ui.snapshot({ cursorAnimate: true });
  assert.equal(ui.animations(), 0, 'First known position does not fly in from an invented origin');
  const frames = ui.draws.length, sent = ui.sent.length;
  ui.snapshot({ revision: 2, cursorAnimate: true, cursorPosition: { x: 90, y: 40 } });
  assert.equal(ui.sent.length, sent + 1);
  assert.equal(ui.sent.at(-1).type, 'ack', 'Display acknowledgement does not wait for animation');
  assert.equal(ui.sent.at(-1).revision, 2);
  assert.equal(ui.icon.style.left, '29px');
  ui.advance(30);
  const halfway = Number.parseFloat(ui.icon.style.left);
  assert.ok(halfway > 29 && halfway < 89);
  ui.snapshot({ cursorAnimate: true, cursorPosition: { x: 0, y: 90 } });
  assert.equal(Number.parseFloat(ui.icon.style.left), halfway, 'A new target continues from the currently drawn position');
  assert.equal(ui.animations(), 1, 'New movement replaces the prior animation');
  ui.advance(30);
  ui.snapshot({ cursorAnimate: true, cursorPosition: { x: 0, y: 90 }, cursor: ui.shape });
  ui.advance(65);
  assert.equal(ui.animations(), 0, 'Repeated coordinates/shape changes do not restart animation');
  assert.equal(ui.icon.style.left, '-1px');
  assert.equal(ui.icon.style.top, '89px');
  assert.equal(ui.draws.length, frames + 1, 'Only the explicit shape update rasterizes a bitmap');
  assert.equal(ui.sent.some(message => message.type === 'mouse'), false, 'Visual interpolation sends no remote mouse events');
});

test('clicks, manual input, hidden positions and disposal cancel cursor animation', t => {
  const ui = cursorFixture(t);
  ui.snapshot();
  const target = { x: 90, y: 40 };
  ui.snapshot({ cursorAnimate: true, cursorPosition: target });
  ui.advance(20);
  ui.snapshot({ cursorPosition: target }); // A click at the target is an immediate update.
  assert.equal(ui.animations(), 0);
  assert.equal(ui.icon.style.left, '89px');
  ui.snapshot({ cursorAnimate: true, cursorPosition: { x: 10, y: 20 } });
  ui.advance(20);
  ui.move(100, 70);
  assert.equal(ui.animations(), 0);
  assert.equal(ui.icon.style.left, '39px');
  assert.equal(ui.sent.at(-1).x, 40, 'Manual input still sends the actual coordinate once');
  ui.advance(200);
  assert.equal(ui.icon.style.left, '39px', 'Canceled animation cannot overwrite local input');
  ui.snapshot({ cursorAnimate: true, cursorPosition: target, mouseSequence: 1, uiLocked: true, uiRevision: 1 });
  ui.advance(20);
  assert.ok(Number.parseFloat(ui.icon.style.left) > 39, 'Animation remains visible while UI input is locked');
  ui.snapshot({ cursorAnimate: true, cursorPosition: target, cursor: { kind: 'hidden' }, mouseSequence: 1 });
  assert.equal(ui.animations(), 0);
  assert.equal(ui.layer.hidden, true);
  ui.snapshot({ cursorAnimate: true, cursor: ui.shape, cursorPosition: null, mouseSequence: 1 });
  assert.equal(ui.layer.hidden, true);
  ui.snapshot({ cursorAnimate: true, mouseSequence: 1 });
  assert.equal(ui.animations(), 0, 'An unknown position is not an animation origin');
  ui.snapshot({ cursorAnimate: true, cursorPosition: target, mouseSequence: 1 });
  assert.equal(ui.animations(), 1);
  ui.close();
  assert.equal(ui.animations(), 0);
  assert.equal(ui.layer.hidden, true);
  ui.desktop.dispose();
  ui.advance(200);
  assert.equal(ui.window.document.querySelector('.remote-cursor-layer'), null);
});

for (const options of [{ disableMouseAnimation: true }, { reducedMotion: true }]) test('disabled cursor animation jumps directly without affecting input: ' + JSON.stringify(options), t => {
  const ui = cursorFixture(t, options);
  ui.snapshot();
  ui.snapshot({ cursorAnimate: true, cursorPosition: { x: 90, y: 40 } });
  assert.equal(ui.icon.style.left, '89px');
  assert.equal(ui.animations(), 0);
  ui.move(100, 70);
  assert.equal(ui.icon.style.left, '39px');
  assert.equal(ui.sent.at(-1).x, 40);
});

test('native receipts immediately gate input and stale snapshots or receipts cannot roll back a newer lock', async t => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.ResizeObserver = class { observe() {} disconnect() {} };
  const messages = [], states = [];
  let socket;
  window.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    constructor() { socket = this; }
    send(value) { messages.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  };
  window.eval(compiled.outputFiles[0].text + '\nwindow.RdpDesktop = RdpDesktop;');
  const desktop = new window.RdpDesktop.Desktop(window.document.querySelector('main'), { url: 'ws://test.invalid', token: 'fixture', pageId: 'page' },
    (state, locked) => states.push({ state, locked }));
  t.after(() => { desktop.dispose(); window.close(); });
  const snapshot = (locked, revision) => socket.onmessage({ data: JSON.stringify({ type: 'snapshot', revision, state: 'connected',
    owner: 'page', epoch: 1, uiLocked: locked, uiRevision: revision, image: false, cursor: { kind: 'hidden' }, cursorPosition: null, cursorAnimate: false, mouseSequence: 0 }) });
  const key = () => desktop.canvas.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'ShiftLeft', cancelable: true }));
  snapshot(false, 0);
  socket.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  await desktop.ready;
  desktop.updateInputLock(true, 1);
  assert.equal(states.at(-1).locked, true);
  snapshot(false, 0); // Frame sent before the lock's RPC acknowledgement.
  key();
  assert.equal(states.at(-1).locked, true);
  assert.equal(messages.some(message => message.type === 'key'), false);
  desktop.updateInputLock(false, 2);
  key();
  assert.equal(states.at(-1).locked, false);
  assert.equal(messages.at(-1).type, 'key');
  assert.equal(messages.at(-1).uiRevision, 2);
  snapshot(true, 3); // Another tool changed the state before an older receipt arrived.
  desktop.updateInputLock(false, 2);
  const before = messages.length;
  key();
  assert.equal(states.at(-1).locked, true);
  assert.equal(messages.length, before);
});

test('desktop reports validated actual frame dimensions and ignores repeated sizes', t => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.ResizeObserver = class { observe() {} disconnect() {} };
  const sizes = [];
  let socket;
  window.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    constructor() { socket = this; }
    send() {}
    close() { this.readyState = 3; }
  };
  window.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  window.HTMLCanvasElement.prototype.getContext = () => ({ putImageData() {} });
  window.eval(compiled.outputFiles[0].text + '\nwindow.RdpDesktop = RdpDesktop;');
  const desktop = new window.RdpDesktop.Desktop(window.document.querySelector('main'), { url: 'ws://test.invalid', token: 'fixture', pageId: 'page' },
    () => {}, () => sizes.push({ ...desktop.size }));
  void desktop.ready.catch(() => {});
  t.after(() => { desktop.dispose(); window.close(); });
  assert.equal(desktop.size, undefined, 'Canvas defaults are not an actual remote frame');
  let revision = 0;
  const frame = (width, height) => {
    socket.onmessage({ data: JSON.stringify({ type: 'snapshot', revision: ++revision, state: 'connected', owner: 'page', epoch: 1,
      uiLocked: false, uiRevision: 0, image: true, cursor: { kind: 'hidden' }, cursorPosition: null, cursorAnimate: false, mouseSequence: 0 }) });
    const bytes = new ArrayBuffer(8 + width * height * 4), header = new DataView(bytes);
    header.setUint32(0, width, true); header.setUint32(4, height, true);
    socket.onmessage({ data: bytes });
  };
  frame(1024, 768); frame(1024, 768); frame(1280, 800);
  assert.deepEqual(sizes, [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]);
  assert.equal(desktop.canvas.width, 1280); assert.equal(desktop.canvas.height, 800);
});

test('a rejected resize is reported without discarding the display or its input lease', t => {
  const ui=cursorFixture(t);
  ui.snapshot({resizeError:'RDP_RESIZE_UNSUPPORTED'});
  assert.deepEqual(ui.resizeErrors,['RDP_RESIZE_UNSUPPORTED']);
  assert.equal(ui.desktop.available,true); assert.equal(ui.desktop.resizeEpoch,1);
  assert.equal(ui.desktop.canvas.width,100);
  ui.snapshot({owner:'new-page',epoch:2}); assert.equal(ui.desktop.resizeEpoch,undefined);
});


test('display capability snapshots update independently of frames and are restored on a new display', t => {
  const ui = cursorFixture(t);
  ui.snapshot({resizeSupported:false});
  const frames = ui.draws.length;
  ui.snapshot({resizeSupported:true}); ui.snapshot({resizeSupported:true});
  assert.deepEqual(ui.capabilities,[false,true]);
  assert.equal(ui.draws.length,frames);
  const restored = cursorFixture(t); restored.snapshot({resizeSupported:true});
  assert.deepEqual(restored.capabilities,[true]);
});
