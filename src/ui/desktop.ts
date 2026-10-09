export interface DisplayConnection { url: string; token: string; pageId: string }
interface Snapshot { type: 'snapshot'; revision: number; state: string; owner: string | null; epoch: number; image: boolean; cursor: { kind: string; width?: number; height?: number; x?: number; y?: number; pixels?: number[] } }

/** Owns only a display attachment. dispose() never disconnects the RDP resource. */
export class Desktop {
  readonly canvas = document.createElement('canvas');
  private socket: WebSocket;
  private abort = new AbortController();
  private metadata?: Snapshot;
  private epoch = 0;
  private controlling = false;
  private settled = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready: Promise<void>;
  private timer: ReturnType<typeof setTimeout>;
  constructor(container: HTMLElement, connection: DisplayConnection, private onState: (state: string) => void) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Remote desktop');
    this.canvas.style.cssText = 'display:block;max-width:100%;max-height:100%;object-fit:contain;outline:none';
    container.append(this.canvas);
    this.socket = new WebSocket(connection.url, ['anas-rdp', connection.token, connection.pageId]);
    this.socket.binaryType = 'arraybuffer';
    this.timer = setTimeout(() => this.fail(new Error('RDP_DISPLAY_TIMEOUT')), 35000);
    this.socket.onmessage = event => {
      try {
        if (typeof event.data === 'string') {
          const metadata = JSON.parse(event.data) as Snapshot;
          if ((metadata.type as string) === 'ready') {
            if (!this.settled) { this.settled = true; clearTimeout(this.timer); this.resolveReady(); }
            return;
          }
          if (metadata.type !== 'snapshot' || !Number.isSafeInteger(metadata.revision)) throw new Error('RDP_DISPLAY_PROTOCOL');
          this.metadata = metadata;
          this.controlling = metadata.owner === connection.pageId;
          this.epoch = metadata.epoch;
          this.onState(metadata.state);
          this.updateCursor(metadata.cursor);
          if (['closed', 'connection_failed', 'certificate_required'].includes(metadata.state)) {
            this.fail(new Error(metadata.state)); return;
          }
          if (!metadata.image) this.ack(metadata.revision);
        } else {
          const data = event.data as ArrayBuffer;
          const metadata = this.metadata;
          if (!metadata?.image || data.byteLength < 8) throw new Error('RDP_DISPLAY_PROTOCOL');
          const header = new DataView(data);
          const width = header.getUint32(0, true), height = header.getUint32(4, true);
          if (!width || !height || width * height > 16 * 1024 * 1024 || data.byteLength !== 8 + width * height * 4) throw new Error('RDP_DISPLAY_PROTOCOL');
          if (this.canvas.width !== width) this.canvas.width = width;
          if (this.canvas.height !== height) this.canvas.height = height;
          this.canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data, 8), width, height), 0, 0);
          this.ack(metadata.revision);
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error('RDP_DISPLAY_PROTOCOL')); }
    };
    this.socket.onerror = () => this.fail(new Error('RDP_DISPLAY_CONNECTION'));
    this.socket.onclose = () => this.fail(new Error('RDP_DISPLAY_CLOSED'));
    const options = { signal: this.abort.signal };
    const mouse = (event: MouseEvent, flags: number, wheel = 0) => {
      const bounds = this.canvas.getBoundingClientRect();
      const scale = Math.min(bounds.width / this.canvas.width, bounds.height / this.canvas.height);
      const left = bounds.left + (bounds.width - this.canvas.width * scale) / 2;
      const top = bounds.top + (bounds.height - this.canvas.height * scale) / 2;
      this.input({ type: 'mouse', flags, wheel, x: Math.max(0, Math.min(this.canvas.width - 1, Math.round((event.clientX - left) / scale))),
        y: Math.max(0, Math.min(this.canvas.height - 1, Math.round((event.clientY - top) / scale))) });
    };
    this.canvas.addEventListener('pointerdown', event => {
      if (!this.controlling) return;
      event.preventDefault(); this.canvas.focus(); this.canvas.setPointerCapture(event.pointerId);
      mouse(event, (buttons[event.button] ?? 0) | 0x8000);
    }, options);
    this.canvas.addEventListener('pointermove', event => mouse(event, 0x0800), options);
    this.canvas.addEventListener('pointerup', event => {
      mouse(event, buttons[event.button] ?? 0);
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    }, options);
    this.canvas.addEventListener('pointercancel', () => this.release(), options);
    this.canvas.addEventListener('contextmenu', event => event.preventDefault(), options);
    this.canvas.addEventListener('wheel', event => { if (!this.controlling) return; event.preventDefault(); mouse(event, 0x0200, Math.sign(-event.deltaY) * 120); }, { ...options, passive: false });
    const key = (event: KeyboardEvent, down: boolean) => {
      if (!this.controlling || event.isComposing) return;
      const code = codes[event.code];
      if (code === undefined) return;
      event.preventDefault();
      this.input({ type: 'key', code: code & 255, extended: code > 255, down });
    };
    this.canvas.addEventListener('keydown', event => key(event, true), options);
    this.canvas.addEventListener('keyup', event => key(event, false), options);
    this.canvas.addEventListener('blur', () => this.release(), options);
    window.addEventListener('blur', () => this.release(), options);
  }
  private ack(revision: number) { this.socket.send(JSON.stringify({ type: 'ack', revision })); }
  private input(message: Record<string, unknown>) {
    if (this.controlling && this.socket.readyState === WebSocket.OPEN) {
      if (this.socket.bufferedAmount >= 8192) { this.fail(new Error('RDP_INPUT_BACKPRESSURE')); return; }
      this.socket.send(JSON.stringify({ ...message, epoch: this.epoch }));
    }
  }
  private updateCursor(cursor: Snapshot['cursor']) {
    if (cursor.kind !== 'bitmap') { this.canvas.style.cursor = cursor.kind === 'hidden' ? 'none' : 'default'; return; }
    if (!cursor.width || !cursor.height || cursor.width > 512 || cursor.height > 512 || cursor.pixels?.length !== cursor.width * cursor.height * 4) return;
    const image = document.createElement('canvas');
    image.width = cursor.width; image.height = cursor.height;
    image.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(cursor.pixels), image.width, image.height), 0, 0);
    this.canvas.style.cursor = 'url("' + image.toDataURL() + '") ' + (cursor.x ?? 0) + ' ' + (cursor.y ?? 0) + ', default';
  }
  private fail(error: Error) {
    if (this.abort.signal.aborted) return;
    if (!this.settled) { this.settled = true; clearTimeout(this.timer); this.rejectReady(error); }
    this.abort.abort();
    this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    this.onState(error.message);
    this.controlling = false;
    this.socket.close();
  }
  get available() { return this.settled && !this.abort.signal.aborted; }
  release() { this.input({ type: 'release' }); }
  dispose() {
    this.release(); this.abort.abort(); clearTimeout(this.timer);
    if (!this.settled) { this.settled = true; this.rejectReady(new Error('RDP_DISPLAY_CANCELED')); }
    this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    this.socket.close(); this.canvas.remove();
  }
}
const buttons: Record<number, number> = { 0: 0x1000, 1: 0x4000, 2: 0x2000 };
const codes: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58, NumpadEnter: 0x11c, ControlRight: 0x11d, NumpadDivide: 0x135, PrintScreen: 0x137, AltRight: 0x138,
  Home: 0x147, ArrowUp: 0x148, PageUp: 0x149, ArrowLeft: 0x14b, ArrowRight: 0x14d, End: 0x14f, ArrowDown: 0x150, PageDown: 0x151, Insert: 0x152, Delete: 0x153, MetaLeft: 0x15b, MetaRight: 0x15c, ContextMenu: 0x15d,
};
