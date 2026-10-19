import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Profiles } from './profiles';
import { resolution } from './resolution';
import { requireWindowState, type WindowState } from './window-state';
import type { SessionSummary, RuntimeState, CallContext, Profile, Trust } from './profile-types';

type Context = { pluginId: string; packageDirectory: string; dataDirectory: string; tempDirectory: string; host: ToolContext['host'] & { onViewsChanged(listener: (views: CallContext['views']) => void): () => void } };
type Session = { profile: SessionSummary['profile']; owner: string; child: ChildProcessWithoutNullStreams; state: string; certificate?: { sha256: string; trusted: boolean };
  display: { id: string; url: string; token: string }; requests: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
  windowState?: WindowState;
  exited: Promise<void>; closed: boolean; uiLocked: boolean; clipboardEnabled: boolean; clipboardActive: boolean; clipboardPublish: boolean; clipboardState: string; clipboardErrors: number; changed: Set<() => void>;
};
type ToolContext = { signal: AbortSignal; deadline: number; host: { getViews(): Promise<CallContext['views']>;
  openView(options: { instanceId: string; location: 'sidebar' | 'window'; title?: string; icon?: string }): Promise<void>;
  moveView(options: { instanceId: string; location: 'sidebar' | 'window' }): Promise<void>;
  closeView(options: { instanceId: string }): Promise<void> } };
