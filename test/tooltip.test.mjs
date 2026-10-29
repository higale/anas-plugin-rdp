import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const compiled = await build({ entryPoints: ['src/ui/tooltip.ts'], bundle: true, write: false, format: 'iife', globalName: 'Tooltips' });
function fixture(t) {
  const dom = new JSDOM('<section><button data-tooltip="Reset input" aria-describedby="help"><img></button><button data-tooltip="Disconnect" disabled></button></section><span id="help">Help</span>', { runScripts: 'outside-only' });
  const { window } = dom, document = window.document;
  let now = 0, id = 0;
  const timers = new Map();
  window.setTimeout = (run, delay) => { timers.set(++id, { at: now + delay, run }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.innerWidth = 320; window.innerHeight = 200;
  window.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden], [inert]') ? [] : [this.getBoundingClientRect()]; };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.getAttribute('role') === 'tooltip' ? new window.DOMRect(0, 0, 180, 30) : new window.DOMRect(280, 10, 32, 32);
  };
  window.eval(compiled.outputFiles[0].text + '\nwindow.disposeTooltips = Tooltips.installTooltips();');
  const [first, second] = document.querySelectorAll('button'), icon = first.querySelector('img');
  const pointer = (element, type, relatedTarget = null) => element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, relatedTarget }));
  const advance = ms => { now += ms; for (const [key, timer] of timers) if (timer.at <= now) { timers.delete(key); timer.run(); } };
  const tip = () => document.querySelector('[role=tooltip]');
  t.after(() => { window.disposeTooltips(); window.close(); });
  return { window, document, first, second, icon, pointer, advance, tip };
}

test('hover waits, survives icon transitions, switches buttons and stays within the iframe', t => {
  const ui = fixture(t);
  ui.pointer(ui.first, 'pointerover'); ui.advance(300);
  assert.equal(ui.tip(), null);
  ui.pointer(ui.first, 'pointerout', ui.icon); ui.pointer(ui.icon, 'pointerover', ui.first);
  ui.advance(150);
  assert.equal(ui.tip().textContent, 'Reset input', 'Internal movement must not restart the delay');
  assert.equal(ui.tip().style.left, '132px', 'Keep the tooltip inside the right edge');
  assert.equal(ui.tip().style.top, '49px', 'Flip below a toolbar at the top edge');
  assert.equal(ui.first.getAttribute('aria-describedby'), 'help rdp-tooltip');
  ui.pointer(ui.icon, 'pointerout', ui.second); ui.pointer(ui.second, 'pointerover', ui.icon);
  assert.equal(ui.tip(), null);
  assert.equal(ui.first.getAttribute('aria-describedby'), 'help');
  ui.advance(450);
  assert.equal(ui.tip().textContent, 'Disconnect', 'Disabled controls can still explain their action');
  ui.pointer(ui.second, 'pointerout'); ui.advance(1000);
  assert.equal(ui.tip(), null);
});

test('focus shows immediately, content updates in place, and hidden or removed targets close the tooltip', async t => {
  const ui = fixture(t);
  ui.first.focus();
  const tooltip = ui.tip();
  assert.equal(tooltip.textContent, 'Reset input');
  ui.first.dataset.tooltip = '重置输入\n释放按键';
  await Promise.resolve();
  assert.equal(ui.tip(), tooltip);
  assert.equal(tooltip.textContent, '重置输入\n释放按键');
  ui.first.click();
  assert.equal(ui.tip(), null, 'Click dismisses a tooltip even if mouse focus showed it after pointerdown');
  ui.pointer(ui.first, 'pointerover'); ui.advance(450);
  ui.first.parentElement.hidden = true;
  await Promise.resolve();
  assert.equal(ui.tip(), null);
  ui.first.parentElement.hidden = false;
  ui.pointer(ui.first, 'pointerover'); ui.advance(450);
  assert.ok(ui.tip());
  ui.first.remove(); await Promise.resolve();
  assert.equal(ui.tip(), null);
});

for (const event of ['pointerdown', 'contextmenu', 'Escape', 'scroll', 'blur', 'resize', 'dispose']) {
  test(`${event} dismisses both pending and visible tooltips`, t => {
    for (const delay of [200, 450]) {
      const ui = fixture(t);
      ui.pointer(ui.first, 'pointerover'); ui.advance(delay);
      if (event === 'dispose') ui.window.disposeTooltips();
      else if (event === 'Escape') ui.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape' }));
      else (['blur', 'resize'].includes(event) ? ui.window : ui.document).dispatchEvent(new ui.window.Event(event));
      ui.advance(1000);
      assert.equal(ui.tip(), null);
      assert.equal(ui.first.getAttribute('aria-describedby'), 'help');
    }
  });
}
