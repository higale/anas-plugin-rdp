import { Desktop } from './desktop';
import { AdaptiveResolution, viewportResolution, type DisplaySize } from './adaptive-resolution';
import { closeContextMenu, openContextMenu } from './context-menu';
import type { Profile, RuntimeState, Target, Trust } from '../profile-types';
import { DEFAULT_DESKTOP_WIDTH, DEFAULT_DESKTOP_HEIGHT, resolution } from '../resolution';
import { i18n, initializeLanguages, setLanguage, t } from './i18n';
import type { WindowPlacement, WindowState } from '../window-state';
import { TextInput, type TextDraft } from './text-input';

type Toolbar = { status?: { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }; actions: { id: string; label: string; icon: string; disabled: boolean; pressed?: boolean; items?: { id: string; label: string; checked?: boolean; disabled?: boolean; separatorBefore?: boolean }[]; description?: string }[] };

declare global {
  interface Window {
    anas: {
      selectDirectory(options?: { title?: string }): Promise<string | null>;
      showItemInFolder(path: string): Promise<void>;
      getContext(): Promise<PageContext>;
      registerLifecycle(handlers: { prepare(input: LifecycleInput): Promise<Restore>; activate(input: LifecycleInput): Promise<void>; resume(input: LifecycleInput): Promise<void>; dispose(input: LifecycleInput): Promise<void> }): void;
      ready(): Promise<void>;
      failed(): Promise<void>;
      getInfo(): Promise<{ language: string; theme: string; fontSize: number; view: { instanceId: string; location: 'sidebar' | 'window' } }>;
      onViewChanged(listener: (view: { instanceId: string; location: 'sidebar' | 'window'; activity?: { visible: boolean; active: boolean }; windowMode?: WindowMode; windowResizeRevision?: number; windowPlacement?: WindowPlacement; viewport: DisplaySize }) => void): () => void;
      setToolbar(toolbar: Toolbar | null): Promise<void>;
      resizeWindow(size: { width: number; height: number; restore?: boolean; restorePlacement?: WindowPlacement }): Promise<void>;
      onToolbarAction(listener: (id: string) => void | Promise<void>): () => void;
      getLanguageResources(): Promise<{ resources: Record<string, Record<string, unknown>>; errors: string[] }>;
      openView(options: { instanceId: string; location: 'sidebar' | 'window'; title?: string; icon?: string }): Promise<void>;
      moveView(target: 'sidebar' | 'window' | { location: 'sidebar' | 'window'; instanceId: string }): Promise<void>;
      closeView(options: { instanceId: string }): Promise<void>;
      data: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
      backend: { call(method: string, params: unknown, options?: { concurrent?: boolean }): Promise<unknown> };
    };
  }
}
type WindowMode = 'normal' | 'maximized' | 'fullscreen';
type SessionRef = { id: string; url: string; token: string };
type Lease = { owner: string | null; epoch: number };
type PageContext = { panelId: string; pageId: string; location: 'sidebar' | 'window'; phase: 'preparing' | 'active' | 'suspended'; windowMode?: WindowMode; windowResizeRevision?: number; windowPlacement?: WindowPlacement; viewport: DisplaySize; restoreState: Restore | null; view: { content: { instanceId: string }; activity?: { visible: boolean; active: boolean } } };
type LifecycleInput = { signal: AbortSignal; context: PageContext; reason?: 'moved' | 'closed'; targetPageId?: string };
type ConnectionProfile = Omit<Profile, 'revision'>;
type ViewState =
  | { kind: 'manager'; selected?: Profile; editorOpen: boolean; returnId?: string; passwordEdited: boolean; deletePending: boolean;
      fields: Record<string, { value: string; checked: boolean }> }
  | { kind: 'connection'; profile?: ConnectionProfile; password: string; rememberPassword: boolean; passwordPrompt: boolean; pendingTrust?: Trust };
