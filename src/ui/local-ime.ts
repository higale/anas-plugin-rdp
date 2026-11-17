import keyCodes from '../key-codes.json';

/** A native editable surface for local composition; only committed text leaves the page. */
export class LocalIme {
  readonly element = document.createElement('textarea');
  enabled = false;
  private composing = false;
  private active = false;
  private sentKeys = new Set<string>();
  private abort = new AbortController();
  private readonly mac = /Mac/.test(navigator.platform);
  constructor(private container: HTMLElement, private send: (value: Record<string, unknown>) => boolean) {
    const input = this.element, options = { signal: this.abort.signal };
    input.className = 'local-ime';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', 'Local input method');
    input.tabIndex = -1;
    input.hidden = true;
    container.append(input);
    input.addEventListener('compositionstart', () => {
      if (!this.active) return;
      this.composing = true;
      this.releaseKeys();
      input.classList.add('composing');
    }, options);
    // Chromium updates the editable value before compositionend. Clearing it here
    // also makes a trailing non-composing input event harmless (no duplicate commit).
    input.addEventListener('compositionend', event => {
      const accept = this.active && this.composing;
      this.composing = false;
      input.classList.remove('composing');
      input.value = '';
      if (accept) this.commit(event.data);
    }, options);
    input.addEventListener('input', event => {
      if (this.composing || (event as InputEvent).isComposing) return;
      const value = input.value;
      input.value = '';
      if (this.active) this.commit(value);
    }, options);
    input.addEventListener('keydown', event => this.key(event, true), options);
    input.addEventListener('keyup', event => this.key(event, false), options);
    input.addEventListener('blur', () => this.reset(), options);
  }
  setEnabled(enabled: boolean, label: string) {
    if (this.enabled !== enabled) this.reset();
    this.enabled = enabled;
    this.element.hidden = !enabled;
    this.element.setAttribute('aria-label', label);
  }
  focus(event?: MouseEvent) {
    if (!this.enabled) return;
    if (this.composing) this.reset();
    if (event) {
      const bounds = this.container.getBoundingClientRect();
      // No remote caret information is available. Anchor the OS candidate window
      // at the last click, leaving room for the local preedit line inside the view.
      this.element.style.left = `${Math.max(0, Math.min(event.clientX - bounds.left, bounds.width - 220))}px`;
      this.element.style.top = `${Math.max(0, Math.min(event.clientY - bounds.top, bounds.height - 40))}px`;
    }
    this.active = true;
    this.element.focus({ preventScroll: true });
  }
  syncModifiers(event: MouseEvent | KeyboardEvent) {
    for (const [code, down] of [['ControlLeft', event.ctrlKey], ['AltLeft', event.altKey], ['ShiftLeft', event.shiftKey], ['MetaLeft', event.metaKey]] as const) {
      if (down !== this.sentKeys.has(code)) this.remoteKey(code, down);
    }
  }
  private remoteKey(code: string, down: boolean) {
    const scan = (keyCodes as Record<string, number>)[code];
    if (scan === undefined) return;
    if (this.send({ type: 'key', code: scan & 255, extended: scan > 255, down })) {
      if (down) this.sentKeys.add(code); else this.sentKeys.delete(code);
    }
  }
  private key(event: KeyboardEvent, down: boolean) {
    if (!this.active) { event.preventDefault(); return; }
    // Never forward candidate selection/cancellation keys, including Chromium's
    // initial/final 229 event when isComposing has not yet/has already changed.
    if (this.composing || event.isComposing || event.keyCode === 229) {
      // Let the IME handle selection/cancellation, but do not expose its keys to
      // the host's unhandled-Escape shortcut when native composition flags lag.
      event.stopPropagation();
      if (!down && this.sentKeys.has(event.code)) this.remoteKey(event.code, false);
      return;
    }
    if (!down && this.sentKeys.has(event.code)) { event.preventDefault(); this.remoteKey(event.code, false); return; }
    const modifier = /^(Control|Alt|Shift|Meta)/.test(event.code);
    if (modifier) {
      // Defer modifier downs so local IME switching never toggles the remote IME.
      if (!down) {
        for (const [code, held] of [['ControlLeft', event.ctrlKey], ['AltLeft', event.altKey], ['ShiftLeft', event.shiftKey], ['MetaLeft', event.metaKey]] as const) {
          if (!held && this.sentKeys.has(code)) this.remoteKey(code, false);
        }
      }
      return;
    }
    if (event.code === 'CapsLock' || (event.code === 'Space' && (event.ctrlKey || event.metaKey))) return;
    const shortcut = event.metaKey || (event.ctrlKey && !event.getModifierState('AltGraph')) || (!this.mac && event.altKey && !event.getModifierState('AltGraph'));
    if (!shortcut && (Array.from(event.key).length === 1 || event.key === 'Dead' || event.key === 'Process')) return;
    event.preventDefault();
    if (down) { this.syncModifiers(event); this.remoteKey(event.code, true); }
    else if (this.sentKeys.has(event.code)) this.remoteKey(event.code, false);
  }
  private commit(text: string) {
    if (!text) return;
    this.releaseKeys();
    this.send({ type: 'text', text });
  }
  private releaseKeys() {
    for (const code of [...this.sentKeys]) this.remoteKey(code, false);
    this.sentKeys.clear();
  }
  reset() {
    this.active = false; // Reject late compositionend/input after lock, handoff or blur.
    this.composing = false;
    this.releaseKeys();
    this.element.blur();
    this.element.value = '';
    this.element.classList.remove('composing');
  }
  dispose() { this.reset(); this.abort.abort(); this.element.remove(); }
}
