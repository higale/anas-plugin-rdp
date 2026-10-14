import { resolution } from '../resolution';
export interface DisplaySize { width: number; height: number }

/** Bounds are CSS pixels; HiDPI must not silently multiply the remote desktop. */
export function viewportResolution(width: number, height: number): DisplaySize | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  width = Math.max(200, Math.min(8192, Math.floor(width)));
  height = Math.max(200, Math.min(8192, Math.floor(height)));
  const scale = Math.min(1, Math.sqrt(16 * 1024 * 1024 / (width * height)));
  width = Math.max(200, Math.floor(width * scale / 2) * 2);
  height = Math.max(200, Math.floor(height * scale));
  resolution(width, height);
  return { width, height };
}

/** Coalesce viewport changes; a suspended/retired page cannot dispatch a late resize. */
export class AdaptiveResolution {
  private observer: ResizeObserver;
  private key = '';
  private applied = '';
  private inFlight?: { key: string; revision: number };
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private stopped = false;
  private enabled = false;
  constructor(container: HTMLElement, private apply: (size: DisplaySize, current: () => boolean) => Promise<boolean>,
    private measure: () => DisplaySize | undefined = () => container.getBoundingClientRect()) {
    this.observer = new ResizeObserver(() => this.refresh());
    this.observer.observe(container);
  }
  update(enabled: boolean) {
    this.enabled = enabled;
    this.refresh();
  }
  refresh() {
    if (this.stopped) return;
    const next = this.target();
    const key = next ? `${next.width}x${next.height}` : '';
    if (key === this.key && (this.timer !== undefined || key === this.applied || (key === this.inFlight?.key && this.inFlight.revision === this.revision))) return;
    this.key = key;
    const revision = ++this.revision;
    clearTimeout(this.timer); this.timer = undefined;
    if (!next || key === this.applied) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const current = () => {
        const latest = this.target();
        return !this.stopped && revision === this.revision && this.enabled && latest?.width === next.width && latest.height === next.height;
      };
      if (!current()) return;
      const flight = { key, revision };
      this.inFlight = flight;
      this.applied = '';
      void this.apply(next, current).then(accepted => {
        if (current() && accepted) this.applied = key;
      }).catch(() => { /* The caller reports business errors; a later refresh can retry transient ones. */ }).finally(() => { if (this.inFlight === flight) this.inFlight = undefined; });
    }, 300);
  }
  private target(): DisplaySize | undefined {
    const bounds = this.measure();
    return this.enabled && bounds && bounds.width > 0 && bounds.height > 0
      ? viewportResolution(bounds.width, bounds.height) : undefined;
  }
  /** A manual selection supersedes pending adaptation until the viewport changes. */
  async request(size: DisplaySize) {
    if (this.stopped) return false;
    clearTimeout(this.timer); this.timer = undefined;
    const revision = ++this.revision, key = this.key;
    const flight = { key, revision };
    this.inFlight = flight; this.applied = '';
    const current = () => !this.stopped && revision === this.revision;
    try {
      const accepted = await this.apply(size, current);
      if (current() && accepted) this.applied = key;
      return current() && accepted;
    } finally { if (this.inFlight === flight) this.inFlight = undefined; }
  }
  suspend() {
    this.enabled = false; this.key = ''; this.applied = ''; this.inFlight = undefined;
    ++this.revision; clearTimeout(this.timer); this.timer = undefined;
  }
  dispose() { this.suspend(); this.stopped = true; this.observer.disconnect(); }
}
