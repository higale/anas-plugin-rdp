import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/ui/desktop.ts'], bundle: true, write: false, format: 'iife', globalName: 'RdpDesktop' });

test('native receipts immediately gate input and stale snapshots or receipts cannot roll back a newer lock', async t => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
  const { window } = dom;
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
    owner: 'page', epoch: 1, uiLocked: locked, uiRevision: revision, image: false, cursor: { kind: 'default' } }) });
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
      uiLocked: false, uiRevision: 0, image: true, cursor: { kind: 'default' } }) });
    const bytes = new ArrayBuffer(8 + width * height * 4), header = new DataView(bytes);
    header.setUint32(0, width, true); header.setUint32(4, height, true);
    socket.onmessage({ data: bytes });
  };
  frame(1024, 768); frame(1024, 768); frame(1280, 800);
  assert.deepEqual(sizes, [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]);
  assert.equal(desktop.canvas.width, 1280); assert.equal(desktop.canvas.height, 800);
});
