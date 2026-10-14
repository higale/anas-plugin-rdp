import keyCodes from '../key-codes.json';
export interface DisplayConnection { url: string; token: string; pageId: string }
interface Cursor { kind: string; width?: number; height?: number; x?: number; y?: number; pixels?: number[] }
interface Position { x: number; y: number }
interface Snapshot { type: 'snapshot'; revision: number; state: string; owner: string | null; epoch: number; uiLocked: boolean; uiRevision: number; clipboardEnabled?: boolean; clipboardState?: string; image: boolean; resizeError?: string | null; resizeSupported?: boolean; cursor?: Cursor; cursorPosition: Position | null; cursorAnimate: boolean; mouseSequence: number }

/** Owns only a display attachment. dispose() never disconnects the RDP resource. */
export class Desktop {
  readonly canvas = document.createElement('canvas');
  private cursorLayer = document.createElement('div');
  private cursorImage = document.createElement('img');
  private cursor?: Cursor;
  private cursorPosition?: Position;
  private displayedCursorPosition?: Position;
  private cursorAnimationFrame?: number;
  private mouseSequence = 0;
  private pendingMouseSequence = 0;
  private pointerInside = false;
  private resize: ResizeObserver;
  private socket: WebSocket;
  private abort = new AbortController();
  private metadata?: Snapshot;
  private epoch = 0;
  private uiRevision = 0;
  private uiLocked = false;
  private clipboardRevision = -1;
  private controlling = false;
  private inputBlocked = false;
  private settled = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready: Promise<void>;
  private timer: ReturnType<typeof setTimeout>;
  private frameSize?: { width: number; height: number };
  get size() { return this.frameSize; }
  get resizeEpoch() { return this.available && this.metadata?.owner === this.connection.pageId ? this.epoch : undefined; }
  constructor(container: HTMLElement, private connection: DisplayConnection, private onState: (state: string, uiLocked: boolean) => void,
    private onSize: () => void = () => {}, private onClipboard: (enabled: boolean, state?: string) => void = () => {}, private disableMouseAnimation = false, private onResizeError: (error: string) => void = () => {}, private onResizeCapability: (supported: boolean) => void = () => {}) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Remote desktop');
    this.cursorLayer.className = 'remote-cursor-layer';
    this.cursorLayer.hidden = true;
    this.cursorLayer.setAttribute('aria-hidden', 'true');
    this.cursorImage.alt = '';
    this.cursorImage.draggable = false;
    this.cursorLayer.append(this.cursorImage);
    container.append(this.canvas, this.cursorLayer);
    this.resize = new ResizeObserver(() => this.renderCursor());
    this.resize.observe(this.canvas);
    this.resize.observe(container);
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
          const capabilityChanged = this.metadata?.resizeSupported !== metadata.resizeSupported;
          this.metadata = metadata;
          if (capabilityChanged) this.onResizeCapability(metadata.resizeSupported === true);
          if (metadata.resizeError) this.onResizeError(metadata.resizeError);
          this.epoch = metadata.epoch;
          this.updateInputLock(metadata.uiLocked, metadata.uiRevision);
          this.updateCursor(metadata);
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
            this.setCursorPosition(this.cursorPosition);
            this.onSize();
          }
          this.renderCursor();
          this.ack(metadata.revision);
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error('RDP_DISPLAY_PROTOCOL')); }
    };
    this.socket.onerror = () => this.fail(new Error('RDP_DISPLAY_CONNECTION'));
    this.socket.onclose = () => this.fail(new Error('RDP_DISPLAY_CLOSED'));
    const options = { signal: this.abort.signal };
    const mouse = (event: MouseEvent, flags: number, wheel = 0) => {
      const { left, top, width, height, scale } = this.displayBounds();
      if (!scale || !this.frameSize) return;
      this.pointerInside = event.clientX >= left && event.clientX < left + width && event.clientY >= top && event.clientY < top + height;
      this.updateLocalCursor();
      // Letterboxing is not part of the remote desktop. Captured drags still release at its edge.
      if (!this.pointerInside && !this.canvas.hasPointerCapture((event as PointerEvent).pointerId)) return;
      const position = { x: Math.max(0, Math.min(this.canvas.width - 1, Math.round((event.clientX - left) / scale))),
        y: Math.max(0, Math.min(this.canvas.height - 1, Math.round((event.clientY - top) / scale))) };
      const sequence = this.mouseSequence + 1;
      if (this.input({ type: 'mouse', flags, wheel, ...position, mouseSequence: sequence })) {
        this.mouseSequence = this.pendingMouseSequence = sequence;
        this.setCursorPosition(position);
      }
    };
    this.canvas.addEventListener('pointerdown', event => {
      if (this.uiLocked || this.inputBlocked) { event.preventDefault(); return; }
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
    this.canvas.addEventListener('pointerleave', () => { this.pointerInside = false; this.updateLocalCursor(); }, options);
    this.canvas.addEventListener('pointerup', event => {
      mouse(event, buttons[event.button] ?? 0);
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    }, options);
    this.canvas.addEventListener('pointercancel', () => this.release(), options);
    this.canvas.addEventListener('contextmenu', event => event.preventDefault(), options);
    this.canvas.addEventListener('wheel', event => { if (!this.controlling) return; event.preventDefault(); mouse(event, 0x0200, Math.sign(-event.deltaY) * 120); }, { ...options, passive: false });
    const key = (event: KeyboardEvent, down: boolean) => {
      if (!this.controlling || this.inputBlocked || event.isComposing) return;
      const code = codes[event.code];
      if (code === undefined) return;
      event.preventDefault();
      this.input({ type: 'key', code: code & 255, extended: code > 255, down });
    };
    this.canvas.addEventListener('keydown', event => key(event, true), options);
    this.canvas.addEventListener('keyup', event => key(event, false), options);
    this.canvas.addEventListener('blur', () => this.release(), options);
    window.addEventListener('blur', () => this.release(), options);
    window.addEventListener('scroll', () => this.renderCursor(), { ...options, capture: true });
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
    if (!this.controlling) this.pendingMouseSequence = 0;
    this.onState(metadata.state, this.uiLocked);
    this.updateLocalCursor();
  }
  private ack(revision: number) { this.socket.send(JSON.stringify({ type: 'ack', revision })); }
  private input(message: Record<string, unknown>) {
    if (this.controlling && !this.inputBlocked && this.socket.readyState === WebSocket.OPEN) {
      if (this.socket.bufferedAmount >= 8192) { this.fail(new Error('RDP_INPUT_BACKPRESSURE')); return false; }
      this.socket.send(JSON.stringify({ ...message, epoch: this.epoch, uiRevision: this.uiRevision }));
      return true;
    }
    return false;
  }
  private updateCursor(metadata: Snapshot) {
    const { cursor, cursorPosition: position, cursorAnimate, mouseSequence } = metadata;
    if (typeof cursorAnimate !== 'boolean' || !Number.isSafeInteger(mouseSequence) || mouseSequence < 0
      || (position !== null && (!position || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y) || position.x < 0 || position.y < 0))) throw new Error('RDP_DISPLAY_PROTOCOL');
    if (cursor) {
      if (!['default', 'bitmap', 'hidden'].includes(cursor.kind)) throw new Error('RDP_DISPLAY_PROTOCOL');
      if (cursor.kind !== 'hidden') {
        const { width, height, pixels, x, y } = cursor;
        if (!Number.isInteger(width) || !Number.isInteger(height) || !width || !height || width < 1 || height < 1 || width > 512 || height > 512
          || !Array.isArray(pixels) || pixels.length !== width * height * 4 || !Number.isInteger(x) || !Number.isInteger(y)) throw new Error('RDP_DISPLAY_PROTOCOL');
        const image = document.createElement('canvas');
        image.width = width; image.height = height;
        image.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
        this.cursorImage.src = image.toDataURL();
      }
      this.cursor = cursor;
    }
    // An older echo must not overwrite a newer local move, including after pointerleave.
    if (mouseSequence >= this.pendingMouseSequence) {
      this.pendingMouseSequence = 0;
      this.setCursorPosition(position ?? undefined, cursorAnimate);
    }
    this.renderCursor();
  }
  private stopCursorAnimation() {
    if (this.cursorAnimationFrame !== undefined) cancelAnimationFrame(this.cursorAnimationFrame);
    this.cursorAnimationFrame = undefined;
  }
  private setCursorPosition(position?: Position, animate = false) {
    const previous = this.cursorPosition, from = this.displayedCursorPosition;
    this.cursorPosition = position;
    if (animate && !this.disableMouseAnimation && position && from && this.frameSize && this.cursor && this.cursor.kind !== 'hidden'
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      // Frame/shape updates and echoed coordinates must not restart an in-flight animation.
      if (previous?.x === position.x && previous.y === position.y) return;
      this.stopCursorAnimation();
      const start = performance.now();
      const distance = Math.hypot(position.x - from.x, position.y - from.y) * this.displayBounds().scale;
      const duration = Math.min(160, 80 + distance / 8);
      const tick = (now: number) => {
        const progress = Math.min(1, Math.max(0, (now - start) / duration));
        const eased = 1 - (1 - progress) ** 2;
        this.displayedCursorPosition = { x: from.x + (position.x - from.x) * eased, y: from.y + (position.y - from.y) * eased };
        this.renderCursor();
        this.cursorAnimationFrame = progress < 1 ? requestAnimationFrame(tick) : undefined;
      };
      this.cursorAnimationFrame = requestAnimationFrame(tick);
    } else {
      this.stopCursorAnimation();
      this.displayedCursorPosition = position;
    }
    this.renderCursor();
  }
  private displayBounds() {
    const bounds = this.canvas.getBoundingClientRect();
    const scale = Math.min(bounds.width / this.canvas.width, bounds.height / this.canvas.height);
    const width = this.canvas.width * scale, height = this.canvas.height * scale;
    return { left: bounds.left + (bounds.width - width) / 2, top: bounds.top + (bounds.height - height) / 2, width, height, scale };
  }
  private updateLocalCursor() {
    this.canvas.style.cursor = this.uiLocked ? 'not-allowed' : this.controlling && this.pointerInside && this.cursor
      && (this.cursor.kind === 'hidden' || this.cursorPosition) ? 'none' : 'default';
  }
  private renderCursor() {
    const cursor = this.cursor, position = this.displayedCursorPosition;
    const { left, top, width, height, scale } = this.displayBounds();
    this.cursorLayer.hidden = this.abort.signal.aborted || !this.frameSize || !position || !cursor || cursor.kind === 'hidden' || !scale;
    if (!this.cursorLayer.hidden && cursor && position) {
      Object.assign(this.cursorLayer.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      Object.assign(this.cursorImage.style, { left: `${(position.x - cursor.x!) * scale}px`, top: `${(position.y - cursor.y!) * scale}px`,
        width: `${cursor.width! * scale}px`, height: `${cursor.height! * scale}px` });
    }
    this.updateLocalCursor();
  }
  private fail(error: Error) {
    if (this.abort.signal.aborted) return;
    if (!this.settled) { this.settled = true; clearTimeout(this.timer); this.rejectReady(error); }
    this.abort.abort();
    this.stopCursorAnimation();
    this.resize.disconnect();
    this.cursorLayer.hidden = true;
    this.canvas.style.cursor = 'default';
    this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    this.onState(error.message, false);
    this.controlling = false;
    this.socket.close();
  }
  get available() { return this.settled && !this.abort.signal.aborted; }
  setInputBlocked(blocked: boolean) { if (blocked && !this.inputBlocked) this.release(); this.inputBlocked = blocked; }
  release() { this.input({ type: 'release' }); }
  dispose() {
    this.release(); this.abort.abort(); clearTimeout(this.timer);
    this.stopCursorAnimation();
    this.resize.disconnect();
    if (!this.settled) { this.settled = true; this.rejectReady(new Error('RDP_DISPLAY_CANCELED')); }
    this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    this.socket.close(); this.canvas.remove(); this.cursorLayer.remove();
  }
}
const buttons: Record<number, number> = { 0: 0x1000, 1: 0x4000, 2: 0x2000 };
const codes: Record<string, number> = keyCodes;
