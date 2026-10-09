import { Desktop } from './desktop';
import { closeContextMenu, openContextMenu } from './context-menu';
import type { Profile, RuntimeState, Target, Trust } from '../profile-types';
import { i18n, initializeLanguages, setLanguage, t } from './i18n';

type Toolbar = { status?: { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }; actions: { id: string; label: string; icon: 'x' | 'unplug' | 'list'; disabled: boolean }[] };

declare global {
  interface Window {
    anas: {
      getContext(): Promise<PageContext>;
      registerLifecycle(handlers: { prepare(input: LifecycleInput): Promise<Restore>; activate(input: LifecycleInput): Promise<void>; resume(input: LifecycleInput): Promise<void>; dispose(input: LifecycleInput): Promise<void> }): void;
      ready(): Promise<void>;
      failed(): Promise<void>;
      getInfo(): Promise<{ language: string; theme: string; fontSize: number; view: { instanceId: string; location: 'sidebar' | 'window' } }>;
      onViewChanged(listener: (view: { instanceId: string; location: 'sidebar' | 'window' }) => void): () => void;
      setToolbar(toolbar: Toolbar | null): Promise<void>;
      onToolbarAction(listener: (id: string) => void | Promise<void>): () => void;
      getLanguageResources(): Promise<{ resources: Record<string, Record<string, unknown>>; errors: string[] }>;
      openHome(): Promise<void>;
      openView(options: { instanceId: string; location: 'sidebar' | 'window'; title?: string; icon?: string }): Promise<void>;
      moveView(target: 'sidebar' | 'window' | { location: 'sidebar' | 'window'; instanceId: string }): Promise<void>;
      data: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
      backend: { call(method: string, params: unknown): Promise<unknown> };
    };
  }
}
type SessionRef = { id: string; url: string; token: string };
type Lease = { owner: string | null; epoch: number };
type PageContext = { panelId: string; pageId: string; location: 'sidebar' | 'window'; phase: 'preparing' | 'active' | 'suspended'; restoreState: Restore | null; view: { content: { instanceId: string } } };
type LifecycleInput = { signal: AbortSignal; context: PageContext; reason?: 'moved' | 'closed'; targetPageId?: string };
type ConnectionProfile = Omit<Profile, 'revision'>;
type ViewState =
  | { kind: 'manager'; selected?: Profile; editorOpen: boolean; returnId?: string; passwordEdited: boolean; deletePending: boolean;
      fields: Record<string, { value: string; checked: boolean }> }
  | { kind: 'connection'; profile?: ConnectionProfile; password: string; rememberPassword: boolean; passwordPrompt: boolean; pendingTrust?: Trust };
