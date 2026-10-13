import keyCodes from '../key-codes.json';
export interface DisplayConnection { url: string; token: string; pageId: string }
interface Snapshot { type: 'snapshot'; revision: number; state: string; owner: string | null; epoch: number; uiLocked: boolean; uiRevision: number; clipboardEnabled?: boolean; clipboardState?: string; image: boolean; cursor: { kind: string; width?: number; height?: number; x?: number; y?: number; pixels?: number[] } }

/** Owns only a display attachment. dispose() never disconnects the RDP resource. */
export class Desktop {
  readonly canvas = document.createElement('canvas');
  private socket: WebSocket;
  private abort = new AbortController();
  private metadata?: Snapshot;
  private epoch = 0;
  private uiRevision = 0;
  private uiLocked = false;
  private clipboardRevision = -1;
  private controlling = false;
  private settled = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready: Promise<void>;
  private timer: ReturnType<typeof setTimeout>;
  private frameSize?: { width: number; height: number };
  get size() { return this.frameSize; }
  constructor(container: HTMLElement, private connection: DisplayConnection, private onState: (state: string, uiLocked: boolean) => void,
    private onSize: () => void = () => {}, private onClipboard: (enabled: boolean, state?: string) => void = () => {}) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Remote desktop');
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
          this.epoch = metadata.epoch;
          this.updateInputLock(metadata.uiLocked, metadata.uiRevision);
          this.updateClipboard(metadata.clipboardEnabled === true, metadata.revision, metadata.clipboardState);
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
          if (this.frameSize?.width !== width || this.frameSize?.height !== height) {
            this.frameSize = { width, height };
            this.onSize();
          }
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
      if (this.uiLocked) { event.preventDefault(); return; }
      if (!this.controlling) {
        if (this.available && this.socket.readyState === WebSocket.OPEN) {
          event.preventDefault(); this.canvas.focus();
          this.socket.send(JSON.stringify({ type: 'takeover', epoch: this.epoch, uiRevision: this.uiRevision }));
        }
        return;
      }
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
  updateClipboard(enabled: boolean, revision: number, state?: string) {
    if (this.abort.signal.aborted || revision < this.clipboardRevision) return;
    this.clipboardRevision = revision;
    this.onClipboard(enabled, state);
  }
  updateInputLock(locked: boolean, revision: number) {
    if (this.abort.signal.aborted) return;
    if (typeof locked !== 'boolean' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('RDP_DISPLAY_PROTOCOL');
    // Native receipts and display snapshots travel separately; never roll back newer state.
    if (revision >= this.uiRevision) { this.uiLocked = locked; this.uiRevision = revision; }
    const metadata = this.metadata;
    if (!metadata) return;
    this.controlling = metadata.owner === this.connection.pageId && !this.uiLocked;
    this.onState(metadata.state, this.uiLocked);
    this.updateCursor(metadata.cursor);
  }
  private ack(revision: number) { this.socket.send(JSON.stringify({ type: 'ack', revision })); }
  private input(message: Record<string, unknown>) {
    if (this.controlling && this.socket.readyState === WebSocket.OPEN) {
      if (this.socket.bufferedAmount >= 8192) { this.fail(new Error('RDP_INPUT_BACKPRESSURE')); return; }
      this.socket.send(JSON.stringify({ ...message, epoch: this.epoch, uiRevision: this.uiRevision }));
    }
  }
  private updateCursor(cursor: Snapshot['cursor']) {
    if (this.uiLocked) { this.canvas.style.cursor = 'not-allowed'; return; }
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
    this.onState(error.message, false);
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
const codes: Record<string, number> = keyCodes;
