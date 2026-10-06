import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const upstream = createRequire(resolve('.local/upstream/IronRDP/web-client/iron-remote-desktop/package.json'));
const { JSDOM } = upstream('jsdom');
const html = await readFile('src/ui/index.html', 'utf8');
const compiled = await build({
  entryPoints: ['src/ui/app.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'synthetic-rdp', setup(builder) {
    builder.onResolve({ filter: /iron-remote-desktop.*\.js$/ }, () => ({ path: 'rdp', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const init = async () => {}; export const Backend = {};' }));
  } }],
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'UI did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://rdp.invalid/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  const errors = [];
  const element = id => window.document.getElementById(id);
  const button = element('accept-certificate');
  const addListener = button.addEventListener.bind(button);
  button.addEventListener = (type, listener, settings) => addListener(type, event => {
    Promise.resolve(listener(event)).catch(error => errors.push(error));
  }, settings);
  let nextId = 0;
  let attempts = 0;
  window.anas = {
    getInfo: async () => ({ language: 'en', theme: 'dark', fontSize: 14 }),
    data: { get: options.get ?? (async () => null), set: options.set ?? (async () => {}) },
    backend: { call: async (method, params) => {
      calls.push({ method, params });
      if (method === 'create') return { id: String(++nextId), token: 'synthetic', proxy: 'ws://127.0.0.1:9/rdp' };
      if (method === 'status') return options.status?.(params) ?? { state: 'connection_failed', certificate: null };
      return null;
    } },
  };
  window.customElements.define('iron-remote-desktop', class extends window.HTMLElement {
    connectedCallback() {
      const config = new Proxy({}, { get: (_, key) => key === 'build' ? () => ({}) : () => config });
      const interaction = {
        setEnableClipboard() {}, setEnableAutoClipboard() {}, setVisibility() {}, shutdown() {},
        configBuilder: () => config,
        connect: async () => {
          attempts++;
          if (options.connect) return options.connect(attempts);
          return { run: () => new Promise(() => {}) };
        },
      };
      window.queueMicrotask(() => this.dispatchEvent(new window.CustomEvent('ready', { detail: { irgUserInteraction: interaction } })));
    }
  });
  await window.eval(`(async () => { ${compiled.outputFiles[0].text} })()`);
  element('host').value = 'test.invalid';
  element('username').value = 'fixture';
  return { window, element, calls, errors, submit: () => element('connection').dispatchEvent(new window.Event('submit', { cancelable: true })) };
}

test('a delayed failed connection cannot disconnect a newer session or display its certificate', async t => {
  const oldStatus = deferred();
  const ui = await fixture(t, {
    connect: attempt => attempt === 1 ? Promise.reject(new Error('synthetic failure')) : { run: () => new Promise(() => {}) },
    status: () => oldStatus.promise,
  });
  ui.submit();
  await until(() => ui.calls.some(call => call.method === 'status'));
  ui.element('disconnect').click();
  await until(() => !ui.element('connect').disabled);
  ui.submit();
  await until(() => ui.element('status').textContent === 'Connected');
  oldStatus.resolve({ state: 'certificate_required', certificate: { sha256: 'a'.repeat(64), trusted: false } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.element('status').textContent, 'Connected');
  assert.equal(ui.element('trust').hidden, true);
  assert.deepEqual(ui.calls.filter(call => call.method === 'disconnect').map(call => call.params.id), ['1']);
});

test('canceling while settings are saving does not start a connection helper later', async t => {
  const saved = deferred();
  const ui = await fixture(t, { set: () => saved.promise });
  ui.submit();
  ui.element('disconnect').click();
  saved.resolve();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.calls.filter(call => call.method === 'create').length, 0);
  assert.equal(ui.element('connect').disabled, false);
});

test('invalid saved certificate entries do not prevent startup', async t => {
  const ui = await fixture(t, { get: async key => key === 'certificate_trust' ? [null, 7, {}, {host:'test.invalid',port:3389,sha256:'invalid'}] : null });
  assert.equal(ui.element('error').hidden, true);
  assert.equal(ui.element('connect').disabled, false);
});

test('failed certificate persistence is visible and does not grant in-memory trust', async t => {
  let writes = 0;
  const ui = await fixture(t, {
    connect: () => Promise.reject(new Error('synthetic failure')),
    status: () => ({ state: 'certificate_required', certificate: { sha256: 'a'.repeat(64), trusted: false } }),
    set: async key => { if (key === 'certificate_trust') { writes++; throw new Error('synthetic disk failure'); } },
  });
  ui.submit();
  await until(() => !ui.element('trust').hidden && !ui.element('connect').disabled);
  ui.element('accept-certificate').click();
  await until(() => writes === 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(ui.errors.length, 0, 'Persistence rejection escaped the UI');
  assert.equal(ui.element('error').hidden, false);
  assert.match(ui.element('error').textContent, /save.*certificate|certificate.*save/i);
  ui.submit();
  await until(() => ui.calls.filter(call => call.method === 'create').length === 2);
  assert.equal(ui.calls.filter(call => call.method === 'create')[1].params.trustedSha256, undefined);
});