let context: Context;
let profiles: Profiles;
const sessions = new Map<string, Session>();
const editors = new Map<string, string>();
const opening = new Map<string, { token: unknown; expires: number }>();
const serverChanges = new Map<string, Promise<unknown>>();
const serverRequests = new Map<string, Set<AbortController>>();
let resourceChanges: Promise<unknown> = Promise.resolve();
let stopping = false;
const active = (session: Session) => !session.closed && !['closed', 'connection_failed', 'certificate_required'].includes(session.state);
const running = (owner: unknown) => [...sessions.values()].some(session => session.owner === owner && active(session));
function reconcileViews(views: CallContext['views']) {
  const visible = new Set(views.map(view => view.instanceId));
  for (const [id, panelId] of editors) if (!views.some(view => view.panelId === panelId)) editors.delete(id);
  for (const [id, request] of opening) if (visible.has(id) || request.expires <= Date.now()) opening.delete(id);
  return visible;
}
function waitForConnection(session: Session, signal: AbortSignal, deadline: number): Promise<void> {
  signal.throwIfAborted();
  if (session.state === 'connected' || !active(session)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); session.changed.delete(check); signal.removeEventListener('abort', abort); };
    const abort = () => { clear(); reject(signal.reason); };
    const check = () => { if (session.state === 'connected' || !active(session)) { clear(); resolve(); } };
    const timer = setTimeout(() => { clear(); reject(new Error('RDP_CONNECT_TIMEOUT')); }, Math.max(0, Math.min(35000, deadline - Date.now())));
    session.changed.add(check); signal.addEventListener('abort', abort, { once: true }); check();
  });
}
function changeResource<T>(operation: () => Promise<T>): Promise<T> {
  const result = resourceChanges.then(() => {
    if (stopping) throw new Error('RDP_BACKEND_STOPPING');
    return operation();
  });
  resourceChanges = result.catch(() => undefined);
  return result;
}
async function disconnect(id: string) {
  const session = sessions.get(id);
  if (session) { await stop(session); sessions.delete(id); }
  return null;
}
let releaseViews: (() => void) | undefined;
let clipboardViews: CallContext['views'] = [];
let clipboardRevision = 0;
let clipboardChanges: Promise<void> = Promise.resolve();
let publicationOwner: string | undefined;
function updateClipboardViews(views: CallContext['views']) {
  clipboardViews = views;
  void reconcileClipboard().catch(() => {
    for (const session of sessions.values()) if (session.clipboardEnabled) session.clipboardErrors++;
  });
}
function reconcileClipboard(): Promise<void> {
  const revision = ++clipboardRevision;
  const next = clipboardChanges.catch(() => {}).then(async () => {
    if (stopping || revision !== clipboardRevision) return;
    const target = [...sessions.values()].find(session => session.clipboardEnabled && !session.closed && session.state === 'connected'
      && clipboardViews.some(view => view.instanceId === session.owner && view.activity?.active));
    if (target) publicationOwner = target.display.id;
    const apply = async (session: Session, active: boolean, publish: boolean) => {
      if (session.closed || !session.profile.clipboardSupport || (session.clipboardActive === active && session.clipboardPublish === publish)) return;
      await command(session, 'setClipboardActivity', { active, publish });
      session.clipboardActive = active; session.clipboardPublish = publish;
    };
    // Revoke old publishers before granting the new one. Existing file streams
    // retain their original session and do not require publication ownership.
    for (const session of sessions.values()) if (session !== target) {
      await apply(session, false, session.clipboardEnabled && session.display.id === publicationOwner);
    }
    if (revision !== clipboardRevision) return;
    if (target) await apply(target, true, true);
  });
  clipboardChanges = next;
  return next;
}
export async function activate(value: Context) {
  context = value; profiles = new Profiles(value.dataDirectory); stopping = false;
  clipboardViews = []; publicationOwner = undefined;
  releaseViews?.();
  releaseViews = value.host.onViewsChanged(updateClipboardViews);
  const revision = clipboardRevision;
  const views = await value.host.getViews();
  if (revision === clipboardRevision) updateClipboardViews(views);
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid connection settings.');
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}
async function stop(session: Session) {
  if (session.closed) return;
  session.child.stdin.end();
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([session.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1200); })]);
  clearTimeout(timer);
  if (!session.closed) {
    session.child.kill();
    await Promise.race([session.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]);
    clearTimeout(timer);
  }
  if (!session.closed) throw new Error('The connection helper did not stop.');
}
function command(session: Session, method: string, params: Record<string, unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (session.closed) throw new Error('RDP_SESSION_CLOSED');
  return new Promise((resolve, reject) => {
    const request = randomUUID();
    const clean = () => { session.requests.delete(request); signal?.removeEventListener('abort', abort); };
    const fail = (error: Error) => { clean(); reject(error); };
    const abort = () => fail(signal!.reason);
    session.requests.set(request, { resolve: value => { clean(); resolve(value); }, reject: fail });
    signal?.addEventListener('abort', abort, { once: true });
    session.child.stdin.write(JSON.stringify({ ...params, method, request }) + '\n', error => { if (error) fail(error); });
  });
}
async function createSession(input: Record<string, unknown>, owner: string, signal?: AbortSignal): Promise<Session> {
  signal?.throwIfAborted();
  for (const [id, session] of sessions) {
    if (session.owner === owner && ['closed', 'connection_failed', 'certificate_required'].includes(session.state)) await stop(session);
    if (session.closed) sessions.delete(id);
  }
  if ([...sessions.values()].some(session => session.owner === owner && !session.closed)) throw new Error('RDP_SESSION_EXISTS');
  if (sessions.size >= 4) throw new Error('At most four connections can run at once.');
  const host = text(input.host, 253).trim(), port = input.port ?? 3389;
  const trustedSha256 = input.trustedSha256 == null ? undefined : text(input.trustedSha256, 64);
  if (!host || /[\s/\\?#]/.test(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535 || (trustedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(trustedSha256))) throw new Error('Invalid target or certificate fingerprint.');
  const username = text(input.username, 512), password = text(input.password, 4096), domain = text(input.domain ?? '', 512);
  const name = text(input.name ?? host, 120);
  const openMode = input.openMode ?? 'sidebar';
  if (openMode !== 'sidebar' && openMode !== 'window') throw new Error('Invalid connection location.');
  const clipboardSupport = input.clipboardSupport === undefined ? false : input.clipboardSupport;
  if (typeof clipboardSupport !== 'boolean') throw new Error('Invalid clipboard setting.');
  const disableMouseAnimation = input.disableMouseAnimation === undefined ? false : input.disableMouseAnimation;
  if (typeof disableMouseAnimation !== 'boolean') throw new Error('Invalid mouse animation setting.');
  const adaptiveWindow = input.adaptiveWindow === undefined ? false : input.adaptiveWindow, adaptiveSidebar = input.adaptiveSidebar === undefined ? false : input.adaptiveSidebar;
  if (typeof adaptiveWindow !== 'boolean' || typeof adaptiveSidebar !== 'boolean') throw new Error('PROFILE_INVALID');
  const { desktopWidth, desktopHeight } = resolution(input.desktopWidth, input.desktopHeight);
  const id = randomUUID(), token = randomBytes(32).toString('hex');
  const binary = join(context.packageDirectory, 'native', `${process.platform}-${process.arch}`, `anas-rdp-session${process.platform === 'win32' ? '.exe' : ''}`);
  if (stopping) throw new Error('RDP_BACKEND_STOPPING');
  const child = spawn(binary, ['--session'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const session: Session = { profile: { id: owner, name, host, port: Number(port), username, domain, openMode, clipboardSupport, adaptiveWindow, adaptiveSidebar, disableMouseAnimation, desktopWidth, desktopHeight }, owner, child, state: 'starting', display: { id, token, url: '' }, requests: new Map(), exited: Promise.resolve(), closed: false,
    changed: new Set(), uiLocked: false, clipboardEnabled: false, clipboardActive: false, clipboardPublish: false, clipboardState: clipboardSupport ? 'initializing' : 'disabled', clipboardErrors: 0 };
  session.exited = new Promise(resolve => child.once('close', () => {
    session.closed = true; session.windowState = undefined; session.uiLocked = false; session.clipboardEnabled = false;
    session.clipboardActive = false; session.clipboardPublish = false; session.clipboardState = 'disabled';
    if (!['connection_failed', 'certificate_required'].includes(session.state)) session.state = 'closed';
    for (const pending of session.requests.values()) pending.reject(new Error('RDP_SESSION_CLOSED'));
    session.requests.clear(); for (const notify of session.changed) notify(); resolve();
    if (!stopping) updateClipboardViews(clipboardViews);
  }));
  sessions.set(id, session);
  child.stderr.resume();
  child.stdin.on('error', () => { session.state = 'connection_failed'; });
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const ready = new Promise<number>((resolve, reject) => {
    abort = () => reject(signal!.reason);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new Error('Connection helper startup timed out.')), 5000);
    child.once('error', () => reject(new Error('Connection helper could not start on this platform.')));
    child.once('close', () => reject(new Error('Connection helper closed before becoming ready.')));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (typeof event.uiLocked === 'boolean') session.uiLocked = event.uiLocked;
        if (typeof event.clipboardEnabled === 'boolean') session.clipboardEnabled = event.clipboardEnabled;
        if (typeof event.clipboardState === 'string') session.clipboardState = event.clipboardState;
        if (event.clipboardError === true) session.clipboardErrors++;
        if (typeof event.request === 'string') {
          const pending = session.requests.get(event.request);
          if (pending) event.error ? pending.reject(new Error(event.error)) : pending.resolve(event.result);
          return;
        }
        if (typeof event.status === 'string' && (event.status !== 'closed' || !['connection_failed', 'certificate_required'].includes(session.state))) session.state = event.status;
        if (event.certificate) session.certificate = event.certificate;
        for (const notify of session.changed) notify();
        if (event.status === 'ready') resolve(event.port);
      } catch { session.state = 'connection_failed'; child.kill(); }
    });
  });
  child.stdin.write(JSON.stringify({ host, port, username, password, domain, desktop_width: desktopWidth, desktop_height: desktopHeight, clipboard_support: clipboardSupport, trusted_sha256: trustedSha256, origin: `anas-plugin://${context.pluginId}`, token }) + '\n');
  try {
    session.display.url = `ws://127.0.0.1:${await ready}/display`;
    return session;
  } catch (error) { await stop(session); sessions.delete(id); throw error; }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