type Restore = { session: SessionRef | null; lease: Lease | null; view: ViewState; statusKey: string; errorKey?: string; scroll: number; textDraft?: TextDraft };
let pageContext: PageContext;
let handoff = true;
let lease: Lease | null = null;
type AdaptivePreferences = Pick<Profile, 'adaptiveWindow' | 'adaptiveSidebar'>;
type SessionStatus = AdaptivePreferences & { state: string; certificate: { sha256: string; trusted: boolean } | null };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
let owner = '';
let generation = 0;
let session: SessionRef | undefined;
let desktop: Desktop | undefined;
let trusts: Trust[] = [];
let pendingTrust: Trust | undefined;
let connecting = false;
let connectionOperations = 0;
let connected = false;
let uiLocked = false;
let uiLockPending = false;
let inputResetPending = false;
let textInputBusy = false;
let clipboardEnabled = false;
let clipboardState = 'initializing';
let clipboardPending = false;
type DownloadState = { offer: { revision: number; count: number } | null; transfer: { id: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; bytes: number; total: number | null; completed: number; count: number; path?: string; error?: string } | null };
let downloadState: DownloadState | null = null;
let downloadSession = '';
let downloadPending = false;
let downloadPolling = false;
let dismissedDownload = '';
let downloadIssue: string | undefined;
let downloadRevision = 0;
let downloadTimer: ReturnType<typeof setInterval> | undefined;
function downloadLabel() {
  const task = downloadState?.transfer;
  return task?.state === 'running' ? t('download.progress', { bytes: formatBytes(task.bytes), total: task.total === null ? '…' : formatBytes(task.total) }) : t('download.action', { count: downloadState?.offer?.count ?? 0 });
}
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`; }
function renderDownload() {
  const task = downloadState?.transfer;
  const visible = !!downloadIssue || (!!task && task.id !== dismissedDownload);
  element('download-status').hidden = !visible;
  if (!visible) return;
  element('download-message').textContent = downloadIssue ? (downloadIssue.includes('RDP_DOWNLOAD_HOST') ? t('download.update_host') : downloadError(downloadIssue)) : task?.state === 'running' ? downloadLabel() : t('download.' + task?.state);
  element('download-error').textContent = task && (task.state === 'failed' || task.error === 'RDP_DOWNLOAD_CLEANUP') ? downloadError(task.error) : '';
  const progress = element<HTMLProgressElement>('download-progress');
  progress.hidden = task?.state !== 'running';
  if (task?.total === null || !task) progress.removeAttribute('value');
  else { progress.max = task.total || task.count; progress.value = task.total ? task.bytes : task.completed; }
  const cancel = element<HTMLButtonElement>('download-cancel');
  cancel.hidden = task?.state !== 'running'; cancel.disabled = downloadPending; cancel.textContent = t('actions.cancel');
  const reveal = element<HTMLButtonElement>('download-reveal');
  reveal.hidden = !task?.path; reveal.textContent = t('download.reveal');
  const dismiss = element<HTMLButtonElement>('download-dismiss');
  dismiss.hidden = task?.state === 'running'; dismiss.textContent = t('download.dismiss');
}
function downloadError(error?: string) {
  for (const [code, key] of Object.entries({ RDP_DOWNLOAD_REVEAL: 'reveal_error', RDP_DOWNLOAD_CHANGED: 'changed', RDP_DOWNLOAD_DIRECTORY: 'directory_error', RDP_DOWNLOAD_READ: 'read_error', RDP_DOWNLOAD_WRITE: 'write_error', RDP_DOWNLOAD_EXISTS: 'exists_error', RDP_DOWNLOAD_FILES: 'files_error', RDP_DOWNLOAD_CLEANUP: 'cleanup_error', RDP_DOWNLOAD_BUSY: 'busy' })) {
    if (error?.includes(code)) return t('download.' + key);
  }
  return t('download.failed');
}
async function refreshDownload() {
  if (downloadPolling || downloadPending || closing || handoff) return;
  const revision = downloadRevision;
  const current = session;
  if (!current || !connectionProfile?.clipboardSupport) { downloadState = null; downloadSession = ''; renderDownload(); return; }
  if (downloadSession !== current.id) { downloadState = null; downloadSession = current.id; downloadIssue = undefined; dismissedDownload = ''; renderDownload(); }
  if (!connected) {
    if (downloadState?.transfer?.state === 'running') { downloadState.transfer.state = 'failed'; downloadState.transfer.error = 'RDP_SESSION_CLOSED'; renderDownload(); }
    return;
  }
  downloadPolling = true;
  try {
    const result = await window.anas.backend.call('downloadStatus', { owner, id: current.id }) as DownloadState | null;
    if (session !== current || closing || handoff || revision !== downloadRevision) return;
    downloadState = result; renderDownload(); presentation();
  } catch {
    if (session === current && revision === downloadRevision && downloadState?.transfer?.state === 'running') {
      downloadState.transfer.state = 'failed'; downloadState.transfer.error = 'RDP_SESSION_CLOSED'; renderDownload();
    }
  } finally { downloadPolling = false; }
}
async function startDownload() {
  const current = session, offer = downloadState?.offer;
  if (!current || !offer || downloadPending || downloadState?.transfer?.state === 'running' || handoff || closing || !connected) return;
  downloadPending = true; downloadIssue = undefined; ++downloadRevision; presentation();
  try {
    if (!window.anas.selectDirectory) throw new Error('RDP_DOWNLOAD_HOST');
    const directory = await window.anas.selectDirectory({ title: t('download.select_directory') });
    if (!directory || session !== current || handoff || closing || !connected) return;
    const result = await window.anas.backend.call('downloadStart', { owner, id: current.id, revision: offer.revision, directory }) as DownloadState;
    if (session === current && !closing) { downloadState = result; dismissedDownload = ''; }
  } catch (error) {
    if (!closing && session === current) downloadIssue = String(error);
  } finally { downloadPending = false; if (!closing) { renderDownload(); presentation(); } }
}

let clipboardErrorSeen = '';
let disconnecting = false;
let savingTrust = false;
let profiles: Profile[] = [];
let runningSessions: RuntimeState['sessions'] = [];
let openProfileIds: string[] = [];
let editingProfiles: string[] = [];
let sessionsKnown = false;
let sessionRefresh: Promise<void> | undefined;
let sessionTimer: ReturnType<typeof setInterval> | undefined;
const activeProfile = (id?: string) => runningSessions.find(session => session.profile.id === id);
const profileWorking = (id?: string) => !!id && (!sessionsKnown || !!activeProfile(id));
const profileLocked = (id?: string) => profileWorking(id) || !!id && openProfileIds.includes(id);
let selected: Profile | undefined;
let connectionProfile: ConnectionProfile | undefined;
let passwordPrompt = false;
let instanceId = 'main';
let location: 'sidebar' | 'window' = 'sidebar';
let editorOpen = false;
let returnId: string | undefined;
let editing = false;
let passwordEdited = false;
let deletePending = false;
let ready = false;
let statusKey = 'status.idle';
let errorKey: string | undefined;
let releaseToolbarListener: (() => void) | undefined;
let toolbarSnapshot = '';
let toolbarRevision = 0;
let toolbarReady = false;
let toolbarUpdate: Promise<void> = Promise.resolve();
let fittedDesktop: Desktop | undefined;
let windowFitReady = false;
let windowMode: WindowMode | undefined;
let windowResizeRevision = 0;
let adaptedWindowRevision: number | undefined;
let normalWindowViewport: (DisplaySize & { revision: number }) | undefined;
let windowPlacement: WindowPlacement | undefined;
let hostViewport: DisplaySize | undefined;
let windowStateTimer: ReturnType<typeof setTimeout> | undefined;
let windowStateWrites: Promise<void> = Promise.resolve();
let windowStateCapture: Promise<void> = Promise.resolve();
let observedWindowState = '';
let pendingWindowState: ReturnType<typeof windowStateSample>;
let savedWindowState = '';
let fitScheduled = false;
const adaptiveEnabled = () => !!(location === 'window' ? connectionProfile?.adaptiveWindow : connectionProfile?.adaptiveSidebar);
let resizeFailure = '';
let resizeSupported = false;
let adaptivePending = false;
const dynamicResolutionAvailable = () => connected && resizeSupported && !resizeFailure;
let presentationVisible = true;
let resizingWindow = false;
let selectingResolution = false;
let movingWindow = false;
const textInput = new TextInput(() => {
  const resource = session, display = desktop;
  if (!resource || !display || !connected || uiLocked || handoff || closing) throw new Error('RDP_NOT_CONNECTED');
  return async text => {
    if (session !== resource || desktop !== display || !connected || uiLocked || handoff || closing || display.resizeEpoch === undefined) throw new Error('RDP_NOT_CONNECTED');
    const result = await window.anas.backend.call('inputText', { owner, id: resource.id, pageId: pageContext.pageId, expectedEpoch: display.resizeEpoch, text }) as { accepted: boolean };
    if (!result?.accepted) throw new Error('RDP_INPUT_UNCONFIRMED');
  };
}, busy => { textInputBusy = busy; desktop?.setInputBlocked(busy); presentation(); });
function openTextInput() {
  if (!connectionActions().find(action => action.id === 'input-text')?.disabled) textInput.open();
}
const commonSizes = [[1024, 768], [1280, 800], [1600, 900], [1920, 1080], [2560, 1440]];
function desktopInsets() {
  const viewport = document.documentElement.getBoundingClientRect();
  const desktop = element('desktop').getBoundingClientRect();
  return { width: viewport.width - desktop.width, height: viewport.height - desktop.height };
}
function desktopViewport() {
  // A native user resize is consumed once. Moving, DPI rounding and plugin
  // window fitting cannot turn later layout notifications into another resize.
  if (location === 'window' && adaptedWindowRevision === windowResizeRevision) return;
  // Parent and iframe layout can settle in different frames during a DPI change.
  // Wait for agreement, rather than treating the transient child size as a resize.
  if (!hostViewport || Math.abs(window.innerWidth - hostViewport.width) > 1 || Math.abs(window.innerHeight - hostViewport.height) > 1) return;
  // OOPIF layout can round outwards by a physical pixel even after it settles.
  // Use the parent's allocated viewport, subtracting only our own UI chrome.
  const insets = desktopInsets();
  const viewport = location === 'window' && normalWindowViewport?.revision === windowResizeRevision ? normalWindowViewport : hostViewport;
  return { width: viewport.width - insets.width, height: viewport.height - insets.height };
}
function resolutionChoices() {
  const sizes = commonSizes.map(([width, height]) => ({ width, height }));
  const width = connectionProfile?.desktopWidth ?? DEFAULT_DESKTOP_WIDTH;
  const height = connectionProfile?.desktopHeight ?? DEFAULT_DESKTOP_HEIGHT;
  if (!sizes.some(size => size.width === width && size.height === height)) sizes.push({ width, height });
  return sizes;
}
function resolutionLabel({ width, height }: DisplaySize) {
  const size = `${width} × ${height}`;
  return width === (connectionProfile?.desktopWidth ?? DEFAULT_DESKTOP_WIDTH)
    && height === (connectionProfile?.desktopHeight ?? DEFAULT_DESKTOP_HEIGHT)
    ? t('actions.initial_resolution', { size }) : size;
}
function reportResizeError(error: string) {
  const code = error.includes('RDP_RESIZE_UNSUPPORTED') ? 'RDP_RESIZE_UNSUPPORTED' : 'RDP_RESIZE_FAILED';
  if (resizeFailure === code) return;
  resizeFailure = code;
  element('resize-warning').hidden = false;
  element('resize-warning').textContent = t(code === 'RDP_RESIZE_UNSUPPORTED' ? 'errors.resize_unsupported' : 'errors.resize_failed');
  adaptiveResolution.suspend();
  presentation();
}
const adaptiveResolution = new AdaptiveResolution(element('desktop'), async (size, current) => {
  const display = desktop, resource = session, revision = windowResizeRevision;
  if (!display || !resource || display.resizeEpoch === undefined || handoff || closing || !connected || resizeFailure) return false;
  connectionOperations++;
  try {
    const context = await window.anas.getContext();
    hostViewport = context.viewport;
    if (!current() || handoff || closing || desktop !== display || context.phase !== 'active' || context.view.activity?.visible === false) return false;
    await window.anas.backend.call('resize', { owner, id: resource.id, pageId: context.pageId, expectedEpoch: display.resizeEpoch, ...size });
    const accepted = current();
    if (accepted && location === 'window') adaptedWindowRevision = revision;
    if (accepted && selectingResolution && errorKey === 'errors.resize_retry') { errorKey = undefined; renderError(); }
    return accepted;
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (current()) {
      if (!['RDP_INPUT_BUSY', 'RDP_INPUT_UNAVAILABLE', 'RDP_OWNERSHIP_CHANGED', 'RDP_NOT_CONNECTED', 'RDP_SESSION_CLOSED'].some(value => code.includes(value))) reportResizeError(code);
      else if (selectingResolution && !handoff && !closing) failure('errors.resize_retry');
    }
    return false;
  } finally { connectionOperations--; }
}, desktopViewport);
function updateAdaptiveResolution() {
  adaptiveResolution.update(!!desktop && connected && ready && presentationVisible && !handoff && !closing && !resizingWindow
    && !textInputBusy && dynamicResolutionAvailable() && adaptiveEnabled()
    && (location !== 'window' || (fittedDesktop === desktop && windowFitReady && !fitScheduled && adaptedWindowRevision !== windowResizeRevision)));
}
async function selectResolution(size: DisplaySize) {
  const action = connectionActions().find(action => action.id === 'resolution-menu');
  if (!action || action.disabled) return;
  selectingResolution = true; presentation();
  try {
    if (location === 'window' && !await resizeDesktopWindow(size)) return;
    await adaptiveResolution.request(size);
  } finally { selectingResolution = false; if (!closing) presentation(); }
}
async function resizeDesktopWindow(size: DisplaySize): Promise<boolean> {
  if (location !== 'window' || !connected || !desktop || handoff || closing || resizingWindow) return false;
  resizingWindow = true; adaptiveResolution.suspend(); connectionOperations++;
  try {
    const context = await window.anas.getContext();
    if (context.phase !== 'active' || context.location !== 'window' || handoff || closing) return false;
    const insets = desktopInsets();
    await window.anas.resizeWindow({ width: size.width + insets.width,
      height: size.height + insets.height, restore: true });
    const fitted = await window.anas.getContext();
    hostViewport = fitted.viewport; windowResizeRevision = fitted.windowResizeRevision ?? 0;
    adaptedWindowRevision = windowResizeRevision;
    normalWindowViewport = { width: size.width + insets.width, height: size.height + insets.height, revision: windowResizeRevision };
    windowFitReady = true;
    return true;
  } catch { failure('errors.window_size'); return false; }
  finally { resizingWindow = false; connectionOperations--; updateAdaptiveResolution(); scheduleWindowState(); }
}
async function toggleAdaptive() {
  const resource = session, display = desktop;
  const action = connectionActions().find(action => action.id === 'resolution-menu');
  if (!action || action.disabled || !resource || !display || display.resizeEpoch === undefined) return;
  const enabled = !adaptiveEnabled(), targetLocation = location;
  adaptivePending = true; connectionOperations++; presentation();
  try {
    const next = await window.anas.backend.call('setAdaptive', { owner, id: resource.id, pageId: pageContext.pageId,
      expectedEpoch: display.resizeEpoch, location: targetLocation, enabled }) as AdaptivePreferences;
    if (session === resource && connectionProfile) {
      Object.assign(connectionProfile, next);
      // Enabling adaptation explicitly applies the current viewport once.
      adaptedWindowRevision = undefined;
      adaptiveResolution.suspend();
      if (errorKey === 'errors.adaptive_save') { errorKey = undefined; renderError(); }
    }
  } catch { if (session === resource && !closing) failure('errors.adaptive_save'); }
  finally { adaptivePending = false; connectionOperations--; if (!closing) presentation(); }
}
// Window memory belongs to the live backend session, never to a page or remote frame.
function windowStateSample(flush = false) {
  const resource = session, current = desktop;
  if (!resource || !current || !connected || !ready || handoff || closing || location !== 'window'
    || windowMode !== 'normal' || (!flush && !presentationVisible) || !windowFitReady || fitScheduled || resizingWindow
    || fittedDesktop !== current || current.resizeEpoch === undefined) return;
  const size = normalWindowViewport?.revision === windowResizeRevision ? normalWindowViewport : hostViewport;
  if (!size) return;
  const { width, height } = size;
  if (width <= 0 || height <= 0) return;
  const placement = windowPlacement;
  return { resource, current, expectedEpoch: current.resizeEpoch, width, height, placement,
    key: JSON.stringify([resource.id, width, height, placement, windowResizeRevision]) };
}
function writeWindowState(): Promise<void> {
  clearTimeout(windowStateTimer); windowStateTimer = undefined;
  const sample = pendingWindowState; pendingWindowState = undefined;
  if (!sample) return windowStateWrites;
  const { resource, current, expectedEpoch, width, height, placement, key } = sample;
  const write = windowStateWrites.then(async () => {
    if (key === savedWindowState || current !== desktop || resource !== session) return;
    await window.anas.backend.call('windowState.set', { owner, id: resource.id, pageId: pageContext.pageId, expectedEpoch, width, height, ...(placement ? { placement } : {}) });
    savedWindowState = key;
  });
  windowStateWrites = write.catch(() => { if (observedWindowState === key) observedWindowState = ''; });
  return write;
}
function captureWindowState(flush = false): Promise<void> {
  const sample = windowStateSample(flush);
  if (!sample || (!flush && sample.key === observedWindowState)) return windowStateCapture;
  observedWindowState = sample.key;
  // Validate the mode when measuring. A later fullscreen transition must not
  // discard the last confirmed normal size merely because saving was debounced.
  const capture = (async () => {
    const context = await window.anas.getContext();
    if (sample.key !== observedWindowState || sample.current !== desktop || sample.resource !== session) return;
    if (context.location !== 'window' || context.windowMode !== 'normal' || context.phase === 'preparing') {
      observedWindowState = ''; return;
    }
    // Read the actual placement when flushing too: close can precede the final move event.
    if (!context.viewport || context.viewport.width <= 0 || context.viewport.height <= 0) { observedWindowState = ''; return; }
    windowPlacement = context.windowPlacement;
    const revision = context.windowResizeRevision ?? 0;
    if (normalWindowViewport?.revision !== revision) normalWindowViewport = { ...context.viewport, revision };
    sample.width = normalWindowViewport.width; sample.height = normalWindowViewport.height;
    sample.placement = context.windowPlacement;
    sample.key = JSON.stringify([sample.resource.id, sample.width, sample.height, sample.placement, revision]);
    observedWindowState = sample.key;
    pendingWindowState = sample;
    clearTimeout(windowStateTimer);
    windowStateTimer = setTimeout(() => { void writeWindowState().catch(windowMemoryFailure); }, 300);
  })();
  windowStateCapture = capture.catch(() => { if (observedWindowState === sample.key) observedWindowState = ''; });
  return capture;
}
function windowMemoryFailure() {
  if (!closing && !handoff && connected) failure('errors.window_memory');
}
async function flushWindowState() {
  await captureWindowState(true);
  await writeWindowState();
}
function scheduleWindowState() {
  if (!closing && !handoff) void captureWindowState().catch(windowMemoryFailure);
}
async function fitDesktopWindow(manual = false, preparing = false) {
  const current = desktop;
  if (!current?.size || !connected || !ready || !toolbarReady || (handoff && !preparing) || closing || location !== 'window' || fitScheduled) return;
  if (!manual && current === fittedDesktop) return;
  fitScheduled = true; windowFitReady = false; adaptiveResolution.suspend(); connectionOperations++;
  try {
    if (manual && errorKey === 'errors.window_size') { errorKey = undefined; renderError(); }
    if (!preparing) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const context = await window.anas.getContext();
    if (context.phase !== (preparing ? 'preparing' : 'active') || context.location !== 'window' || current !== desktop || (handoff && !preparing) || closing || !connected) return;
    // New pages restore the normal viewport, or use the profile's configured size.
    // A sidebar's current frame must never decide the initial separate-window size.
    const remembered = manual ? null : await window.anas.backend.call('windowState.get', { owner, id: session!.id }) as WindowState | null;
    const size = remembered ?? (manual ? current.size! : { width: connectionProfile?.desktopWidth ?? DEFAULT_DESKTOP_WIDTH, height: connectionProfile?.desktopHeight ?? DEFAULT_DESKTOP_HEIGHT });
    if (current !== desktop || (handoff && !preparing) || closing || !connected) return;
    const insets = desktopInsets();
    await window.anas.resizeWindow({ width: size.width + (remembered ? 0 : insets.width),
      height: size.height + (remembered ? 0 : insets.height), ...(manual ? { restore: true } : {}),
      ...(remembered?.placement ? { restorePlacement: remembered.placement } : {}) });
    fittedDesktop = current; windowFitReady = true;
    const fitted = await window.anas.getContext();
    hostViewport = fitted.viewport; windowResizeRevision = fitted.windowResizeRevision ?? 0;
    normalWindowViewport = { width: size.width + (remembered ? 0 : insets.width), height: size.height + (remembered ? 0 : insets.height), revision: windowResizeRevision };
    if (!preparing && adaptiveEnabled() && dynamicResolutionAvailable()) {
      adaptedWindowRevision = windowResizeRevision;
      const target = remembered ? viewportResolution(size.width - insets.width, size.height - insets.height) : size;
      if (target) await adaptiveResolution.request(target);
    }
  } catch {
    if (current === desktop && !closing && (!handoff || preparing)) { fittedDesktop = current; failure('errors.window_size'); }
  } finally { fitScheduled = false; connectionOperations--; presentation(); }
}
function connectionActions(windowActions = false): Toolbar['actions'] {
  return [
    { id: 'ui-lock', label: t(uiLocked ? 'actions.unlock_ui' : 'actions.lock_ui'), icon: uiLocked ? 'assets/lock.svg' : 'assets/lock-open.svg', pressed: uiLocked, disabled: !connected || uiLockPending || handoff || !ready },
    ...(connectionProfile?.clipboardSupport ? [{ id: 'clipboard', label: clipboardState === 'initializing' ? t('clipboard.initializing') : clipboardEnabled ? `${t('actions.disable_clipboard')} · ${t('clipboard.' + clipboardState)}` : t('actions.enable_clipboard'), icon: 'assets/clipboard.svg', pressed: clipboardEnabled, disabled: !connected || clipboardState === 'initializing' || clipboardPending || handoff || !ready }] : []),
    ...(connected && clipboardEnabled && (downloadState?.offer || downloadState?.transfer?.state === 'running') ? [{ id: 'download', label: downloadLabel(), icon: 'assets/download.svg', disabled: downloadPending || downloadState.transfer?.state === 'running' || handoff || !ready }] : []),
    { id: 'reset-input', label: t('actions.reset_input'), icon: 'assets/input-reset.svg', disabled: !connected || inputResetPending || handoff || !ready },
    { id: 'input-text', label: t('actions.input_text'), icon: 'assets/keyboard.svg', disabled: !connected || uiLocked || handoff || !ready },
    ...(location === 'window' && !dynamicResolutionAvailable() ? [{ id: 'fit-window', label: t('actions.fit_window'), icon: 'assets/scan.svg',
      disabled: !connected || !desktop?.size || handoff || !ready }] : []),
    ...(connected && dynamicResolutionAvailable() && (!windowActions || location === 'window') ? [{ id: 'resolution-menu', icon: 'assets/resolution.svg',
      label: t(location === 'window' ? 'actions.window_resolution' : 'actions.desktop_resolution', { size: desktop?.size ? `${desktop.size.width} × ${desktop.size.height}` : '—' }),
      ...(location === 'sidebar' ? { description: t('actions.desktop_resolution_hint') } : {}), disabled: !connected || !ready || handoff || closing || fitScheduled || selectingResolution || adaptivePending || !desktop?.size || !!resizeFailure,
      items: [...resolutionChoices().map(({ width, height }) => ({ id: `resolution-${width}-${height}`, label: resolutionLabel({ width, height }), checked: desktop?.size?.width === width && desktop?.size?.height === height })),
        { id: 'adaptive-resolution', label: t('actions.adaptive_resolution'), checked: adaptiveEnabled(), separatorBefore: true }] }] : []),
    { id: 'disconnect', label: t(connecting ? 'actions.cancel' : 'actions.disconnect'), icon: connecting ? 'assets/x.svg' : 'assets/unplug.svg', disabled: instanceId === 'main' || !ready || handoff || closing || disconnecting },
    ...(!windowActions && location === 'sidebar' ? [{ id: 'move-window', label: t('actions.move_window'), icon: 'assets/move-window.svg',
      disabled: instanceId === 'main' || !ready || handoff || closing || disconnecting || movingWindow }] : []),
  ].map(action => ({ ...action, disabled: action.disabled || textInputBusy }));
}
function statusTone() { return connected ? 'success' : connecting || disconnecting ? 'warning' : 'neutral'; }
function presentation() {
  element('status').dataset.tone = statusTone();
  document.body.dataset.location = location;
  element('connection-header').hidden = instanceId !== 'main' && location === 'window' && toolbarReady;
  element('connection-name').hidden = !element('connection-header').hidden;
  element('move-window').hidden = instanceId === 'main' || location !== 'sidebar';
  element('download').hidden = !connected || !clipboardEnabled || (!downloadState?.offer && downloadState?.transfer?.state !== 'running');
  element('resolution-menu').hidden = instanceId === 'main' || !connected || !dynamicResolutionAvailable();
  element('fit-window').hidden = instanceId === 'main' || location !== 'window' || !!dynamicResolutionAvailable();
  for (const action of connectionActions()) {
    const button = element<HTMLButtonElement>(action.id);
    button.disabled = action.disabled;
    if (action.pressed !== undefined) button.setAttribute('aria-pressed', String(action.pressed));
    button.title = action.label;
    button.setAttribute('aria-label', action.label);
    const icon = button.querySelector<HTMLImageElement>('.action-icon')!;
    if (icon.getAttribute('src') !== action.icon) icon.src = action.icon;
  }
  updateAdaptiveResolution();
  if (toolbarReady) fitDesktopWindow();
  scheduleWindowState();
  if (!releaseToolbarListener || closing) return;
  const toolbar: Toolbar | null = instanceId === 'main' ? null : {
    status: { label: t(statusKey), tone: statusTone() },
    actions: connectionActions(true),
  };
  const snapshot = JSON.stringify(toolbar);
  if (snapshot === toolbarSnapshot) return;
  toolbarSnapshot = snapshot;
  const revision = ++toolbarRevision;
  toolbarUpdate = window.anas.setToolbar(toolbar).then(() => {
    if (closing || revision !== toolbarRevision) return;
    toolbarReady = true;
    element('toolbar-error').hidden = true;
    presentation();
  }).catch(() => {
    if (closing || revision !== toolbarRevision) return;
    toolbarReady = false;
    toolbarSnapshot = '';
    element('connection-header').hidden = false;
    element('connection-name').hidden = true;
    element('toolbar-error').textContent = t('errors.toolbar');
    element('toolbar-error').hidden = false;
  });
}
function status(key: string) {
  statusKey = key; element('status').textContent = t(key); element('status').title = t(key);
  element('connect').textContent = t(key === 'status.idle' || key === 'status.password_required' ? 'actions.connect' : 'actions.reconnect');
  presentation();
}
function renderError() {
  element('error').hidden = !errorKey;
  element('error-message').textContent = errorKey ? t(errorKey === 'errors.conflict' && editorOpen ? 'errors.conflict_editor' : errorKey) : '';
  element('reload-conflict').hidden = errorKey !== 'errors.conflict';
  element('retry-profiles').hidden = !errorKey || errorKey === 'errors.conflict' || instanceId !== 'main' || editorOpen;
}
function failure(key: string) { errorKey = key; renderError(); }
function profileFailure(error: unknown) {
  const code = String(error);
  if (code.includes('PANEL_')) failure('errors.move');
  else if (code.includes('RDP_PROFILE_ACTIVE')) failure('errors.active');
  else if (code.includes('RDP_PROFILE_OPEN')) failure('errors.profile_open');
  else if (code.includes('RDP_PROFILE_EDITING')) failure('errors.profile_editing');
  else if (code.includes('RDP_SESSION_CLOSED')) failure('errors.session_ended');
  else if (code.includes('RDP_SESSIONS_UNAVAILABLE')) failure('errors.sessions');
  else if (code.includes('PROFILE_CONFLICT')) failure('errors.conflict');
  else if (code.includes('PROFILE_MISSING')) failure('errors.missing');
  else if (code.includes('PASSWORD_UNREADABLE')) failure('errors.password');
  else if (code.includes('RDP_INVALID_RESOLUTION')) failure('errors.resolution');
  else if (code.includes('PROFILE_READ_FAILED')) failure('errors.read');
  else failure('errors.profile');
}
function controls() {
  element('connection').toggleAttribute('inert', !ready);
  element('profile-editor').toggleAttribute('inert', !ready);
  const busy = connecting || connected || disconnecting || savingTrust || editing || !ready;
  if (!connected) uiLocked = false;
  if (!connected) clipboardEnabled = false;
  element('clipboard').hidden = !connectionProfile?.clipboardSupport;
  const manager = instanceId === 'main';
  element('manager').hidden = !manager || editorOpen;
  element('manager').toggleAttribute('inert', !ready);
  element('profile-editor').hidden = !manager || !editorOpen;
  element('connection').hidden = manager || connected;
  element('connection-actions').hidden = manager;

  input('session-password').disabled = busy;
  element('session-password-field').hidden = !!connectionProfile?.hasPassword && !passwordPrompt;
  element('session-remember-field').hidden = element('session-password-field').hidden;
  input('session-remember-password').disabled = busy || errorKey === 'errors.missing';
  input('session-password').placeholder = connectionProfile?.hasPassword ? t('profiles.password_available') : '';
  element('disconnect').hidden = manager;
  element('connect').hidden = manager;
  element('cancel-edit').hidden = !manager;
  element('status').hidden = manager && statusKey === 'status.idle';
  input('connect').disabled = busy;
  input('accept-certificate').disabled = connecting || connected || savingTrust;
  for (const id of [...fieldIds, 'new', 'add-server', 'delete', 'save', 'up', 'down', 'cancel-edit', 'confirm-delete', 'cancel-delete', 'retry-profiles', 'reload-conflict']) input(id).disabled = busy;
  for (const row of Array.from(element('profiles').querySelectorAll<HTMLElement>('li'))) {
    const saved = profiles.some(profile => profile.id === row.dataset.id);
    for (const button of Array.from(row.querySelectorAll<HTMLButtonElement>('button'))) {
      button.disabled = busy || (button.dataset.action === 'edit' && (!saved || profileLocked(row.dataset.id))) || (['start', 'resume'].includes(button.dataset.action ?? '') && editingProfiles.includes(row.dataset.id!));
      if (button.dataset.action === 'edit') button.hidden = button.disabled;
    }
  }
  const locked = editorOpen && profileLocked(selected?.id);
  for (const id of [...fieldIds, 'save']) input(id).disabled ||= locked;
  const customResolution = input('resolution').value === 'custom';
  element('custom-resolution').hidden = !customResolution;
  for (const id of ['desktop-width', 'desktop-height']) input(id).disabled ||= !customResolution;
  element('edit-locked').hidden = !locked;
  element('edit-locked').textContent = t(!sessionsKnown ? 'errors.sessions' : openProfileIds.includes(selected?.id ?? '') ? 'errors.profile_open' : 'errors.active');
  input('delete').disabled ||= !selected || profileWorking(selected?.id);
  input('delete').title = t(selected && profileWorking(selected.id) ? 'errors.active' : 'actions.delete');
  input('confirm-delete').disabled ||= profileWorking(selected?.id);
  const index = profiles.findIndex(item => item.id === selected?.id);
  input('up').disabled ||= index <= 0;
  input('down').disabled ||= index < 0 || index === profiles.length - 1;
  if (!input('remember-password').checked) input('password').disabled = true;
  input('password').placeholder = selected?.hasPassword && !passwordEdited ? t('profiles.password_saved') : '';
  element('resize-warning').hidden = !connected || !resizeFailure;
  document.body.dataset.connected = String(connected);
  document.body.dataset.page = manager ? editorOpen ? 'editor' : 'manager' : connected ? 'desktop' : 'connection';
  presentation();
}
function selectProfile(profile?: Profile) {
  selected = profile;
  passwordEdited = false;
  deletePending = false;
  for (const key of ['host', 'username', 'domain'] as const) input(key).value = profile?.[key] ?? '';
  input('port').value = String(profile?.port ?? 3389);
  input('name').value = profile?.name ?? '';
  input('open-mode').value = profile?.openMode ?? 'sidebar';
  input('password').value = '';
  input('remember-password').checked = profile?.hasPassword ?? false;
  input('clipboard-support').checked = profile?.clipboardSupport ?? false;
  input('adaptive-window').checked = profile?.adaptiveWindow ?? false;
  input('adaptive-sidebar').checked = profile?.adaptiveSidebar ?? false;
  input('disable-mouse-animation').checked = profile?.disableMouseAnimation ?? false;
  input('desktop-width').value = String(profile?.desktopWidth ?? DEFAULT_DESKTOP_WIDTH);
  input('desktop-height').value = String(profile?.desktopHeight ?? DEFAULT_DESKTOP_HEIGHT);
  const size = `${input('desktop-width').value}x${input('desktop-height').value}`;
  input('resolution').value = Array.from(element<HTMLSelectElement>('resolution').options).some(option => option.value === size) ? size : 'custom';
  element('error').hidden = true;
  errorKey = undefined;
  element('retry-profiles').hidden = true;
  element('trust').hidden = true;
  pendingTrust = undefined;
  statusKey = 'status.idle';
  translate(); controls();
}
async function refreshProfiles(id = selected?.id) {
  profiles = await window.anas.backend.call('profiles.list', {}) as Profile[];
  const profile = id === undefined ? profiles[0] : profiles.find(item => item.id === id);
  renderProfiles();
  selectProfile(profile);
}
async function refreshSessions() {
  if (sessionRefresh) return sessionRefresh;
  sessionRefresh = (async () => {
    try {
      const runtime = await window.anas.backend.call('runtime.state', {}) as RuntimeState;
      const next = runtime.sessions;
      if (closing) return;
      const oldOrphans = runningSessions.filter(session => !profiles.some(profile => profile.id === session.profile.id)).map(session => session.id).join();
      const nextOrphans = next.filter(session => !profiles.some(profile => profile.id === session.profile.id)).map(session => session.id).join();
      if (JSON.stringify(next) !== JSON.stringify(runningSessions) || runtime.openProfiles.join() !== openProfileIds.join() || runtime.editingProfiles.join() !== editingProfiles.join()) closeContextMenu();
      runningSessions = next; openProfileIds = runtime.openProfiles; editingProfiles = runtime.editingProfiles; sessionsKnown = true;
      const clipboardError = next.find(item => item.id === session?.id);
      if (clipboardError?.clipboardErrors) {
        const key = `${clipboardError.id}:${clipboardError.clipboardErrors}`;
        if (key !== clipboardErrorSeen) { clipboardErrorSeen = key; failure('errors.clipboard_sync'); }
      }
      if (oldOrphans !== nextOrphans) renderProfiles();
    } catch {
      sessionsKnown = false; closeContextMenu();
      throw new Error('RDP_SESSIONS_UNAVAILABLE');
    } finally {
      if (!closing) { renderSessionStates(); controls(); }
    }
  })().finally(() => { sessionRefresh = undefined; });
  return sessionRefresh;
}
function renderSessionStates() {
  element('sessions-error').hidden = instanceId !== 'main' || sessionsKnown;
  element('sessions-error').textContent = t('errors.sessions');
  for (const row of Array.from(element('profiles').querySelectorAll<HTMLElement>('li'))) {
    const running = activeProfile(row.dataset.id);
    const hasDesktop = openProfileIds.includes(row.dataset.id!);
    const key = !sessionsKnown ? 'status.unknown' : !running ? hasDesktop ? 'status.disconnected' : '' : running.state === 'connected' ? 'status.connected' : 'status.connecting';
    const badge = row.querySelector<HTMLElement>('.profile-status')!;
    badge.hidden = !key;
    badge.textContent = key ? t(key) : '';
    badge.dataset.state = !sessionsKnown ? 'unknown' : running?.state === 'connected' ? 'connected' : running ? 'connecting' : 'stopped';
    row.classList.toggle('running', !!running);
    const button = row.querySelector<HTMLButtonElement>('[data-action=start], [data-action=resume]')!;
    button.dataset.action = running ? 'resume' : 'start';
    button.textContent = t(running ? 'actions.resume' : 'actions.start');
    const deleted = row.querySelector<HTMLElement>('.profile-deleted')!;
    deleted.hidden = profiles.some(profile => profile.id === row.dataset.id);
    deleted.textContent = t('profiles.removed');
  }
}
function renderProfiles() {
  closeContextMenu();
  const entries = [...profiles, ...runningSessions.filter(session => !profiles.some(profile => profile.id === session.profile.id)).map(session => session.profile)];
  element('profiles').replaceChildren(...entries.map(profile => {
    const row = document.createElement('li');
    row.dataset.id = profile.id;
    const choose = document.createElement('button');
    choose.type = 'button'; choose.className = 'profile-select';
    choose.setAttribute('aria-haspopup', 'menu');
    const name = document.createElement('strong'); name.textContent = profile.name;
    const address = document.createElement('small');
    address.textContent = `${profile.host.includes(':') ? `[${profile.host}]` : profile.host}:${profile.port}`;
    const detail = document.createElement('span'); detail.className = 'profile-detail';
    const badge = document.createElement('span'); badge.className = 'profile-status';
    const deleted = document.createElement('span'); deleted.className = 'profile-deleted';
    detail.append(address, badge, deleted);
    choose.append(name, detail);
    choose.addEventListener('click', () => selectProfile(profiles.find(item => item.id === profile.id)));
    choose.addEventListener('dblclick', () => { void startProfile(profile.id, !!activeProfile(profile.id)); });
    row.addEventListener('contextmenu', event => {
      event.preventDefault(); showProfileMenu(profile.id, choose, { x: event.clientX, y: event.clientY });
    });
    row.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const bounds = choose.getBoundingClientRect();
      showProfileMenu(profile.id, choose, { x: bounds.left, y: bounds.bottom });
    });
    choose.addEventListener('keydown', event => {
      const buttons = Array.from(element('profiles').querySelectorAll<HTMLButtonElement>('.profile-select'));
      const index = buttons.indexOf(choose);
      const next = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
      if (next >= 0 && next < buttons.length) { event.preventDefault(); buttons[next].click(); buttons[next].focus(); }
    });
    const actions = document.createElement('div'); actions.className = 'row-actions';
    for (const action of ['start', 'edit'] as const) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.action = action;
      button.addEventListener('click', () => {
        if (action === 'start') void startProfile(profile.id, button.dataset.action === 'resume');
        else void openEditor(profile.id);
      });
      actions.append(button);
    }
    row.append(choose, actions);
    return row;
  }));
  element('empty').hidden = entries.length > 0;
  renderSessionStates();
}
function focusSelectedProfile(id = selected?.id) {
  const row = Array.from(element('profiles').children).find(row => (row as HTMLElement).dataset.id === id);
  row?.querySelector<HTMLButtonElement>('.profile-select')?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'nearest' });
}
function showProfileMenu(id: string, trigger: HTMLElement, point: { x: number; y: number }) {
  if (instanceId !== 'main' || !ready || editing || editorOpen || handoff) return;
  const index = profiles.findIndex(profile => profile.id === id);
  const running = activeProfile(id);
  if (index < 0 && !running) return;
  selectProfile(profiles[index]);
  openContextMenu(trigger, point, t('fields.profiles'), [
    ...(['sidebar', 'window'] as const).map(location => ({ label: t(`actions.${running ? 'resume' : 'start'}_${location}`), action: () => { void startProfile(id, !!running, location); } })),
    ...(running || openProfileIds.includes(id) ? [{ label: t('actions.disconnect'), action: () => { void disconnectProfile(id); } }] : []),
    ...(index < 0 ? [] : [
    { label: t('actions.edit'), disabled: profileLocked(id), action: () => { void openEditor(id); } },
    { label: t('actions.copy'), action: () => { void copyProfile(id); } },
    'separator',
    { label: t('actions.up'), disabled: index === 0, action: () => { void moveProfile(id, -1); } },
    { label: t('actions.down'), disabled: index === profiles.length - 1, action: () => { void moveProfile(id, 1); } },
    'separator',
    { label: t('actions.delete'), disabled: profileWorking(id), danger: true, action: () => { void requestDelete(id); } },
    ] as Parameters<typeof openContextMenu>[3]),
  ]);
}
async function disconnectProfile(id: string) {
  await edit(async () => {
    await window.anas.backend.call('server.close', { profile_id: id }, { concurrent: true });
    await refreshSessions();
    status('status.disconnected');
  });
}
async function loadSavedProfile(id: string): Promise<Profile> {
  // Connection pages may have saved a password since the list was loaded.
  // Refresh before starting/editing, but never replace an already-open draft.
  await refreshProfiles(id);
  if (!selected) throw new Error('PROFILE_MISSING');
  return selected;
}
async function openEditor(id: string) {
  await edit(async () => {
    await refreshSessions();
    if (activeProfile(id)) throw new Error('RDP_PROFILE_ACTIVE');
    await window.anas.backend.call('profiles.beginEdit', { id });
    try { await loadSavedProfile(id); returnId = id; editorOpen = true; translate(); }
    catch (error) { await window.anas.backend.call('profiles.endEdit', { id }); throw error; }
  });
  if (editorOpen && selected?.id === id) input('name').focus();
}
async function startProfile(id: string, resumeOnly = false, openLocation?: 'sidebar' | 'window') {
  await edit(async () => {
    await refreshSessions();
    if (editingProfiles.includes(id)) throw new Error('RDP_PROFILE_EDITING');
    if (resumeOnly && !activeProfile(id)) throw new Error('RDP_SESSION_CLOSED');
    await window.anas.backend.call('server.open', { profile_id: id, state: 'foreground', ...(openLocation ? { location: openLocation } : {}) }, { concurrent: true });
    await refreshProfiles(id);
    status('status.opened');
  });
}
async function saveProfile() {
  const size = resolution(Number(input('desktop-width').value), Number(input('desktop-height').value));
  const next = await window.anas.backend.call('profiles.save', {
    ...target(), ...size, id: selected?.id, revision: selected?.revision,
    name: input('name').value.trim() || input('host').value.trim(), openMode: input('open-mode').value,
    clipboardSupport: input('clipboard-support').checked,
    adaptiveWindow: input('adaptive-window').checked, adaptiveSidebar: input('adaptive-sidebar').checked,
    disableMouseAnimation: input('disable-mouse-animation').checked,
    passwordAction: !input('remember-password').checked ? 'remove' : selected?.hasPassword && !passwordEdited ? 'keep' : 'set',
    ...(input('remember-password').checked && (passwordEdited || !selected?.hasPassword) ? { password: input('password').value } : {}),
  }) as Profile;
  selected = next;
  passwordEdited = false;
  if (next.hasPassword) input('password').value = '';
  return next;
}
async function edit(action: () => Promise<void>) {
  if (instanceId !== 'main' || editing || !ready) return;
  editing = true; element('error').hidden = true; element('retry-profiles').hidden = true; errorKey = undefined; controls();
  try { await action(); } catch (error) { profileFailure(error); }
  finally { editing = false; controls(); }
}
function target(): Target { return { host: input('host').value.trim(), port: Number(input('port').value), username: input('username').value, domain: input('domain').value }; }
async function toggleUiLock() {
  const current = session, currentDesktop = desktop;
  if (!current || !currentDesktop || !connected || uiLockPending || handoff || !ready) return;
  uiLockPending = true; controls();
  try {
    const result = await window.anas.backend.call('setUiLocked', { owner, id: current.id, locked: !uiLocked }) as { ui_locked: boolean; uiRevision: number };
    if (closing || session !== current || desktop !== currentDesktop) return;
    currentDesktop.updateInputLock(result.ui_locked, result.uiRevision);
    if (errorKey === 'errors.input_lock') { errorKey = undefined; renderError(); }
  } catch { if (session === current && !closing) failure('errors.input_lock'); }
  finally { uiLockPending = false; if (!closing) controls(); }
}
async function toggleClipboard() {
  const current = session;
  if (!current || !connected || clipboardState === 'initializing' || clipboardPending || handoff || !ready) return;
  clipboardPending = true; controls();
  try {
    const currentDesktop = desktop;
    const result = await window.anas.backend.call('setClipboardEnabled', { owner, id: current.id, enabled: !clipboardEnabled }) as { enabled: boolean; revision: number };
    if (session === current && desktop === currentDesktop && !closing) currentDesktop?.updateClipboard(result.enabled, result.revision);
    if (session === current && !closing && ['errors.clipboard', 'errors.clipboard_busy'].includes(errorKey ?? '')) { errorKey = undefined; renderError(); }
  } catch (error) { if (session === current && !closing) failure(String(error).includes('RDP_CLIPBOARD_BUSY') ? 'errors.clipboard_busy' : 'errors.clipboard'); }
  finally { clipboardPending = false; if (!closing) controls(); }
}
async function resetInput() {
  const current = session;
  if (!current || !connected || inputResetPending || handoff || !ready) return;
  inputResetPending = true; controls();
  try {
    await window.anas.backend.call('resetInput', { owner, id: current.id });
    if (session === current && !closing && errorKey === 'errors.input_reset') { errorKey = undefined; renderError(); }
  } catch { if (session === current && !closing) failure('errors.input_reset'); }
  finally { inputResetPending = false; if (!closing) controls(); }
}
async function disconnect(closeDesktop = false) {
  if (disconnecting) return;
  disconnecting = true;
  const mine = ++generation, old = session;
  connecting = false; connected = false;
  desktop?.dispose(); desktop = undefined; lease = null;
  status('status.disconnecting'); controls();
  try {
    if (closeDesktop) await window.anas.backend.call('server.close', { profile_id: owner }, { concurrent: true });
    else if (old) await window.anas.backend.call('disconnect', { owner, id: old.id });
    if (session === old) session = undefined;
  } catch {
    // Keep the failed resource identity. Polling may attach a replacement, but
    // must never interpret this same, unsuccessfully stopped resource as new.
    if (generation === mine) {
      if (!session) session = (await window.anas.backend.call('find', { owner }).catch(() => null) as SessionRef | null) ?? undefined;
      if (generation === mine) failure('errors.cleanup');
    }
  } finally {
    disconnecting = false;
    if (generation === mine) { status('status.disconnected'); controls(); }
  }
}
async function attach(connection: SessionRef, signal?: AbortSignal) {
  signal?.throwIfAborted();
  desktop?.dispose();
  clipboardEnabled = false; clipboardState = 'initializing';
  resizeFailure = ''; resizeSupported = false; element('resize-warning').hidden = true; adaptiveResolution.suspend();
  const mine = new Desktop(element('desktop'), { ...connection, pageId: pageContext.pageId }, (state, locked) => {
    if (closing || session !== connection) return;
    uiLocked = locked;
    if (state === 'connected') { connected = true; status('status.connected'); }
    else if (state === 'connecting') status('status.authenticating');
    else if (state === 'closed' || state.startsWith('RDP_') || state === 'connection_failed') {
      connected = false;
      status('status.disconnected');
      if (!handoff) failure('errors.interrupted');
      void refreshDisconnectedSession().catch(() => {});
    }
    controls();
  }, presentation, (enabled, state) => { clipboardEnabled = enabled; if (state) clipboardState = state; controls(); }, connectionProfile?.disableMouseAnimation ?? false, reportResizeError, supported => { if (session === connection && !closing) { resizeSupported = supported; presentation(); } });
  desktop = mine;
  mine.canvas.setAttribute('aria-label', t('plugin.name'));
  const cancel = () => { if (desktop === mine) desktop = undefined; mine.dispose(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try { await mine.ready; signal?.throwIfAborted(); }
  finally { signal?.removeEventListener('abort', cancel); }
}
async function currentLease(): Promise<Lease> {
  return await window.anas.backend.call('lease', { owner, id: session!.id }) as Lease;
}
async function claim(expected: Lease, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const granted = await window.anas.backend.call('claim', { owner, id: session!.id, pageId: pageContext.pageId,
    expected: expected.owner, expectedEpoch: expected.epoch }) as Lease;
  signal?.throwIfAborted();
  lease = granted;
}
// Resource state and display attachment state have different lifetimes.
async function refreshSession(signal?: AbortSignal, keepLastFrame = false): Promise<boolean> {
  const current = session;
  const mine = generation;
  if (!current) return false;
  let ended = false;
  try {
    const info = await window.anas.backend.call('status', { owner, id: current.id }) as SessionStatus;
    if (session === current && generation === mine && connectionProfile) {
      connectionProfile.adaptiveWindow = info.adaptiveWindow; connectionProfile.adaptiveSidebar = info.adaptiveSidebar;
    }
    ended = ['closed', 'connection_failed', 'certificate_required'].includes(info.state);
  } catch (error) {
    if (!String(error).includes('RDP_SESSION_CLOSED')) throw error;
    ended = true;
  }
  signal?.throwIfAborted();
  if (closing || generation !== mine || session !== current) return Boolean(session);
  if (ended) {
    if (!keepLastFrame) { desktop?.dispose(); desktop = undefined; }
    session = undefined; lease = null; connected = false;
    status('status.disconnected'); controls();
  }
  return !ended;
}
async function refreshDisconnectedSession() {
  if (closing || handoff || connecting || connected || !session) return;
  // A display socket can close before the native process reports its final state.
  // Recheck on normal refreshes, retaining the last frame and any still-live resource.
  await refreshSession(undefined, true);
}
async function restoreInput(signal: AbortSignal) {
  signal.throwIfAborted();
  // A cancelled prepare may leave the original connection operation running.
  // It still owns its eventual claim; a not-yet-ready display cannot be claimed.
  if (connectionOperations || connecting) return;
  if (!(await refreshSession(signal))) return;
  try {
    if (!desktop?.available) await attach(session!, signal);
    await claim(await currentLease(), signal);
  } catch (error) {
    signal.throwIfAborted();
    // A real session can end between status, attachment and claim. Release its
    // presentation without blocking recovery of the disconnected controls.
    if (await refreshSession(signal)) throw error;
  }
}
async function connect() {
  if (instanceId === 'main' || handoff || connecting || connected || disconnecting || savingTrust || !ready) return;
  let password = input('session-password').value;
  const rememberPassword = input('session-remember-password').checked && !element('session-remember-field').hidden;
  const mine = ++generation;
  connecting = true;
  pendingTrust = undefined;
  element('trust').hidden = true;
  element('error').hidden = true;
  errorKey = undefined;
  status('status.connecting');
  controls();
  let prepared = false, reattaching = false;
  connectionOperations++;
  try {
    // A handoff waits for this already-started operation; only cancellation stops it.
    if (closing || generation !== mine) return;
    const live = session && await refreshSession();
    if (generation !== mine) return;
    if (live) {
      // Recover the display attachment, never replace the authenticated session.
      reattaching = true;
      await attach(session!);
    } else {
      const profile = await window.anas.backend.call('profiles.get', { id: instanceId }) as Profile;
      if (generation !== mine) return;
      connectionProfile = profile;
      translate();
      // Only an explicit Remember choice persists this credential, without editing the target.
      if (profile.hasPassword && !password) password = await window.anas.backend.call('profiles.password', { id: profile.id, revision: profile.revision }) as string;
      if (generation !== mine) return;
      if (rememberPassword) {
        const saved = await window.anas.backend.call('profiles.savePassword', { id: profile.id, revision: profile.revision, password }) as Profile;
        if (generation !== mine) return;
        connectionProfile = saved;
      }
      trusts = await window.anas.backend.call('trusts.list', {}) as Trust[];
      if (generation !== mine) return;
      prepared = true;
      const trustedSha256 = trusts.find(item => item.host === profile.host && item.port === profile.port)?.sha256;
      const created = await window.anas.backend.call('create', { owner, name: profile.name, openMode: profile.openMode, clipboardSupport: profile.clipboardSupport, adaptiveWindow: profile.adaptiveWindow, adaptiveSidebar: profile.adaptiveSidebar, disableMouseAnimation: profile.disableMouseAnimation, desktopWidth: profile.desktopWidth, desktopHeight: profile.desktopHeight, host: profile.host, port: profile.port, username: profile.username, domain: profile.domain, password, trustedSha256 }, { concurrent: true }) as SessionRef & { reused?: boolean };
      if (generation !== mine) return;
      reattaching = created.reused === true;
      session = created;
      await attach(created);
    }
    if (generation !== mine) return;
    await claim(await currentLease());
    input('session-password').value = '';
    input('session-remember-password').checked = false;
    passwordPrompt = false;
    connecting = false;
    connected = true;
    status('status.connected');
    controls();
  } catch (error) {
    if (generation !== mine) return;
    if (reattaching) {
      await refreshSession().catch(() => undefined);
      if (generation !== mine) return;
      connecting = false; connected = false;
      status('status.disconnected'); failure('errors.interrupted'); controls();
      return;
    }
    const info = session ? await window.anas.backend.call('status', { owner, id: session.id }).catch(() => null) as SessionStatus | null : null;
    if (generation !== mine) return;
    if (!prepared) profileFailure(error);
    else if (info?.state === 'certificate_required' && info.certificate) {
      pendingTrust = { host: connectionProfile!.host, port: connectionProfile!.port, sha256: info.certificate.sha256 };
      element('fingerprint').textContent = pendingTrust.sha256;
      translateTrust();
      element('trust').hidden = false;
    } else failure('errors.connection');
    passwordPrompt = true;
    await disconnect();
  } finally { connectionOperations--; }
}

element('connection').addEventListener('submit', event => { event.preventDefault(); void connect(); });
element('profile-editor').addEventListener('submit', event => { event.preventDefault(); void saveEditor(); });
element('password').addEventListener('input', () => { passwordEdited = true; });
element('remember-password').addEventListener('change', () => controls());
element('resolution').addEventListener('change', () => {
  if (input('resolution').value !== 'custom') {
    const [width, height] = input('resolution').value.split('x');
    input('desktop-width').value = width;
    input('desktop-height').value = height;
  }
  controls();
});
function newProfile() { closeContextMenu(); returnId = selected?.id; editorOpen = true; selectProfile(); input('name').focus(); }
element('new').addEventListener('click', newProfile);
element('add-server').addEventListener('click', newProfile);
async function saveEditor() {
  if (!element<HTMLFormElement>('profile-editor').reportValidity()) return;
  await edit(async () => { const profile = await saveProfile(); await refreshProfiles(profile.id); await window.anas.backend.call('profiles.endEdit', { id: profile.id }); editorOpen = false; await refreshSessions(); translate(); status('status.saved'); });
}
element('cancel-edit').addEventListener('click', () => void edit(async () => { const id = selected?.id; await refreshProfiles(returnId); if (id) await window.anas.backend.call('profiles.endEdit', { id }); editorOpen = false; await refreshSessions(); translate(); }));
element('retry-profiles').addEventListener('click', () => void edit(async () => { await refreshProfiles(); status('status.reloaded'); }));
element('reload-conflict').addEventListener('click', async () => {
  if (errorKey !== 'errors.conflict' || !ready || handoff || editing || connecting || connected || disconnecting || savingTrust) return;
  editing = true; controls();
  try {
    if (instanceId === 'main' && !editorOpen) await refreshProfiles();
    else {
      const profile = await window.anas.backend.call('profiles.get', { id: editorOpen ? selected!.id : instanceId }) as Profile;
      if (editorOpen) selectProfile(profile);
      else {
        connectionProfile = profile;
        passwordPrompt = !profile.hasPassword || !!input('session-password').value;
        pendingTrust = undefined; element('trust').hidden = true;
      }
    }
    errorKey = undefined; translate(); status('status.reloaded');
  } catch (error) { profileFailure(error); }
  finally { editing = false; controls(); }
});
async function copyProfile(id: string) {
  await edit(async () => {
    const original = await loadSavedProfile(id);
    const profile = await window.anas.backend.call('profiles.copy', { id: original.id, revision: original.revision,
      name: t('profiles.copy_name', { name: original.name.slice(0, 100) }).slice(0, 120) }) as Profile;
    await refreshProfiles(profile.id); status('status.copied');
  });
  focusSelectedProfile();
}
async function requestDelete(id: string) {
  await edit(async () => { await refreshSessions(); if (activeProfile(id)) throw new Error('RDP_PROFILE_ACTIVE'); await loadSavedProfile(id); deletePending = true; translate(); });
  if (deletePending) input('cancel-delete').focus();
}
element('delete').addEventListener('click', () => { if (selected) void requestDelete(selected.id); });
element('cancel-delete').addEventListener('click', () => { deletePending = false; translate(); focusSelectedProfile(); });
element('confirm-delete').addEventListener('click', () => {
  if (!deletePending || !selected) return;
  void edit(async () => {
    const index = profiles.findIndex(item => item.id === selected?.id);
    const nextId = profiles[index + 1]?.id ?? profiles[index - 1]?.id;
    await window.anas.backend.call('profiles.delete', { id: selected?.id, revision: selected?.revision });
    await refreshProfiles(nextId); status('status.deleted');
  });
});
async function moveProfile(id: string, direction: -1 | 1) {
  await edit(async () => {
    const index = profiles.findIndex(item => item.id === id);
    const profile = profiles[index];
    if (!profile || !profiles[index + direction]) return;
    profiles = await window.anas.backend.call('profiles.move', { id, revision: profile.revision, direction, neighborId: profiles[index + direction].id }) as Profile[];
    renderProfiles(); selectProfile(profiles.find(item => item.id === id)); status('status.reordered');
  });
  focusSelectedProfile();
}
for (const [id, direction] of [['up', -1], ['down', 1]] as const) element(id).addEventListener('click', () => {
  if (selected) void moveProfile(selected.id, direction);
});
element('download').addEventListener('click', () => void startDownload());
element('download-cancel').addEventListener('click', async () => {
  const current = session, task = downloadState?.transfer;
  if (!current || !task || task.state !== 'running' || downloadPending) return;
  downloadPending = true; ++downloadRevision; renderDownload();
  try { await window.anas.backend.call('downloadCancel', { owner, id: current.id, transferId: task.id }); }
  catch (error) { if (!closing) downloadIssue = String(error); }
  finally { downloadPending = false; if (!closing) { renderDownload(); await refreshDownload(); } }
});
element('download-reveal').addEventListener('click', () => {
  const path = downloadState?.transfer?.path;
  if (path) void window.anas.showItemInFolder(path).catch(() => { downloadIssue = 'RDP_DOWNLOAD_REVEAL'; renderDownload(); });
});
element('download-dismiss').addEventListener('click', () => { dismissedDownload = downloadState?.transfer?.id ?? ''; downloadIssue = undefined; renderDownload(); });
element('clipboard').addEventListener('click', () => void toggleClipboard());
element('ui-lock').addEventListener('click', () => void toggleUiLock());
element('reset-input').addEventListener('click', () => void resetInput());
element('fit-window').addEventListener('click', () => void fitDesktopWindow(true));
element('input-text').addEventListener('click', openTextInput);
element('resolution-menu').addEventListener('click', () => {
  const action = connectionActions().find(action => action.id === 'resolution-menu');
  if (!action || action.disabled) return;
  const button = element('resolution-menu'), bounds = button.getBoundingClientRect();
  openContextMenu(button, { x: bounds.left, y: bounds.bottom + 4 }, action.label,
    [...resolutionChoices().map(size => ({ label: resolutionLabel(size),
      checked: desktop?.size?.width === size.width && desktop?.size?.height === size.height,
      action: () => { void selectResolution(size); } })), 'separator',
      { label: t('actions.adaptive_resolution'), checked: adaptiveEnabled(), checkType: 'checkbox', action: () => { void toggleAdaptive(); } }]);
});
element('move-window').addEventListener('click', async () => {
  if (instanceId === 'main' || location !== 'sidebar' || !ready || handoff || closing || disconnecting || movingWindow) return;
  movingWindow = true; controls();
  try { await window.anas.moveView('window'); }
  catch { if (!closing) failure('errors.move'); }
  finally { movingWindow = false; if (!closing) controls(); }
});
element('disconnect').addEventListener('click', () => void disconnect(true));
element('accept-certificate').addEventListener('click', async () => {
  const current = connectionProfile;
  if (savingTrust || connecting || connected || !pendingTrust || !current || pendingTrust.host !== current.host || pendingTrust.port !== current.port) return;
  const mine = generation;
  savingTrust = true;
  controls();
  try {
    trusts = await window.anas.backend.call('trusts.save', pendingTrust) as Trust[];
  } catch {
    failure('errors.trust');
    return;
  } finally { savingTrust = false; controls(); }
  if (generation !== mine) return;
  await connect();
});
let infoTimer: ReturnType<typeof setInterval> | undefined;
let launchTimer: ReturnType<typeof setInterval> | undefined;
let checkingLaunch = false;
let closing = false;
let releaseViewListener: (() => void) | undefined;
async function checkLaunch() {
  if (handoff || checkingLaunch || closing || !ready || instanceId === 'main') return;
  checkingLaunch = true;
  const busy = connecting || connected || disconnecting || editing || savingTrust;
  const mine = generation;
  try {
    if (closing || handoff || mine !== generation) return;
    const profile = await window.anas.backend.call('profiles.consumeLaunch', { id: instanceId, location }) as Profile | null;
    if (busy || closing || mine !== generation || connecting || connected || disconnecting || editing || savingTrust) return;
    // A tool can reconnect the server while this disconnected page remains open.
    // Reattach its current connection instead of leaving the old error screen.
    if (!profile) {
      await refreshDisconnectedSession();
      const live = await window.anas.backend.call('find', { owner }) as SessionRef | null;
      if (!live || live.id === session?.id || closing || handoff || mine !== generation || connecting || connected || disconnecting) return;
      session = live;
      void connect();
      return;
    }
    if (session) {
      const live = await refreshSession();
      if (closing || handoff || mine !== generation) return;
      if (live) { void connect(); return; }
    }
    connectionProfile = profile;
    passwordPrompt = !profile.hasPassword;
    pendingTrust = undefined; element('trust').hidden = true;
    errorKey = undefined; element('error').hidden = true;
    input('session-password').value = '';
    input('session-remember-password').checked = false;
    translate();
    if (profile.hasPassword) void connect();
    else { status('status.password_required'); input('session-password').focus(); }
  } catch (error) { if (!busy && !closing) profileFailure(error); }
  finally { checkingLaunch = false; }
}
function disposePage() {
  adaptiveResolution.dispose();
  clearTimeout(windowStateTimer);
  closeContextMenu();
  closing = true; releaseViewListener?.(); releaseToolbarListener?.(); clearInterval(infoTimer); clearInterval(launchTimer); clearInterval(sessionTimer); clearInterval(downloadTimer);
  desktop?.dispose(); desktop = undefined;
}
window.addEventListener('pagehide', disposePage);
async function idle(signal: AbortSignal) {
  while (uiLockPending || inputResetPending || clipboardPending || (!closing && (connectionOperations || connecting || disconnecting)) || savingTrust || editing || checkingLaunch || refreshingInfo || sessionRefresh) {
    signal.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  signal.throwIfAborted();
}
const fieldIds = ['host', 'port', 'username', 'domain', 'password', 'name', 'open-mode', 'remember-password', 'clipboard-support', 'disable-mouse-animation', 'adaptive-window', 'adaptive-sidebar', 'resolution', 'desktop-width', 'desktop-height'];
window.anas.registerLifecycle({
  async prepare({ signal }) {
    const savingWindowState = flushWindowState();
    closeContextMenu();
    handoff = true;
    await textInput.pause();
    adaptiveResolution.suspend();
    desktop?.release();
    await savingWindowState;
    await idle(signal);
    lease = null;
    if (await refreshSession(signal)) {
      try { lease = await currentLease(); }
      catch (error) { if (await refreshSession(signal)) throw error; }
    }
    signal.throwIfAborted();
    const view: ViewState = instanceId === 'main'
      ? { kind: 'manager', selected, editorOpen, returnId, passwordEdited, deletePending,
          fields: Object.fromEntries(fieldIds.map(id => [id, { value: input(id).value, checked: input(id).checked }])) }
      : { kind: 'connection', profile: connectionProfile, password: input('session-password').value, rememberPassword: input('session-remember-password').checked, passwordPrompt, pendingTrust };
    return { session: session ?? null, lease, view, statusKey, errorKey, scroll: document.querySelector('main')!.scrollTop, textDraft: textInput.snapshot() };
  },
  async activate({ signal, context }) {
    pageContext = context; windowMode = context.windowMode; windowResizeRevision = context.windowResizeRevision ?? 0; windowPlacement = context.windowPlacement; hostViewport = context.viewport; presentationVisible = context.view.activity?.visible !== false;
    if (await refreshSession(signal)) {
      try { await claim(lease ?? await currentLease(), signal); }
      catch (error) { if (await refreshSession(signal)) throw error; }
    }
    signal.throwIfAborted();
    await toolbarUpdate;
    if (context.phase === 'preparing') {
      if (!desktop?.size && location === 'window' && connectionProfile && toolbarReady) {
        // The connected window has no plugin chrome around its desktop. Size
        // the connection form for that desktop before the host first shows it.
        try { await window.anas.resizeWindow({ width: connectionProfile.desktopWidth ?? DEFAULT_DESKTOP_WIDTH, height: connectionProfile.desktopHeight ?? DEFAULT_DESKTOP_HEIGHT }); }
        catch { failure('errors.window_size'); }
      } else await fitDesktopWindow(false, true);
    }
    signal.throwIfAborted();
    handoff = false; controls();
  },
  async resume({ signal }) {
    await restoreInput(signal);
    signal.throwIfAborted();
    handoff = false; controls();
  },
  async dispose({ signal, reason }) {
    const savingWindowState = reason === 'closed' ? flushWindowState() : windowStateWrites;
    handoff = true;
    await textInput.pause();
    await savingWindowState;
    adaptiveResolution.suspend();
    signal.throwIfAborted();
    if (reason === 'closed' && instanceId !== 'main') {
      // Cancel presentation work even while connecting. The backend serializes
      // closing with create; closing the presentation keeps the connection alive.
      closing = true; ++generation; connecting = false;
      try {
        await window.anas.backend.call('connection.close', { owner: instanceId });
        desktop?.dispose(); desktop = undefined;
        await idle(signal);
      } catch (error) { closing = false; throw error; }
    } else await idle(signal);
    disposePage();
  }
});

function translateTrust() {
  if (pendingTrust) element('trust-message').textContent = t('certificate.verify', { host: pendingTrust.host, port: pendingTrust.port });
}
function translate() {
  textInput.render();
  renderDownload();
  const labels: Record<string, string> = { name: 'name', 'open-mode': 'open_mode', 'clipboard-support': 'clipboard_support', 'disable-mouse-animation': 'disable_mouse_animation', 'adaptive-window': 'adaptive_window', 'adaptive-sidebar': 'adaptive_sidebar', 'remember-password': 'remember_password', 'session-remember-password': 'remember_password', host: 'host', port: 'port', username: 'username', domain: 'domain', password: 'password', resolution: 'resolution', 'desktop-width': 'desktop_width', 'desktop-height': 'desktop_height' };
  for (const [id, key] of Object.entries(labels)) document.querySelector('[data-label="' + id + '"]')!.textContent = t('fields.' + key);
  const buttons = { 'add-server': 'actions.add_server', 'cancel-edit': 'actions.cancel', 'confirm-delete': 'actions.delete', 'cancel-delete': 'actions.cancel', 'retry-profiles': 'actions.retry', 'reload-conflict': 'actions.reload', save: 'actions.save', 'mode-sidebar': 'modes.sidebar', 'mode-window': 'modes.window', 'accept-certificate': 'certificate.accept' };
  for (const [id, key] of Object.entries(buttons)) element(id).textContent = t(key);
  element('resolution-custom').textContent = t('fields.custom_resolution');
  for (const [id, key] of Object.entries({ new: 'actions.new', delete: 'actions.delete', up: 'actions.up', down: 'actions.down' })) {
    element(id).title = t(key); element(id).setAttribute('aria-label', t(key));
  }
  for (const row of Array.from(element('profiles').querySelectorAll<HTMLElement>('li'))) {
    row.classList.toggle('selected', row.dataset.id === selected?.id);
    row.querySelector('button')!.setAttribute('aria-pressed', String(row.dataset.id === selected?.id));
    for (const button of Array.from(row.querySelectorAll<HTMLElement>('[data-action]'))) button.textContent = t(`actions.${button.dataset.action}`);
  }
  renderSessionStates();
  element('profiles').setAttribute('aria-label', t('fields.profiles'));
  element('toolbar').setAttribute('aria-label', t('fields.profiles'));
  element('empty-message').textContent = t('profiles.empty');
  element('delete-confirm').hidden = !deletePending;
  element('delete-message').textContent = t('profiles.delete_confirm', { name: selected?.name ?? '' });
  element('session-password-label').textContent = t('fields.password');
  const profile = connectionProfile;
  element('connection-name').textContent = profile?.name ?? t('plugin.name');
  element('connection-target').textContent = profile ? `${profile.host.includes(':') ? `[${profile.host}]` : profile.host}:${profile.port} · ${profile.domain ? profile.domain + '\\' : ''}${profile.username}` : '';
  element('language-warning').textContent = t('errors.language');
  element('desktop').setAttribute('aria-label', t('plugin.name'));
  element('title').textContent = instanceId === 'main' ? (editorOpen ? selected ? t('profiles.edit', { name: selected.name }) : t('profiles.new') : t('plugin.name')) : connectionProfile?.name ?? t('plugin.name');
  element('title').title = element('title').textContent;
  document.title = element('title').textContent;
  element('toolbar-error').textContent = t('errors.toolbar');
  if (resizeFailure) element('resize-warning').textContent = t(resizeFailure === 'RDP_RESIZE_UNSUPPORTED' ? 'errors.resize_unsupported' : 'errors.resize_failed');
  status(statusKey);
  renderError();
  translateTrust();
  controls();
}
let refreshingInfo = false;
async function syncInfo() {
  if (refreshingInfo) return;
  refreshingInfo = true;
  try {
    const info = await window.anas.getInfo();
    await setLanguage(info.language);
    document.documentElement.lang = i18n.language;
    document.documentElement.dataset.theme = info.theme;
    document.documentElement.style.fontSize = `${info.fontSize}px`;
    translate();
    await refreshDisconnectedSession();
  } finally { refreshingInfo = false; }
}

try {
  pageContext = await window.anas.getContext();
  windowMode = pageContext.windowMode; windowResizeRevision = pageContext.windowResizeRevision ?? 0; windowPlacement = pageContext.windowPlacement; hostViewport = pageContext.viewport;
  presentationVisible = pageContext.view.activity?.visible !== false;
  instanceId = pageContext.view.content.instanceId;
  location = pageContext.location;
  owner = instanceId;
  const restore = pageContext.restoreState;
  const languages = await window.anas.getLanguageResources();
  await initializeLanguages(languages.resources);
  if (instanceId !== 'main') await window.anas.backend.call('connection.open', { owner });
  element('language-warning').hidden = languages.errors.length === 0;
  releaseToolbarListener = window.anas.onToolbarAction(async id => {
    const size = resolutionChoices().find(({ width, height }) => id === `resolution-${width}-${height}`);
    if (size) { await selectResolution(size); return; }
    if (id === 'adaptive-resolution') { await toggleAdaptive(); return; }
    if (id === 'fit-window') { await fitDesktopWindow(true); return; }
    if (id === 'download') { void startDownload(); return; }
    if (id === 'clipboard') { await toggleClipboard(); return; }
    if (id === 'ui-lock') { await toggleUiLock(); return; }
    if (id === 'reset-input') { await resetInput(); return; }
    if (id === 'input-text') { openTextInput(); return; }
    if (id !== 'disconnect' || instanceId === 'main' || !ready || handoff || closing || disconnecting) return;
    await disconnect(true);
  });
  let viewChanged = false;
  releaseViewListener = window.anas.onViewChanged(view => {
    viewChanged = true;
    instanceId = view.instanceId;
    location = view.location; windowMode = view.windowMode; windowResizeRevision = view.windowResizeRevision ?? 0; windowPlacement = view.windowPlacement; hostViewport = view.viewport;
    presentationVisible = view.activity?.visible !== false;
    presentation();
    if (!handoff) void checkLaunch();
  });
  const info = await window.anas.getInfo();
  if (!viewChanged) { instanceId = info.view.instanceId; location = info.view.location; }
  document.body.dataset.manager = String(instanceId === 'main');
  await syncInfo();
  if (restore) {
    // Handoff state is complete, including unsaved fields and the live resource.
    // Deleting a saved profile elsewhere must not invalidate this presentation.
    if (instanceId === 'main') { profiles = await window.anas.backend.call('profiles.list', {}) as Profile[]; renderProfiles(); }
    statusKey = restore.statusKey; errorKey = restore.errorKey; lease = restore.lease;
    const view = restore.view;
    if ((instanceId === 'main') !== (view.kind === 'manager')) throw new Error('Invalid page state');
    if (view.kind === 'manager') {
      selected = view.selected; editorOpen = view.editorOpen; returnId = view.returnId;
      passwordEdited = view.passwordEdited; deletePending = view.deletePending;
      for (const [id, field] of Object.entries(view.fields)) { input(id).value = field.value; input(id).checked = field.checked; }
    } else {
      connectionProfile = view.profile; passwordPrompt = view.passwordPrompt; pendingTrust = view.pendingTrust;
      input('session-password').value = view.password;
      input('session-remember-password').checked = view.rememberPassword;
    }
    document.querySelector('main')!.scrollTop = restore.scroll;
    textInput.restore(restore.textDraft);
    if (pendingTrust) { element('fingerprint').textContent = pendingTrust.sha256; element('trust').hidden = false; }
  } else if (instanceId === 'main') await refreshProfiles();
  else {
    try { connectionProfile = await window.anas.backend.call('profiles.get', { id: instanceId }) as Profile; }
    catch (error) {
      if (!String(error).includes('PROFILE_MISSING')) throw error;
      const resources = await window.anas.backend.call('runtime.state', {}) as RuntimeState;
      const resource = resources.sessions.find(session => session.profile.id === instanceId);
      if (!resource) throw error;
      connectionProfile = { ...resource.profile, hasPassword: false };
    }
    passwordPrompt = !connectionProfile.hasPassword;
  }
  session = restore?.session ?? (instanceId !== 'main' ? await window.anas.backend.call('find', { owner }) as SessionRef | null : null) ?? undefined;
  if (await refreshSession()) {
    try { await attach(session!); if (!lease) lease = await currentLease(); }
    catch (error) { if (await refreshSession()) throw error; }
  }
  if (instanceId === 'main') {
    if (editorOpen && selected) await window.anas.backend.call('profiles.beginEdit', { id: selected.id });
    await refreshSessions().catch(() => undefined);
  }
  ready = true;
  translate();
  controls();
  if (instanceId !== 'main') { launchTimer = setInterval(() => { void checkLaunch(); }, 1000); }
  await window.anas.ready();
  if (instanceId === 'main') sessionTimer = setInterval(() => { if (!handoff && !closing) void refreshSessions().catch(() => undefined); }, 1000);
  if (instanceId !== 'main') { await refreshDownload(); downloadTimer = setInterval(() => { void refreshDownload(); }, 750); }
  infoTimer = setInterval(() => { void syncInfo().catch(() => {}); }, 5000);
  window.addEventListener('focus', () => {
    void syncInfo().catch(() => {});
    void checkLaunch();
    if (instanceId === 'main' && !handoff && !closing) void refreshSessions().catch(() => undefined);
  });
} catch (error) { if (String(error).includes('PROFILE_')) profileFailure(error); else failure('errors.load'); await window.anas.failed().catch(() => undefined); }
