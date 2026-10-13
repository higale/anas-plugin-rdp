import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Profiles } from './profiles';
import { resolution } from './resolution';
import type { SessionSummary, RuntimeState, CallContext, Profile, Trust } from './profile-types';

type Context = { pluginId: string; packageDirectory: string; dataDirectory: string; host: ToolContext['host'] & { onViewsChanged(listener: (views: CallContext['views']) => void): () => void } };
type Session = { profile: SessionSummary['profile']; owner: string; child: ChildProcessWithoutNullStreams; state: string; certificate?: { sha256: string; trusted: boolean };
  display: { id: string; url: string; token: string }; requests: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
  exited: Promise<void>; closed: boolean; uiLocked: boolean; clipboardEnabled: boolean; clipboardActive: boolean; clipboardPublish: boolean; clipboardState: string; clipboardErrors: number; changed: Set<() => void>;
  connecting?: { pending: number } };
type ToolContext = { signal: AbortSignal; deadline: number; host: { getViews(): Promise<CallContext['views']>;
  openView(options: { instanceId: string; location: 'sidebar' | 'window'; title?: string; icon?: string }): Promise<void>;
  moveView(options: { instanceId: string; location: 'sidebar' | 'window' }): Promise<void> } };
let context: Context;
let profiles: Profiles;
const sessions = new Map<string, Session>();
const editors = new Map<string, string>();
const opening = new Map<string, { token: unknown; expires: number }>();
let selection: RuntimeState['selection'];
let resourceChanges: Promise<unknown> = Promise.resolve();
let stopping = false;
const active = (session: Session) => !session.closed && !['closed', 'connection_failed', 'certificate_required'].includes(session.state);
const running = (owner: unknown) => [...sessions.values()].some(session => session.owner === owner && active(session));
const summary = (session: Session) => ({ id: session.display.id, profile: session.profile, state: session.state, certificate: session.certificate ?? null, ui_locked: session.uiLocked, clipboard_enabled: session.clipboardEnabled, clipboard_state: session.clipboardState });
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
  context = value; profiles = new Profiles(value.dataDirectory); selection = undefined; stopping = false;
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
  const runInBackground = input.runInBackground === undefined ? false : input.runInBackground;
  if (typeof runInBackground !== 'boolean') throw new Error('Invalid background setting.');
  const clipboardSupport = input.clipboardSupport === undefined ? false : input.clipboardSupport;
  if (typeof clipboardSupport !== 'boolean') throw new Error('Invalid clipboard setting.');
  const { desktopWidth, desktopHeight } = resolution(input.desktopWidth, input.desktopHeight);
  const id = randomUUID(), token = randomBytes(32).toString('hex');
  const binary = join(context.packageDirectory, 'native', `${process.platform}-${process.arch}`, `anas-rdp-session${process.platform === 'win32' ? '.exe' : ''}`);
  if (stopping) throw new Error('RDP_BACKEND_STOPPING');
  const child = spawn(binary, ['--session'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const session: Session = { profile: { id: owner, name, host, port: Number(port), username, domain, openMode, runInBackground, clipboardSupport, desktopWidth, desktopHeight }, owner, child, state: 'starting', display: { id, token, url: '' }, requests: new Map(), exited: Promise.resolve(), closed: false,
    changed: new Set(), uiLocked: false, clipboardEnabled: false, clipboardActive: false, clipboardPublish: false, clipboardState: 'disabled', clipboardErrors: 0 };
  session.exited = new Promise(resolve => child.once('close', () => {
    session.closed = true; session.uiLocked = false; session.clipboardEnabled = false;
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
export function call(method: string, params: unknown, caller: CallContext): Promise<unknown> {
  // Serialize configuration writes with resource creation: a stale page cannot
  // save/delete between checking the running state and committing its changes.
  if (['create', 'disconnect', 'setClipboardEnabled', 'connection.open', 'connection.close', 'connection.setLocation', 'profiles.save', 'profiles.savePassword', 'profiles.delete', 'profiles.beginEdit', 'profiles.endEdit', 'profiles.launch', 'profiles.cancelLaunch'].includes(method)) {
    return changeResource(() => {
      if (['profiles.save', 'profiles.savePassword', 'profiles.delete'].includes(method) && running(record(params).id)) throw new Error('RDP_PROFILE_ACTIVE');
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
  if (method === 'profiles.select') {
    if (!id || id.length > 80) throw new Error('Invalid profile selection.');
    selection = { id, token: randomUUID() };
    return null;
  }
  if (method === 'profiles.ackSelection') {
    if (caller.caller?.instanceId !== 'main') throw new Error('RDP_EDITOR_OWNER');
    if (selection?.token === input.token) selection = undefined;
    return null;
  }
  if (method === 'runtime.state') {
    const saved = await profiles.call('profiles.list', {}) as Profile[];
    return {
      // Opening position comes from the saved profile. The session snapshot
      // is only used when that profile was deleted while the resource is alive.
      sessions: [...sessions.values()].filter(active).map(session => ({ id: session.display.id, state: session.state, clipboardErrors: session.clipboardErrors,
        profile: { ...session.profile, openMode: saved.find(profile => profile.id === session.owner)?.openMode ?? session.profile.openMode } })),
      openProfiles: [...new Set([...visible, ...opening.keys()])].filter(id => id !== 'main'),
      editingProfiles: [...editors.keys()],
      ...(caller.caller?.instanceId === 'main' && selection ? { selection } : {}),
    } satisfies RuntimeState;
  }
  if (method === 'profiles.setOpenMode') throw new Error('RDP_LOCATION_UNAVAILABLE');
  if (method === 'connection.setLocation') {
    const view = caller.views.find(view => view.instanceId === id);
    if (!view || id === 'main' || !['sidebar', 'window'].includes(view.location)) throw new Error('RDP_LOCATION_UNAVAILABLE');
    for (const session of sessions.values()) if (session.owner === id) session.profile.openMode = view.location;
    try {
      const profile = await profiles.call('profiles.setOpenMode', { id, openMode: view.location });
      return { location: view.location, profile };
    } catch { throw new Error('RDP_LOCATION_SAVE_FAILED'); }
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
    if (opening.has(id) || (method === 'profiles.save' && visible.has(id))) throw new Error('RDP_PROFILE_OPEN');
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
    for (const [id, session] of sessions) {
      if (session.owner !== owner || session.profile.runInBackground) continue;
      await stop(session);
      sessions.delete(id);
    }
    return null;
  }
  if (method === 'find') {
    const session = [...sessions.values()].find(value => value.owner === owner && active(value));
    return session?.display ?? null;
  }
  if (method === 'create') return (await createSession(input, owner)).display;
  const resourceId = text(input.id, 80), session = sessions.get(resourceId);
  if (!session && method === 'disconnect') return null;
  if (!session) throw new Error('RDP_SESSION_CLOSED');
  if (session.owner !== owner) throw new Error('Connection does not belong to this resource owner.');
  if (method === 'status') return { state: session.state, certificate: session.certificate ?? null, clipboardEnabled: session.clipboardEnabled, clipboardState: session.clipboardState };
  if (method === 'setClipboardEnabled') {
    if (!session.profile.clipboardSupport || session.state !== 'connected' || typeof input.enabled !== 'boolean') throw new Error('RDP_CLIPBOARD_UNAVAILABLE');
    const result = await command(session, 'setClipboardEnabled', { enabled: input.enabled });
    session.clipboardEnabled = input.enabled;
    await reconcileClipboard();
    return result;
  }
  if (method === 'setUiLocked') return setUiLocked(session, input.locked);
  if (method === 'resetKeyboard') return resetKeyboard(session);
  if (method === 'lease') return command(session, 'lease', {});
  if (method === 'claim' || method === 'release') return command(session, method, {
    expected: input.expected ?? null, expectedEpoch: input.expectedEpoch, ...(method === 'claim' ? { page: text(input.pageId, 80) } : {})
  });
  if (method === 'disconnect') return disconnect(resourceId);
  throw new Error('Unknown RDP operation.');
}
const profileFields = { name: 'name', host: 'host', port: 'port', username: 'username', domain: 'domain', open_mode: 'openMode', run_in_background: 'runInBackground', clipboard_support: 'clipboardSupport', desktop_width: 'desktopWidth', desktop_height: 'desktopHeight' } as const;
function profileChanges(value: unknown) {
  const input = record(value), changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(profileFields, key) || value === undefined || value === null) throw new Error('PROFILE_INVALID');
    changes[profileFields[key as keyof typeof profileFields]] = value;
  }
  if (!Object.keys(changes).length) throw new Error('PROFILE_INVALID');
  return changes;
}
async function changeProfile(method: 'add' | 'update' | 'delete', args: unknown, { host, signal }: ToolContext) {
  const input = record(args);
  return changeResource(async () => {
    signal.throwIfAborted();
    const views = await host.getViews();
    signal.throwIfAborted();
    reconcileViews(views);
    const id = method === 'add' ? undefined : text(input.profile_id, 80);
    if (id && running(id)) throw new Error('RDP_PROFILE_ACTIVE');
    const previous = id ? await profiles.call('profiles.get', { id }, signal) as Profile : undefined;
    if (previous && previous.revision !== input.revision) throw new Error('PROFILE_CONFLICT');
    const changes = method === 'delete' ? {} : profileChanges(input.changes);
    if (method === 'add' && (typeof changes.host !== 'string' || !changes.host.trim())) throw new Error('PROFILE_INVALID');
    signal.throwIfAborted();
    // Passwords and certificate trust remain in their existing UI workflow.
    // Do not rebuild a profile from defaults when updating a subset of fields.
    const params = method === 'delete' ? { id, revision: input.revision } : {
      ...(previous ?? { name: changes.host, host: changes.host, port: 3389, username: '', domain: '', openMode: 'sidebar', runInBackground: false }),
      ...changes, ...(previous ? { id, revision: input.revision } : {}), passwordAction: 'keep'
    };
    const result = await execute(method === 'delete' ? 'profiles.delete' : 'profiles.save', params, { caller: null, views }, signal);
    return method === 'delete' ? { profile_id: id, deleted: true } : result;
  });
}
async function setUiLocked(session: Session, locked: unknown) {
  if (typeof locked !== 'boolean') throw new Error('RDP_INVALID_LOCK');
  if (session.closed || session.state !== 'connected') throw new Error('RDP_NOT_CONNECTED');
  // Wait for the real receipt after dispatch; cancellation cannot undo the change.
  const result = await command(session, 'setUiLocked', { locked }) as { ui_locked: boolean; uiRevision: number };
  return { session_id: session.display.id, ui_locked: result.ui_locked, uiRevision: result.uiRevision };
}
async function resetKeyboard(session: Session) {
  if (session.closed || session.state !== 'connected') throw new Error('RDP_NOT_CONNECTED');
  const result = await command(session, 'resetKeyboard', {}) as { accepted: boolean; toggle_flags: number; input_revision: number };
  return { session_id: session.display.id, ...result };
}
// The same resources used by pages; model tools do not create a page identity.
export const tools = {
  async reset_keyboard(args: unknown, { signal }: ToolContext) {
    signal.throwIfAborted();
    const session = sessions.get(text(record(args).session_id, 80));
    if (!session) throw new Error('RDP_SESSION_CLOSED');
    return resetKeyboard(session);
  },
  async set_ui_locked(args: unknown, { signal }: ToolContext) {
    signal.throwIfAborted();
    const input = record(args), session = sessions.get(text(input.session_id, 80));
    if (!session) throw new Error('RDP_SESSION_CLOSED');
    const { session_id, ui_locked } = await setUiLocked(session, input.locked);
    return { session_id, ui_locked };
  },
  async show_desktop(args: unknown, { signal, host }: ToolContext) {
    signal.throwIfAborted();
    const input = record(args), session = sessions.get(text(input.session_id, 80));
    if (!session || !active(session)) throw new Error('RDP_SESSION_CLOSED');
    if (input.location !== undefined && input.location !== 'sidebar' && input.location !== 'window') throw new Error('Invalid desktop location.');
    if (!host?.openView || !host.moveView) throw new Error('RDP_HOST_CONTEXT_REQUIRED');
    const views = await host.getViews();
    signal.throwIfAborted();
    const existing = views.find(view => view.instanceId === session.owner);
    const location = input.location ?? existing?.location ?? session.profile.openMode;
    // A page calls back into the backend while preparing. Never hold the resource lock here.
    if (existing && existing.location !== location) await host.moveView({ instanceId: session.owner, location });
    signal.throwIfAborted();
    await host.openView({ instanceId: session.owner, location, title: session.profile.name, icon: 'assets/desktop.svg' });
    return { ...summary(session), view: (await host.getViews()).find(view => view.instanceId === session.owner) ?? null };
  },
  async input(args: unknown, { signal, deadline }: ToolContext) {
    signal.throwIfAborted();
    const input = record(args), session = sessions.get(text(input.session_id, 80));
    if (!session || !active(session)) throw new Error('RDP_SESSION_CLOSED');
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
    return command(session, 'input', { actions: input.actions, interval_ms: interval, deadline_ms: deadline });
  },
  async get_profile(args: unknown, { signal }: ToolContext) {
    signal.throwIfAborted();
    return profiles.call('profiles.get', { id: text(record(args).profile_id, 80) }, signal);
  },
  add_profile: (args: unknown, ctx: ToolContext) => changeProfile('add', args, ctx),
  update_profile: (args: unknown, ctx: ToolContext) => changeProfile('update', args, ctx),
  delete_profile: (args: unknown, ctx: ToolContext) => changeProfile('delete', args, ctx),
  async connect(args: unknown, { host, signal, deadline }: ToolContext) {
    signal.throwIfAborted();
    const input = record(args), profileId = text(input.profile_id, 80);
    if (!host?.getViews) throw new Error('RDP_HOST_CONTEXT_REQUIRED');
    const started = await changeResource(async () => {
      reconcileViews(await host.getViews());
      signal.throwIfAborted();
      if (editors.has(profileId)) throw new Error('RDP_PROFILE_EDITING');
      const profile = await profiles.call('profiles.get', { id: profileId }) as Profile;
      if (input.revision !== profile.revision) throw new Error('PROFILE_CONFLICT');
      let session = [...sessions.values()].find(value => value.owner === profileId && active(value));
      const reused = !!session;
      if (!session) {
        const password = await profiles.call('profiles.password', profile) as string | null;
        if (password === null) return { missingPassword: true as const };
        const trusts = await profiles.call('trusts.list', {}) as Trust[];
        signal.throwIfAborted();
        session = await createSession({ ...profile, password, trustedSha256: trusts.find(trust => trust.host === profile.host && trust.port === profile.port)?.sha256 }, profileId, signal);
        session.connecting = { pending: 0 };
      }
      // Track only overlapping connection attempts, never callers or conversation runs.
      const connecting = session.connecting;
      if (connecting) connecting.pending++;
      return { session, connecting, reused };
    });
    if ('missingPassword' in started) return { profile_id: profileId, state: 'password_required', message: 'Save a password in the server profile or connect from its desktop page.' };
    const { session, connecting, reused } = started;
    try {
      await waitForConnection(session, signal, deadline);
      signal.throwIfAborted();
      delete session.connecting;
      const view = (await host.getViews()).find(view => view.instanceId === session.owner) ?? null;
      return { ...summary(session), reused, view };
    } finally {
      if (connecting) {
        connecting.pending--;
        await changeResource(async () => {
          if (session.connecting !== connecting || connecting.pending) return;
          delete session.connecting;
          // A cancelled/expired attempt may stop an unfinished connection it created.
          // An established session and connections reused from the UI remain independent.
          if (session.state !== 'connected') await disconnect(session.display.id);
        });
      }
    }
  },
  async list_profiles(_args: unknown, { signal }: ToolContext) {
    signal.throwIfAborted();
    return profiles.call('profiles.list', {});
  },
  async list_sessions(_args: unknown, { signal }: ToolContext) {
    signal.throwIfAborted();
    return [...sessions.values()].map(summary);
  },
  async screenshot(args: unknown, { signal }: ToolContext) {
    signal.throwIfAborted();
    const input = record(args), id = text(input.session_id, 80);
    if (input.include_cursor !== undefined && typeof input.include_cursor !== 'boolean') throw new Error('Invalid cursor setting.');
    const session = sessions.get(id);
    if (!session) throw new Error('RDP_SESSION_CLOSED');
    const result = await command(session, 'screenshot', { includeCursor: input.include_cursor ?? true }, signal);
    signal.throwIfAborted();
    return result;
  },
  async disconnect(args: unknown, { signal }: ToolContext) {
    const id = text(record(args).session_id, 80);
    return changeResource(async () => {
      signal.throwIfAborted();
      await disconnect(id);
      return { session_id: id, state: 'closed' };
    });
  },
};
export async function deactivate() {
  stopping = true;
  releaseViews?.(); releaseViews = undefined;
  // Closing helpers also settles pending input and startup receipts. Waiting for
  // resource creation first could otherwise block the very cleanup it needs.
  await Promise.all([resourceChanges, clipboardChanges.catch(() => {}), ...[...sessions.values()].map(stop)]);
  sessions.clear(); editors.clear(); opening.clear(); selection = undefined;
}