type Restore = { session: SessionRef | null; lease: Lease | null; view: ViewState; statusKey: string; errorKey?: string; scroll: number };
let pageContext: PageContext;
let handoff = true;
let lease: Lease | null = null;
type SessionStatus = { state: string; certificate: { sha256: string; trusted: boolean } | null };
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
function connectionActions(): Toolbar['actions'] {
  return [
    { id: 'profiles', label: t('actions.servers'), icon: 'list', disabled: !ready },
    { id: 'disconnect', label: t(connecting ? 'actions.cancel' : 'actions.disconnect'), icon: connecting ? 'x' : 'unplug', disabled: !connecting && !session },
  ];
}
function presentation() {
  element('connection-header').hidden = instanceId !== 'main' && location === 'window' && toolbarReady;
  element('connection-name').hidden = !element('connection-header').hidden;
  if (!releaseToolbarListener || closing) return;
  const toolbar: Toolbar | null = instanceId === 'main' ? null : {
    status: { label: t(statusKey), tone: connected ? 'success' : connecting || disconnecting ? 'warning' : 'neutral' },
    actions: connectionActions(),
  };
  const snapshot = JSON.stringify(toolbar);
  if (snapshot === toolbarSnapshot) return;
  toolbarSnapshot = snapshot;
  const revision = ++toolbarRevision;
  void window.anas.setToolbar(toolbar).then(() => {
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
  if (code.includes('RDP_LOCATION_SAVE_FAILED')) failure('errors.location_save');
  else if (code.includes('PANEL_') || code.includes('RDP_LOCATION_UNAVAILABLE')) failure('errors.move');
  else if (code.includes('RDP_PROFILE_ACTIVE')) failure('errors.active');
  else if (code.includes('RDP_PROFILE_OPEN')) failure('errors.profile_open');
  else if (code.includes('RDP_PROFILE_EDITING')) failure('errors.profile_editing');
  else if (code.includes('RDP_SESSION_CLOSED')) failure('errors.session_ended');
  else if (code.includes('RDP_SESSIONS_UNAVAILABLE')) failure('errors.sessions');
  else if (code.includes('PROFILE_CONFLICT')) failure('errors.conflict');
  else if (code.includes('PROFILE_MISSING')) failure('errors.missing');
  else if (code.includes('PASSWORD_UNREADABLE')) failure('errors.password');
  else if (code.includes('PROFILE_READ_FAILED')) failure('errors.read');
  else failure('errors.profile');
}
function controls() {
  element('connection').toggleAttribute('inert', !ready);
  element('profile-editor').toggleAttribute('inert', !ready);
  const busy = connecting || connected || disconnecting || savingTrust || editing || !ready;
  const manager = instanceId === 'main';
  element('manager').hidden = !manager || editorOpen;
  element('manager').toggleAttribute('inert', !ready);
  element('profile-editor').hidden = !manager || !editorOpen;
  element('connection').hidden = manager || connected;
  element('connection-actions').hidden = manager;
  element('manage-profiles').hidden = manager;

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
  for (const action of connectionActions()) {
    const button = element<HTMLButtonElement>(action.id === 'profiles' ? 'manage-profiles' : action.id);
    button.disabled = action.disabled;
    button.title = action.label;
    button.setAttribute('aria-label', action.label);
    for (const icon of Array.from(button.querySelectorAll<SVGElement>('[data-icon]'))) icon.toggleAttribute('hidden', icon.dataset.icon !== action.icon);
  }
  input('accept-certificate').disabled = connecting || connected || savingTrust;
  for (const id of ['host', 'port', 'username', 'domain', 'password', 'name', 'open-mode', 'remember-password', 'run-in-background', 'new', 'add-server', 'delete', 'save', 'up', 'down', 'cancel-edit', 'confirm-delete', 'cancel-delete', 'retry-profiles', 'reload-conflict']) input(id).disabled = busy;
  for (const row of Array.from(element('profiles').querySelectorAll<HTMLElement>('li'))) {
    const saved = profiles.some(profile => profile.id === row.dataset.id);
    for (const button of Array.from(row.querySelectorAll<HTMLButtonElement>('button'))) {
      button.disabled = busy || (button.dataset.action === 'edit' && (!saved || profileLocked(row.dataset.id))) || (['start', 'resume'].includes(button.dataset.action ?? '') && editingProfiles.includes(row.dataset.id!));
      if (button.dataset.action === 'edit') button.hidden = button.disabled;
    }
  }
  const locked = editorOpen && profileLocked(selected?.id);
  for (const id of ['host', 'port', 'username', 'domain', 'password', 'name', 'open-mode', 'remember-password', 'run-in-background', 'save']) input(id).disabled ||= locked;
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
  input('run-in-background').checked = profile?.runInBackground ?? false;
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
      if (oldOrphans !== nextOrphans) renderProfiles();
      await applyProfileSelection(runtime.selection);
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
async function applyProfileSelection(request: RuntimeState['selection']) {
  const available = () => instanceId === 'main' && ready && !closing && !handoff && !editing && !editorOpen && !deletePending;
  if (!request || !available()) return;
  try {
    const saved = await window.anas.backend.call('profiles.list', {}) as Profile[];
    if (!available()) return;
    profiles = saved;
    renderProfiles();
    const profile = profiles.find(profile => profile.id === request.id);
    if (profile) selectProfile(profile);
    else translate();
    focusSelectedProfile(request.id);
    await window.anas.backend.call('profiles.ackSelection', { token: request.token });
  } catch (error) { profileFailure(error); }
}
function showProfileMenu(id: string, trigger: HTMLElement, point: { x: number; y: number }) {
  if (instanceId !== 'main' || !ready || editing || editorOpen || handoff) return;
  const index = profiles.findIndex(profile => profile.id === id);
  const running = activeProfile(id);
  if (index < 0 && !running) return;
  selectProfile(profiles[index]);
  openContextMenu(trigger, point, t('fields.profiles'), [
    ...(['sidebar', 'window'] as const).map(location => ({ label: t(`actions.${running ? 'resume' : 'start'}_${location}`), action: () => { void startProfile(id, !!running, location); } })),
    ...(running ? [{ label: t('actions.disconnect'), action: () => { void disconnectProfile(id, running.id); } }] : []),
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
async function disconnectProfile(id: string, resourceId: string) {
  await edit(async () => {
    await window.anas.backend.call('disconnect', { owner: id, id: resourceId });
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
    const running = activeProfile(id);
    if (running) {
      const existing = await window.anas.backend.call('find', { owner: id }) as SessionRef | null;
      if (!existing || existing.id !== running.id) throw new Error('RDP_SESSION_CLOSED');
      const profile = running.profile;
      await window.anas.openView({ instanceId: id, location: openLocation ?? profile.openMode, title: profile.name, icon: 'assets/desktop.svg' });
      if (openLocation) await window.anas.moveView({ location: openLocation, instanceId: id });
      await window.anas.backend.call('connection.setLocation', { id });
      status('status.opened');
      return;
    }
    if (resumeOnly) throw new Error('RDP_SESSION_CLOSED');
    let profile = await loadSavedProfile(id);
    if (openLocation && openProfileIds.includes(id)) {
      await window.anas.moveView({ location: openLocation, instanceId: id });
      await window.anas.backend.call('connection.setLocation', { id });
      profile = await loadSavedProfile(id);
    }
    const token = await window.anas.backend.call('profiles.launch', { id: profile.id, revision: profile.revision });
    try {
      await window.anas.openView({ instanceId: profile.id, location: openLocation ?? profile.openMode, title: profile.name, icon: 'assets/desktop.svg' });
      await window.anas.backend.call('connection.setLocation', { id });
    }
    catch (error) {
      await window.anas.backend.call('profiles.cancelLaunch', { id: profile.id, location: profile.openMode, token });
      throw error;
    }
    status('status.opened');
  });
}
async function saveProfile() {
  const next = await window.anas.backend.call('profiles.save', {
    ...target(), id: selected?.id, revision: selected?.revision,
    name: input('name').value.trim() || input('host').value.trim(), openMode: input('open-mode').value,
    runInBackground: input('run-in-background').checked,
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
async function disconnect() {
  if (disconnecting) return;
  disconnecting = true;
  const mine = ++generation;
  connecting = false;
  connected = false;
  const old = session;
  const oldDesktop = desktop;
  session = undefined;
  desktop = undefined;
  oldDesktop?.dispose();
  lease = null;
  status('status.disconnecting');
  controls();
  // Cancel a Start click still waiting to be consumed when the user disconnects.
  if (instanceId !== 'main') await window.anas.backend.call('profiles.consumeLaunch', { id: instanceId, location }).catch(() => null);
  try {
    if (old) await window.anas.backend.call('disconnect', { owner, id: old.id });
  } catch {
    if (generation === mine) failure('errors.cleanup');
  } finally {
    disconnecting = false;
    if (generation === mine) { status('status.disconnected'); controls(); }
  }
}
async function attach(connection: SessionRef, signal?: AbortSignal) {
  signal?.throwIfAborted();
  desktop?.dispose();
  const mine = new Desktop(element('desktop'), { ...connection, pageId: pageContext.pageId }, state => {
    if (closing || session !== connection) return;
    if (state === 'connected') { connected = true; status('status.connected'); }
    else if (state === 'connecting') status('status.authenticating');
    else if (state === 'closed' || state.startsWith('RDP_') || state === 'connection_failed') {
      connected = false;
      status('status.disconnected');
      if (!handoff) failure('errors.interrupted');
      void refreshDisconnectedSession().catch(() => {});
    }
    controls();
  });
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
    if (locationSave) await locationSave;
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
      const created = await window.anas.backend.call('create', { owner, name: profile.name, openMode: profile.openMode, runInBackground: profile.runInBackground, host: profile.host, port: profile.port, username: profile.username, domain: profile.domain, password, trustedSha256 }) as SessionRef;
      if (generation !== mine) {
        if (!closing || !profile.runInBackground) await window.anas.backend.call('disconnect', { owner, id: created.id });
        return;
      }
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
async function openProfiles() {
  try {
    await window.anas.openHome();
    await window.anas.backend.call('profiles.select', { id: instanceId });
  } catch { failure('errors.open_profiles'); }
}
element('manage-profiles').addEventListener('click', () => void openProfiles());
element('password').addEventListener('input', () => { passwordEdited = true; });
element('remember-password').addEventListener('change', () => controls());
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
element('disconnect').addEventListener('click', () => void disconnect());
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
let locationSave: Promise<void> | undefined;
let locationPending = false;
async function rememberLocation() {
  if (instanceId === 'main' || handoff || closing || !ready) return;
  locationPending = true;
  if (locationSave) return locationSave;
  locationSave = (async () => {
    while (locationPending && !closing && !handoff) {
      locationPending = false;
      try {
        const context = await window.anas.getContext();
        if (context.phase !== 'active' || closing || handoff) continue;
        const result = await window.anas.backend.call('connection.setLocation', { id: instanceId }) as { location: 'sidebar' | 'window' };
        if (connectionProfile) connectionProfile.openMode = result.location;
        if (errorKey === 'errors.location_save') { errorKey = undefined; renderError(); }
      } catch (error) { if (!closing) profileFailure(error); }
    }
  })().finally(() => {
    locationSave = undefined;
    if (locationPending && !closing && !handoff) void rememberLocation();
  });
  return locationSave;
}
let releaseViewListener: (() => void) | undefined;
async function checkLaunch() {
  if (handoff || checkingLaunch || closing || !ready || instanceId === 'main') return;
  checkingLaunch = true;
  const busy = connecting || connected || disconnecting || editing || savingTrust;
  const mine = generation;
  try {
    if (locationSave) await locationSave;
    if (closing || handoff || mine !== generation) return;
    const profile = await window.anas.backend.call('profiles.consumeLaunch', { id: instanceId, location }) as Profile | null;
    if (!profile || busy || closing || mine !== generation || connecting || connected || disconnecting || editing || savingTrust) return;
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
  closeContextMenu();
  closing = true; releaseViewListener?.(); releaseToolbarListener?.(); clearInterval(infoTimer); clearInterval(launchTimer); clearInterval(sessionTimer);
  desktop?.dispose(); desktop = undefined;
}
window.addEventListener('pagehide', disposePage);
async function idle(signal: AbortSignal) {
  while (connectionOperations || connecting || disconnecting || savingTrust || editing || checkingLaunch || refreshingInfo || sessionRefresh || locationSave) {
    signal.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  signal.throwIfAborted();
}
const fieldIds = ['host', 'port', 'username', 'domain', 'password', 'name', 'open-mode', 'remember-password', 'run-in-background'];
window.anas.registerLifecycle({
  async prepare({ signal }) {
    closeContextMenu();
    handoff = true;
    desktop?.release();
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
    return { session: session ?? null, lease, view, statusKey, errorKey, scroll: document.querySelector('main')!.scrollTop };
  },
  async activate({ signal, context }) {
    pageContext = context;
    if (await refreshSession(signal)) {
      try { await claim(lease ?? await currentLease(), signal); }
      catch (error) { if (await refreshSession(signal)) throw error; }
    }
    signal.throwIfAborted();
    handoff = false;
  },
  async resume({ signal }) {
    await restoreInput(signal);
    signal.throwIfAborted();
    handoff = false;
  },
  async dispose({ signal, reason }) {
    handoff = true;
    signal.throwIfAborted();
    if (reason === 'closed' && instanceId !== 'main') {
      // Cancel presentation work even while connecting. The backend serializes
      // closing with create and decides whether the connection remains alive.
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
  const labels: Record<string, string> = { name: 'name', 'open-mode': 'open_mode', 'run-in-background': 'run_in_background', 'remember-password': 'remember_password', 'session-remember-password': 'remember_password', host: 'host', port: 'port', username: 'username', domain: 'domain', password: 'password' };
  for (const [id, key] of Object.entries(labels)) document.querySelector('[data-label="' + id + '"]')!.textContent = t('fields.' + key);
  const buttons = { 'add-server': 'actions.add_server', 'cancel-edit': 'actions.cancel', 'confirm-delete': 'actions.delete', 'cancel-delete': 'actions.cancel', 'retry-profiles': 'actions.retry', 'reload-conflict': 'actions.reload', save: 'actions.save', 'mode-sidebar': 'modes.sidebar', 'mode-window': 'modes.window', 'accept-certificate': 'certificate.accept' };
  for (const [id, key] of Object.entries(buttons)) element(id).textContent = t(key);
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
  instanceId = pageContext.view.content.instanceId;
  location = pageContext.location;
  owner = instanceId;
  const restore = pageContext.restoreState;
  const languages = await window.anas.getLanguageResources();
  await initializeLanguages(languages.resources);
  if (instanceId !== 'main') await window.anas.backend.call('connection.open', { owner });
  element('language-warning').hidden = languages.errors.length === 0;
  releaseToolbarListener = window.anas.onToolbarAction(async id => {
    if (id === 'profiles') { await openProfiles(); return; }
    if (id !== 'disconnect' || (!connecting && !session)) return;
    await disconnect();
  });
  let viewChanged = false;
  releaseViewListener = window.anas.onViewChanged(view => {
    viewChanged = true;
    instanceId = view.instanceId;
    location = view.location;
    presentation();
    if (!handoff) { void rememberLocation(); void checkLaunch(); }
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
  infoTimer = setInterval(() => { void syncInfo().catch(() => {}); }, 5000);
  window.addEventListener('focus', () => {
    void syncInfo().catch(() => {});
    void rememberLocation();
    void checkLaunch();
    if (instanceId === 'main' && !handoff && !closing) void refreshSessions().catch(() => undefined);
  });
} catch (error) { if (String(error).includes('PROFILE_')) profileFailure(error); else failure('errors.load'); await window.anas.failed().catch(() => undefined); }
