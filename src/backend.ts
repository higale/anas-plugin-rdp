import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Profiles } from './profiles';
import type { SessionSummary, RuntimeState, CallContext, Profile } from './profile-types';

type Context = { pluginId: string; packageDirectory: string; dataDirectory: string };
type Session = { profile: SessionSummary['profile']; owner: string; child: ChildProcessWithoutNullStreams; state: string; certificate?: { sha256: string; trusted: boolean };
  display: { id: string; url: string; token: string }; requests: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
  exited: Promise<void>; closed: boolean };
let context: Context;
let profiles: Profiles;
const sessions = new Map<string, Session>();
const editors = new Map<string, string>();
const opening = new Map<string, { token: unknown; expires: number }>();
let selection: RuntimeState['selection'];
let resourceChanges: Promise<unknown> = Promise.resolve();
const active = (session: Session) => !session.closed && !['closed', 'connection_failed', 'certificate_required'].includes(session.state);
const running = (owner: unknown) => [...sessions.values()].some(session => session.owner === owner && active(session));
export function activate(value: Context) { context = value; profiles = new Profiles(value.dataDirectory); selection = undefined; }
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
function command(session: Session, method: string, params: Record<string, unknown>) {
  if (session.closed) throw new Error('RDP_SESSION_CLOSED');
  return new Promise((resolve, reject) => {
    const request = randomUUID();
    const timer = setTimeout(() => { session.requests.delete(request); reject(new Error('RDP_CONTROL_TIMEOUT')); }, 5000);
    session.requests.set(request, { resolve, reject, timer });
    session.child.stdin.write(JSON.stringify({ ...params, method, request }) + '\n');
  });
}
export function call(method: string, params: unknown, caller: CallContext): Promise<unknown> {
  // Serialize configuration writes with resource creation: a stale page cannot
  // save/delete between checking the running state and committing its changes.
  if (['create', 'connection.close', 'connection.setLocation', 'profiles.save', 'profiles.savePassword', 'profiles.delete', 'profiles.beginEdit', 'profiles.endEdit', 'profiles.launch', 'profiles.cancelLaunch'].includes(method)) {
    const operation = resourceChanges.then(() => {
      if (['profiles.save', 'profiles.savePassword', 'profiles.delete'].includes(method) && running(record(params).id)) throw new Error('RDP_PROFILE_ACTIVE');
      return execute(method, params, caller);
    });
    resourceChanges = operation.catch(() => undefined);
    return operation;
  }
  return execute(method, params, caller);
}
async function execute(method: string, params: unknown, caller: CallContext) {
  if (!caller || !Array.isArray(caller.views)) throw new Error('RDP_HOST_CONTEXT_REQUIRED');
  // Host-owned stable panel identities survive moves. Closed/failed pages
  // disappear from the next snapshot, without relying on an unload callback.
  const visible = new Set(caller.views.map(view => view.instanceId));
  for (const [id, panelId] of editors) if (!caller.views.some(view => view.panelId === panelId)) editors.delete(id);
  for (const [id, request] of opening) if (visible.has(id) || request.expires <= Date.now()) opening.delete(id);
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
      sessions: [...sessions.values()].filter(active).map(session => ({ id: session.display.id, state: session.state,
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
    if (method === 'profiles.save' && (visible.has(id) || opening.has(id))) throw new Error('RDP_PROFILE_OPEN');
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
  if (method.startsWith('profiles.') || method.startsWith('trusts.')) return profiles.call(method, params);
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
  if (method === 'create') {
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
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    const binary = join(context.packageDirectory, 'native', `${process.platform}-${process.arch}`, `anas-rdp-session${process.platform === 'win32' ? '.exe' : ''}`);
    const child = spawn(binary, ['--session'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const session: Session = { profile: { id: owner, name, host, port: Number(port), username, domain, openMode, runInBackground }, owner, child, state: 'starting', display: { id, token, url: '' }, requests: new Map(), exited: Promise.resolve(), closed: false };
    session.exited = new Promise(resolve => child.once('close', () => {
      session.closed = true;
      if (!['connection_failed', 'certificate_required'].includes(session.state)) session.state = 'closed';
      for (const pending of session.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('RDP_SESSION_CLOSED')); }
      session.requests.clear(); resolve();
    }));
    sessions.set(id, session);
    child.stderr.resume();
    child.stdin.on('error', () => { session.state = 'connection_failed'; });
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Connection helper startup timed out.')), 5000);
      child.once('error', () => reject(new Error('Connection helper could not start on this platform.')));
      child.once('close', () => reject(new Error('Connection helper closed before becoming ready.')));
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          const event = JSON.parse(line);
          if (typeof event.request === 'string') {
            const pending = session.requests.get(event.request);
            if (pending) { session.requests.delete(event.request); clearTimeout(pending.timer);
              event.error ? pending.reject(new Error(event.error)) : pending.resolve(event.result); }
            return;
          }
          if (typeof event.status === 'string' && (event.status !== 'closed' || !['connection_failed', 'certificate_required'].includes(session.state))) session.state = event.status;
          if (event.certificate) session.certificate = event.certificate;
          if (event.status === 'ready') resolve(event.port);
        } catch { session.state = 'connection_failed'; child.kill(); }
      });
    });
    child.stdin.write(JSON.stringify({ host, port, username, password, domain, trusted_sha256: trustedSha256, origin: `anas-plugin://${context.pluginId}`, token }) + '\n');
    try {
      session.display.url = `ws://127.0.0.1:${await ready}/display`;
      return session.display;
    } catch (error) { await stop(session); sessions.delete(id); throw error; }
    finally { clearTimeout(timer); }
  }
  const resourceId = text(input.id, 80), session = sessions.get(resourceId);
  if (!session && method === 'disconnect') return null;
  if (!session) throw new Error('RDP_SESSION_CLOSED');
  if (session.owner !== owner) throw new Error('Connection does not belong to this resource owner.');
  if (method === 'status') return { state: session.state, certificate: session.certificate ?? null };
  if (method === 'lease') return command(session, 'lease', {});
  if (method === 'claim' || method === 'release') return command(session, method, {
    expected: input.expected ?? null, expectedEpoch: input.expectedEpoch, ...(method === 'claim' ? { page: text(input.pageId, 80) } : {})
  });
  if (method === 'disconnect') { await stop(session); sessions.delete(resourceId); return null; }
  throw new Error('Unknown RDP operation.');
}
export async function deactivate() { await resourceChanges; await Promise.all([...sessions.values()].map(stop)); sessions.clear(); editors.clear(); opening.clear(); selection = undefined; }