export function call(method: string, params: unknown, caller: CallContext & { signal?: AbortSignal; host?: ToolContext['host'] }): Promise<unknown> {
  const ctx = { host: caller.host ?? context.host, signal: caller.signal ?? new AbortController().signal, deadline: Date.now() + 60000 };
  if (method === 'server.open') return controlServer(params, ctx, true);
  if (method === 'server.close') return controlServer({ profile_id: record(params).profile_id, state: 'closed' }, ctx, true);
  if (method === 'create') {
    const input = record(params), id = serverId(input.owner);
    return changeServer(id, signal => changeResource(async () => {
      signal.throwIfAborted();
      // A queued request from a disposed page must not recreate its connection.
      const views = await ctx.host.getViews();
      if (caller.caller && !views.some(view => view.panelId === caller.caller!.panelId)) throw new Error('RDP_PAGE_CLOSED');
      const existing = [...sessions.values()].find(session => session.owner === id && active(session));
      if (existing) return { ...existing.display, reused: true };
      const display = await execute(method, params, { ...caller, views }, signal) as Session['display'];
      return { ...display, reused: false };
    }), ctx.signal);
  }
  // Serialize configuration writes with resource creation: a stale page cannot
  // save/delete between checking the running state and committing its changes.
  if (['setAdaptive', 'disconnect', 'setClipboardEnabled', 'connection.open', 'connection.close', 'profiles.save', 'profiles.savePassword', 'profiles.delete', 'profiles.beginEdit', 'profiles.endEdit', 'profiles.launch', 'profiles.cancelLaunch'].includes(method)) {
    return changeResource(() => {
      if (['profiles.save', 'profiles.savePassword', 'profiles.delete'].includes(method) && (running(record(params).id) || serverChanges.has(String(record(params).id)))) throw new Error('RDP_PROFILE_ACTIVE');
      return execute(method, params, caller);
    });
  }
  return execute(method, params, caller);
}
async function execute(method: string, params: unknown, caller: CallContext, signal?: AbortSignal) {
  if (!caller || !Array.isArray(caller.views)) throw new Error('RDP_HOST_CONTEXT_REQUIRED');
  // Host-owned stable panel identities survive moves. Closed/failed pages
  // disappear from the next snapshot, without relying on an unload callback.
  const visible = reconcileViews(caller.views);
  const input = record(params);
  const id = typeof input.id === 'string' ? input.id : '';
  const editor = editors.get(id);
  if (method === 'runtime.state') {
    const saved = await profiles.call('profiles.list', {}) as Profile[];
    return {
      // Opening position comes from the saved profile. The session snapshot
      // is only used when that profile was deleted while the resource is alive.
      sessions: [...sessions.values()].filter(active).map(session => ({ id: session.display.id, state: session.state, clipboardErrors: session.clipboardErrors,
        profile: { ...session.profile, openMode: saved.find(profile => profile.id === session.owner)?.openMode ?? session.profile.openMode } })),
      openProfiles: [...new Set([...visible, ...opening.keys()])].filter(id => id !== 'main'),
      editingProfiles: [...editors.keys()],
    } satisfies RuntimeState;
  }
  if (method === 'profiles.beginEdit') {
    if (caller.caller?.instanceId !== 'main') throw new Error('RDP_EDITOR_OWNER');
    if (running(id)) throw new Error('RDP_PROFILE_ACTIVE');
    if (visible.has(id) || opening.has(id)) throw new Error('RDP_PROFILE_OPEN');
    if (editor && editor !== caller.caller.panelId) throw new Error('RDP_PROFILE_EDITING');
    await profiles.call('profiles.get', { id });
    editors.set(id, caller.caller.panelId);
    return null;
  }
  if (method === 'profiles.endEdit') {
    if (editor === caller.caller?.panelId) editors.delete(id);
    return null;
  }
  if (method === 'profiles.save' || method === 'profiles.delete' || method === 'profiles.savePassword') {
    if (editor && editor !== caller.caller?.panelId) throw new Error('RDP_PROFILE_EDITING');
    if (opening.has(id) || (method !== 'profiles.savePassword' && visible.has(id))) throw new Error('RDP_PROFILE_OPEN');
  }
  if (method === 'profiles.launch') {
    if (editor) throw new Error('RDP_PROFILE_EDITING');
    const token = await profiles.call(method, params);
    opening.set(id, { token, expires: Date.now() + 30000 });
    return token;
  }
  if (method === 'profiles.cancelLaunch' && opening.get(id)?.token === input.token) opening.delete(id);
  if (method === 'create' || method === 'connection.open') {
    if (editors.has(text(input.owner, 256))) throw new Error('RDP_PROFILE_EDITING');
    if (method === 'connection.open') return null;
  }
  if (method.startsWith('profiles.') || method.startsWith('trusts.')) return profiles.call(method, params, signal);
  const owner = text(input.owner, 256);
  if (!owner) throw new Error('Missing resource owner.');
  if (method === 'connection.close') {
    if (caller.caller?.instanceId !== owner || owner === 'main') throw new Error('RDP_PAGE_OWNER');
    profiles.cancelLaunch(owner);
    opening.delete(owner);
    return null;
  }
  if (method === 'find') {
    // Resource creation is visible to status queries before the helper starts.
    // A page may attach only after the helper has published its display endpoint.
    const session = [...sessions.values()].find(value => value.owner === owner && active(value) && value.display.url);
    return session?.display ?? null;
  }
  if (method === 'create') return (await createSession(input, owner, signal)).display;
  const resourceId = text(input.id, 80), session = sessions.get(resourceId);
  if (!session && method === 'disconnect') return null;
  if (!session) throw new Error('RDP_SESSION_CLOSED');
  if (session.owner !== owner) throw new Error('Connection does not belong to this resource owner.');
  if (method === 'status') return { state: session.state, certificate: session.certificate ?? null, clipboardEnabled: session.clipboardEnabled, clipboardState: session.clipboardState, adaptiveWindow: session.profile.adaptiveWindow, adaptiveSidebar: session.profile.adaptiveSidebar };
  if (method === 'windowState.get') return session.windowState ? requireWindowState(session.windowState) : null;
  if (method === 'windowState.set') {
    const windowState = requireWindowState(input);
    if (caller.caller?.instanceId !== owner) throw new Error('RDP_PAGE_OWNER');
    const lease = await command(session, 'lease', {}) as { owner: string | null; epoch: number };
    if (!active(session)) throw new Error('RDP_SESSION_CLOSED');
    if (!lease.owner || lease.owner !== input.pageId || lease.epoch !== input.expectedEpoch) throw new Error('RDP_OWNERSHIP_CHANGED');
    session.windowState = windowState;
    return null;
  }
  if (method === 'setAdaptive') {
    if (Object.keys(input).some(key => !['owner', 'id', 'pageId', 'expectedEpoch', 'location', 'enabled'].includes(key))
      || (input.location !== 'window' && input.location !== 'sidebar') || typeof input.enabled !== 'boolean') throw new Error('PROFILE_INVALID');
    if (caller.caller?.instanceId !== owner || !caller.views.some(view => view.panelId === caller.caller!.panelId && view.instanceId === owner && view.location === input.location)) throw new Error('RDP_PAGE_OWNER');
    if (!active(session) || session.state !== 'connected') throw new Error('RDP_NOT_CONNECTED');
    const lease = await command(session, 'lease', {}) as { owner: string | null; epoch: number };
    if (!lease.owner || lease.owner !== input.pageId || lease.epoch !== input.expectedEpoch) throw new Error('RDP_OWNERSHIP_CHANGED');
    const profile = await profiles.call('preferences.adaptive', { id: owner, location: input.location, enabled: input.enabled }, signal) as Profile;
    session.profile.adaptiveWindow = profile.adaptiveWindow; session.profile.adaptiveSidebar = profile.adaptiveSidebar;
    return { adaptiveWindow: profile.adaptiveWindow, adaptiveSidebar: profile.adaptiveSidebar };
  }
  if (['downloadStatus', 'downloadStart', 'downloadCancel'].includes(method)) {
    if (caller.caller?.instanceId !== owner) throw new Error('RDP_PAGE_OWNER');
    if (process.platform !== 'darwin' || !session.profile.clipboardSupport) return null;
    if (session.closed || session.state !== 'connected') throw new Error('RDP_SESSION_CLOSED');
    if (method === 'downloadStart') {
      if (typeof input.directory !== 'string' || !isAbsolute(input.directory) || input.directory.length > 32768 || input.directory.includes('\0') || !Number.isSafeInteger(input.revision)) throw new Error('RDP_DOWNLOAD_DIRECTORY');
      return command(session, method, { directory: input.directory, revision: input.revision });
    }
    if (method === 'downloadCancel') return command(session, method, { id: text(input.transferId, 80) });
    return command(session, method, {});
  }
  if (method === 'setClipboardEnabled') {
    if (!session.profile.clipboardSupport || session.state !== 'connected' || typeof input.enabled !== 'boolean') throw new Error('RDP_CLIPBOARD_UNAVAILABLE');
    const result = await command(session, 'setClipboardEnabled', { enabled: input.enabled });
    session.clipboardEnabled = input.enabled;
    await reconcileClipboard();
    return result;
  }
  if (method === 'setUiLocked') return setUiLocked(session, input.locked);
  if (method === 'resetInput') return resetInput(session);
  if (method === 'inputText') {
    if (caller.caller?.instanceId !== owner || session.state !== 'connected' || session.closed) throw new Error('RDP_PAGE_OWNER');
    const value = text(input.text, 512);
    if (!value.length || Array.from(value).length > 128 || /[\uD800-\uDFFF]/u.test(value)) throw new Error('RDP_INVALID_INPUT');
    const lease = await command(session, 'lease', {}) as { owner: string | null; epoch: number };
    if (!lease.owner || lease.owner !== input.pageId || lease.epoch !== input.expectedEpoch || session.uiLocked) throw new Error('RDP_OWNERSHIP_CHANGED');
    return command(session, 'input', { actions: [{ type: 'text', text: value }], interval_ms: 0, deadline_ms: Date.now() + 60000 });
  }
  if (method === 'resize') {
    const size = resolution(input.width, input.height);
    return command(session, 'resize', { page: text(input.pageId, 80), expectedEpoch: input.expectedEpoch, width: size.desktopWidth, height: size.desktopHeight });
  }
  if (method === 'lease') return command(session, 'lease', {});
  if (method === 'claim' || method === 'release') return command(session, method, {
    expected: input.expected ?? null, expectedEpoch: input.expectedEpoch, ...(method === 'claim' ? { page: text(input.pageId, 80) } : {})
  });
  if (method === 'disconnect') return disconnect(resourceId);
  throw new Error('Unknown RDP operation.');
}
const profileFields = { name: 'name', host: 'host', port: 'port', username: 'username', domain: 'domain', open_mode: 'openMode', clipboard_support: 'clipboardSupport', adaptive_window: 'adaptiveWindow', adaptive_sidebar: 'adaptiveSidebar', disable_mouse_animation: 'disableMouseAnimation', desktop_width: 'desktopWidth', desktop_height: 'desktopHeight' } as const;
function profileChanges(value: unknown) {
  const input = record(value), changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(profileFields, key) || value === undefined || value === null) throw new Error('PROFILE_INVALID');
    changes[profileFields[key as keyof typeof profileFields]] = value;
  }
  if (!Object.keys(changes).length) throw new Error('PROFILE_INVALID');
  return changes;
}
function toolProfile(profile: SessionSummary['profile'] | Profile) {
  return { profile_id: profile.id,
    ...Object.fromEntries(Object.entries(profileFields).map(([key, field]) => [key, profile[field]])),
    ...('revision' in profile ? { revision: profile.revision, has_password: profile.hasPassword } : {}) };
}
async function profileTool(args: unknown, ctx: ToolContext) {
  ctx.signal.throwIfAborted();
  const input = record(args), action = input.action;
  if (typeof action !== 'string' || !['get', 'add', 'update', 'delete'].includes(action)) throw new Error('PROFILE_INVALID_ACTION');
  const keys = action === 'get' ? ['action', 'profile_id'] : action === 'add' ? ['action', 'changes']
    : action === 'delete' ? ['action', 'profile_id', 'revision'] : ['action', 'profile_id', 'revision', 'changes'];
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input, key))) throw new Error('PROFILE_INVALID');
  if (action !== 'add') serverId(input.profile_id);
  if (action === 'get') return toolProfile(await profiles.call('profiles.get', { id: input.profile_id }, ctx.signal) as Profile);
  if (action !== 'add' && (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1)) throw new Error('PROFILE_INVALID');
  return changeProfile(action as 'add' | 'update' | 'delete', input, ctx);
}
async function changeProfile(method: 'add' | 'update' | 'delete', args: unknown, { host, signal }: ToolContext) {
  const input = record(args);
  return changeResource(async () => {
    signal.throwIfAborted();
    const views = await host.getViews();
    signal.throwIfAborted();
    reconcileViews(views);
    const id = method === 'add' ? undefined : text(input.profile_id, 80);
    if (id && (running(id) || serverChanges.has(id))) throw new Error('RDP_PROFILE_ACTIVE');
    const previous = id ? await profiles.call('profiles.get', { id }, signal) as Profile : undefined;
    if (previous && previous.revision !== input.revision) throw new Error('PROFILE_CONFLICT');
    const changes = method === 'delete' ? {} : profileChanges(input.changes);
    if (method === 'add' && (typeof changes.host !== 'string' || !changes.host.trim())) throw new Error('PROFILE_INVALID');
    signal.throwIfAborted();
    // Passwords and certificate trust remain in their existing UI workflow.
    // Do not rebuild a profile from defaults when updating a subset of fields.
    const params = method === 'delete' ? { id, revision: input.revision } : {
      ...(previous ?? { name: changes.host, host: changes.host, port: 3389, username: '', domain: '', openMode: 'sidebar' }),
      ...changes, ...(previous ? { id, revision: input.revision } : {}), passwordAction: 'keep'
    };
    const result = await execute(method === 'delete' ? 'profiles.delete' : 'profiles.save', params, { caller: null, views }, signal);
    return method === 'delete' ? { profile_id: id, deleted: true } : toolProfile(result as Profile);
  });
}
async function setUiLocked(session: Session, locked: unknown) {
  if (typeof locked !== 'boolean') throw new Error('RDP_INVALID_LOCK');
  if (session.closed || session.state !== 'connected') throw new Error('RDP_NOT_CONNECTED');
  // Wait for the real receipt after dispatch; cancellation cannot undo the change.
  const result = await command(session, 'setUiLocked', { locked }) as { ui_locked: boolean; uiRevision: number };
  return { session_id: session.display.id, ui_locked: result.ui_locked, uiRevision: result.uiRevision };
}
async function resetInput(session: Session) {
  if (session.closed || session.state !== 'connected') throw new Error('RDP_NOT_CONNECTED');
  const result = await command(session, 'resetInput', {}) as { accepted: boolean; toggle_flags: number; input_revision: number };
  return { session_id: session.display.id, ...result };
}

function serverId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || value === 'main') throw new Error('Invalid server profile ID.');
  return value;
}
async function disconnectServer(id: string) {
  serverId(id);
  profiles.cancelLaunch(id); opening.delete(id);
  for (const session of [...sessions.values()]) if (session.owner === id) await disconnect(session.display.id);
  return null;
}
function serverStatus(id: string, saved: Profile[], views: CallContext['views']) {
  const profile = saved.find(profile => profile.id === id);
  const session = [...sessions.values()].find(session => session.owner === id);
  const view = views.find(view => view.instanceId === id) ?? null;
  const snapshot = profile ?? session?.profile;
  return { profile_id: id, profile: snapshot ? toolProfile(snapshot) : null, saved: !!profile,
    state: session && active(session) ? (view ? 'foreground' : 'background') : 'closed',
    connection_state: session?.state ?? 'closed', session_id: session?.display.id ?? null,
    view: view ? { panel_id: view.panelId, instance_id: view.instanceId, location: view.location, ...(view.activity ? { activity: view.activity } : {}) } : null,
    ui_locked: session?.uiLocked ?? false, certificate: session?.certificate ?? null,
    clipboard_enabled: session?.clipboardEnabled ?? false, clipboard_state: session?.clipboardState ?? 'disabled' };
}
async function readServerStatus(id: string, host: ToolContext['host']) {
  return serverStatus(id, await profiles.call('profiles.list', {}) as Profile[], await host.getViews());
}
async function connectServer(id: string, { host, signal, deadline }: ToolContext) {
  const started = await changeResource(async () => {
    reconcileViews(await host.getViews());
    signal.throwIfAborted();
    if (editors.has(id)) throw new Error('RDP_PROFILE_EDITING');
    const existing = [...sessions.values()].find(session => session.owner === id && active(session));
    if (existing) return { session: existing, reused: true };
    const profile = await profiles.call('profiles.get', { id }) as Profile;
    const password = await profiles.call('profiles.password', profile) as string | null;
    if (password === null) return null;
    const trusts = await profiles.call('trusts.list', {}) as Trust[];
    signal.throwIfAborted();
    return { session: await createSession({ ...profile, password, trustedSha256: trusts.find(trust => trust.host === profile.host && trust.port === profile.port)?.sha256 }, id, signal), reused: false };
  });
  if (!started) return null;
  let completed = false;
  try {
    await waitForConnection(started.session, signal, deadline);
    signal.throwIfAborted();
    completed = true;
    return started;
  } finally {
    // Cancel only an unfinished connection created by this operation.
    if (!completed && !started.reused && started.session.state !== 'connected') {
      await changeResource(() => disconnect(started.session.display.id));
    }
  }
}
function changeServer<T>(id: string, operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, closing = false): Promise<T> {
  const requests = serverRequests.get(id) ?? new Set<AbortController>();
  // An explicit disconnect supersedes pending opens/creation, including a
  // connection still authenticating. Page-only closure never enters this path.
  if (closing) for (const request of requests) request.abort(new Error('RDP_OPERATION_SUPERSEDED'));
  const controller = new AbortController();
  if (!closing) requests.add(controller);
  serverRequests.set(id, requests);
  const signal = AbortSignal.any([parent, controller.signal]);
  const pending = (serverChanges.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
    signal.throwIfAborted();
    return operation(signal);
  });
  serverChanges.set(id, pending);
  return pending.finally(() => {
    requests.delete(controller);
    if (serverChanges.get(id) === pending) { serverChanges.delete(id); serverRequests.delete(id); }
  });
}
async function showServer(id: string, profile: SessionSummary['profile'], requested: unknown, host: ToolContext['host'], signal: AbortSignal) {
  const views = await host.getViews(); signal.throwIfAborted();
  const existing = views.find(view => view.instanceId === id);
  const location = (requested ?? existing?.location ?? profile.openMode) as 'sidebar' | 'window';
  if (existing && existing.location !== location) await host.moveView({ instanceId: id, location });
  signal.throwIfAborted();
  await host.openView({ instanceId: id, location, title: profile.name, icon: 'assets/desktop.svg' });
}
async function controlServer(args: unknown, ctx: ToolContext, interactive = false) {
  const input = record(args), id = serverId(input.profile_id);
  if (Object.keys(input).some(key => !['profile_id', 'state', 'location', 'ui_locked', 'reset_input'].includes(key))) throw new Error('Invalid control field.');
  if (input.state !== undefined && (typeof input.state !== 'string' || !['foreground', 'background', 'closed'].includes(input.state))) throw new Error('Invalid server state.');
  if (input.ui_locked !== undefined && typeof input.ui_locked !== 'boolean') throw new Error('RDP_INVALID_LOCK');
  if (Object.hasOwn(input, 'reset_input') && input.reset_input !== true) throw new Error('reset_input must be true.');
  if (input.state === undefined && input.ui_locked === undefined && input.reset_input !== true) throw new Error('At least one control operation is required.');
  if (input.state === 'closed' && ['location', 'ui_locked', 'reset_input'].some(key => Object.hasOwn(input, key))) throw new Error('closed cannot combine with other operations.');
  if (input.location !== undefined && (input.state !== 'foreground' || (typeof input.location !== 'string' || !['sidebar', 'window'].includes(input.location)))) throw new Error('Location is only valid for foreground state.');
  const { host } = ctx;
  ctx.signal.throwIfAborted();
  // Lock/reset-only calls bind now, before waiting behind another state change.
  const bound = input.state === undefined ? connectedServer(id) : undefined;
  if (!host?.getViews || !host.closeView || !host.openView || !host.moveView) throw new Error('RDP_HOST_CONTEXT_REQUIRED');
  return changeServer(id, async signal => {
    signal.throwIfAborted();
    if (stopping) throw new Error('RDP_BACKEND_STOPPING');
    if (interactive && input.state !== 'closed') {
      const { profile, launch } = await changeResource(async () => {
        reconcileViews(await host.getViews()); signal.throwIfAborted();
        if (editors.has(id)) throw new Error('RDP_PROFILE_EDITING');
        const existing = [...sessions.values()].find(session => session.owner === id && active(session));
        const profile = existing?.profile ?? await profiles.call('profiles.get', { id }) as Profile;
        opening.set(id, { token: randomUUID(), expires: Date.now() + 30000 });
        return { profile, launch: !existing };
      });
      try {
        await showServer(id, profile, input.location, host, signal);
        // Publish the new launch only after any preceding page disposal. A late
        // close callback may cancel its own old intent, never this replacement.
        if (launch) await changeResource(async () => {
          signal.throwIfAborted();
          await execute('profiles.launch', { id, revision: (profile as Profile).revision }, { caller: null, views: await host.getViews() });
        });
        signal.throwIfAborted();
      } catch (error) { profiles.cancelLaunch(id); throw error; }
      finally { opening.delete(id); }
      return readServerStatus(id, host);
    }
    const applied: Record<string, unknown> = {};
    let step = input.state === 'closed' ? 'close' : 'connection';
    let reused: boolean | undefined;
    const result = async (error?: string) => {
      try {
        return { ...await readServerStatus(id, host), ok: error === undefined, applied,
          ...(reused === undefined ? {} : { reused }), ...(error !== undefined ? { failed_step: step, error } : {}) };
      } catch (statusError) {
        if (interactive) throw statusError;
        return { profile_id: id, ok: false, applied, failed_step: error !== undefined ? step : 'status',
          ...(error !== undefined ? { error } : {}), status_error: String(statusError) };
      }
    };
    try {
      if (input.state === 'closed') {
        await changeResource(async () => { signal.throwIfAborted(); await disconnectServer(id); });
        applied.connection = { state: 'closed' };
        // Disposal calls back into this backend; never hold the resource lock.
        step = 'presentation';
        await host.closeView({ instanceId: id });
        applied.state = 'closed';
        return result();
      }
      const started = bound ? { session: bound, reused: true } : await connectServer(id, { ...ctx, signal });
      if (!started) return result('RDP_PASSWORD_REQUIRED: Save a password in the profile or connect from the desktop UI.');
      const { session } = started;
      reused = started.reused;
      if (session.closed || session.state !== 'connected') return result(`RDP_NOT_CONNECTED: ${session.state}`);
      if (!bound) applied.connection = { state: 'connected', session_id: session.display.id };
      signal.throwIfAborted();
      if (input.ui_locked !== undefined) {
        step = 'ui_locked';
        const receipt = await setUiLocked(session, input.ui_locked);
        applied.ui_locked = receipt.ui_locked;
        signal.throwIfAborted();
      }
      if (input.reset_input === true) {
        step = 'reset_input';
        const { session_id: _sessionId, ...receipt } = await resetInput(session);
        applied.reset_input = receipt;
        signal.throwIfAborted();
      }
      step = 'presentation';
      if (input.state === 'background') await host.closeView({ instanceId: id });
      else if (input.state === 'foreground') await showServer(id, session.profile, input.location, host, signal);
      // An unexpected disconnect must not report a successful connected state.
      if (session.closed || session.state !== 'connected') throw new Error('RDP_NOT_CONNECTED');
      if (input.state !== undefined) applied.state = input.state;
      signal.throwIfAborted();
      return result();
    } catch (error) {
      if (interactive) throw error;
      return result(error instanceof Error ? error.message : String(error));
    }
  }, ctx.signal, input.state === 'closed');
}
function connectedServer(value: unknown): Session {
  const id = serverId(value);
  // Pin this connection for the entire call; reconnecting cannot redirect input.
  const session = [...sessions.values()].find(session => session.owner === id && !session.closed && session.state === 'connected');
  if (!session) throw new Error('RDP_NOT_CONNECTED');
  return session;
}
// The same resources used by pages; model tools do not create a page identity.
export const tools = {
  control: controlServer,
  profile: profileTool,
  async list(_args: unknown, { signal, host }: ToolContext) {
    signal.throwIfAborted();
    const saved = await profiles.call('profiles.list', {}) as Profile[];
    const views = await host.getViews();
    signal.throwIfAborted();
    const ids = new Set([...saved.map(profile => profile.id), ...[...sessions.values()].map(session => session.owner), ...views.map(view => view.instanceId).filter(id => id !== 'main')]);
    return [...ids].map(id => serverStatus(id, saved, views));
  },
  async input(args: unknown, { signal, deadline }: ToolContext) {
    signal.throwIfAborted();
    const input = record(args);
    if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > 64 ||
      Buffer.byteLength(JSON.stringify(input.actions)) > 12000) throw new Error('RDP_INVALID_INPUT');
    // Reject malformed UTF-16 before the native JSON parser can drop the command.
    for (const action of input.actions) {
      if (action?.type === 'text' && (typeof action.text !== 'string' || !action.text.length ||
        Array.from(action.text).length > 4096 || /[\uD800-\uDFFF]/u.test(action.text))) throw new Error('RDP_INVALID_INPUT');
    }
    const interval = input.interval_ms === undefined ? 50 : input.interval_ms;
    if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 0 || interval > 1000) throw new Error('RDP_INVALID_INPUT');
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error('RDP_INPUT_TIMEOUT');
    // Once dispatched, finish the explicitly requested sequence even if the caller cancels.
    // The helper enforces the same execution deadline and acknowledges partial failure.
    // Never drop the receipt merely because a local waiting timer elapsed.
    const session = connectedServer(input.profile_id);
    return command(session, 'input', { actions: input.actions, interval_ms: interval, deadline_ms: deadline });
  },
  async screenshot(args: unknown, { signal }: ToolContext) {
    signal.throwIfAborted();
    const input = record(args);
    if (input.include_cursor !== undefined && typeof input.include_cursor !== 'boolean') throw new Error('Invalid cursor setting.');
    if (input.save !== undefined && typeof input.save !== 'boolean') throw new Error('Invalid screenshot save setting.');
    const session = connectedServer(input.profile_id);
    const result = await command(session, 'screenshot', { includeCursor: input.include_cursor ?? true }, signal);
    signal.throwIfAborted();
    if (!input.save) return result;
    const content = result as Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }>;
    const info = content.find(block => block.type === 'text');
    const image = content.find(block => block.type === 'image');
    if (!info || !image || image.mimeType !== 'image/png') throw new Error('Invalid screenshot result.');
    const metadata = record(JSON.parse(info.text));
    let staging: string | undefined;
    try {
      if (!context.tempDirectory || !isAbsolute(context.tempDirectory)) throw new Error('Host tempDirectory is unavailable. Update Anas to save screenshots.');
      const directory = join(context.tempDirectory, 'screenshots');
      await mkdir(directory, { recursive: true });
      signal.throwIfAborted();
      const path = join(directory, `${Date.now()}-${randomUUID()}.png`);
      staging = `${path}.part`;
      await writeFile(staging, Buffer.from(image.data, 'base64'), { signal });
      signal.throwIfAborted();
      await rename(staging, path);
      metadata.saved_path = path;
    } catch (error) {
      // Failed/cancelled writes must not leave a published partial PNG.
      // If immediate cleanup fails, the host's temp cleanup removes the staging file.
      if (staging) await rm(staging, { force: true }).catch(() => {});
      signal.throwIfAborted();
      metadata.save_error = error instanceof Error ? error.message : String(error);
    }
    return content.map(block => block === info ? { ...info, text: JSON.stringify(metadata) } : block);
  },
};
export async function deactivate() {
  stopping = true;
  releaseViews?.(); releaseViews = undefined;
  // Closing helpers also settles pending input and startup receipts. Waiting for
  // resource creation first could otherwise block the very cleanup it needs.
  await Promise.all([resourceChanges, clipboardChanges.catch(() => {}), ...[...sessions.values()].map(stop)]);
  sessions.clear(); editors.clear(); opening.clear();
}
