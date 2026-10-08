import { init, Backend } from '../../artifacts/upstream/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js';
import '../../artifacts/upstream/iron-remote-desktop/iron-remote-desktop.js';
import type { UserInteraction, NewSessionInfo } from '../../artifacts/upstream/iron-remote-desktop/index';
import type { Profile, Target, Trust } from '../profile-types';
import { i18n, initializeLanguages, setLanguage, t } from './i18n';

type Toolbar = { status?: { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }; actions: { id: string; label: string; icon: 'x' | 'unplug'; disabled: boolean }[] };

declare global {
  interface Window {
    anas: {
      getInfo(): Promise<{ language: string; theme: string; fontSize: number; view: { instanceId: string; location: 'sidebar' | 'window' } }>;
      onViewChanged(listener: (view: { instanceId: string; location: 'sidebar' | 'window' }) => void): () => void;
      setToolbar(toolbar: Toolbar | null): Promise<void>;
      onToolbarAction(listener: (id: string) => void | Promise<void>): () => void;
      getLanguageResources(): Promise<{ resources: Record<string, Record<string, unknown>>; errors: string[] }>;
      openView(options: { instanceId: string; location: 'sidebar' | 'window'; title?: string }): Promise<void>;
      data: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
      backend: { call(method: string, params: unknown): Promise<unknown> };
    };
  }
}
type Bridge = { id: string; proxy: string; token: string };
type BridgeStatus = { state: string; certificate: { sha256: string; trusted: boolean } | null };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const owner = crypto.randomUUID();
let generation = 0;
let bridge: Bridge | undefined;
let ui: UserInteraction | undefined;
let desktop: HTMLElement | undefined;
let desktopAbort: AbortController | undefined;
let releaseLayout: (() => void) | undefined;
let trusts: Trust[] = [];
let pendingTrust: Trust | undefined;
let connecting = false;
let connected = false;
let disconnecting = false;
let savingTrust = false;
let profiles: Profile[] = [];
let selected: Profile | undefined;
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
function presentation() {
  element('connection-header').hidden = instanceId !== 'main' && location === 'window' && toolbarReady;
  if (!releaseToolbarListener || closing) return;
  const toolbar: Toolbar | null = instanceId === 'main' ? null : {
    status: { label: t(statusKey), tone: connected ? 'success' : connecting || disconnecting ? 'warning' : 'neutral' },
    actions: [{ id: 'disconnect', label: t(connecting ? 'actions.cancel' : 'actions.disconnect'), icon: connecting ? 'x' : 'unplug', disabled: !connecting && !connected }],
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
    element('toolbar-error').textContent = t('errors.toolbar');
    element('toolbar-error').hidden = false;
  });
}
function status(key: string) { statusKey = key; element('status').textContent = t(key); presentation(); }
function failure(key: string) { errorKey = key; element('error').hidden = false; element('error').textContent = t(key); element('retry-profiles').hidden = instanceId !== 'main' || editorOpen; }
function profileFailure(error: unknown) {
  const code = String(error);
  if (code.includes('PROFILE_CONFLICT')) failure('errors.conflict');
  else if (code.includes('PROFILE_MISSING')) failure('errors.missing');
  else if (code.includes('PASSWORD_UNREADABLE')) failure('errors.password');
  else if (code.includes('PROFILE_READ_FAILED')) failure('errors.read');
  else failure('errors.profile');
}
function controls() {
  element('connection').toggleAttribute('inert', !ready);
  const busy = connecting || connected || disconnecting || savingTrust || editing || !ready;
  const manager = instanceId === 'main';
  element('manager').hidden = !manager || editorOpen;
  element('manager').toggleAttribute('inert', !ready);
  element('connection').hidden = manager && !editorOpen;
  element('disconnect').hidden = manager;
  element('connect').hidden = manager;
  element('cancel-edit').hidden = !manager;
  element('copy').hidden = !manager;
  element('status').hidden = manager && statusKey === 'status.idle';
  input('connect').disabled = busy;
  input('disconnect').disabled = !connecting && !connected;
  input('disconnect').textContent = connecting ? t('actions.cancel') : t('actions.disconnect');
  input('accept-certificate').disabled = connecting || connected || savingTrust;
  for (const id of ['host', 'port', 'username', 'domain', 'password', 'name', 'open-mode', 'remember-password', 'new', 'add-server', 'copy', 'delete', 'save', 'reload', 'up', 'down', 'cancel-edit', 'confirm-delete', 'cancel-delete', 'retry-profiles']) input(id).disabled = busy;
  for (const button of Array.from(element('profiles').querySelectorAll('button'))) button.disabled = busy;
  input('copy').disabled ||= !selected;
  input('delete').disabled ||= !selected;
  const index = profiles.findIndex(item => item.id === selected?.id);
  input('up').disabled ||= index <= 0;
  input('down').disabled ||= index < 0 || index === profiles.length - 1;
  if (instanceId === 'main' && !input('remember-password').checked) input('password').disabled = true;
  input('password').placeholder = selected?.hasPassword && !passwordEdited ? t('profiles.password_saved') : '';
  document.body.dataset.connected = String(connected);
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
  element('error').hidden = true;
  errorKey = undefined;
  element('retry-profiles').hidden = true;
  element('trust').hidden = true;
  pendingTrust = undefined;
  translate(); controls();
}
async function refreshProfiles(id = selected?.id) {
  profiles = await window.anas.backend.call('profiles.list', {}) as Profile[];
  const profile = id === undefined ? profiles[0] : profiles.find(item => item.id === id);
  if (instanceId !== 'main' && !profile) throw new Error('PROFILE_MISSING');
  renderProfiles();
  selectProfile(profile);
}
function renderProfiles() {
  element('profiles').replaceChildren(...profiles.map(profile => {
    const row = document.createElement('li');
    row.dataset.id = profile.id;
    const choose = document.createElement('button');
    choose.type = 'button'; choose.className = 'profile-select';
    const name = document.createElement('strong'); name.textContent = profile.name;
    const address = document.createElement('small');
    address.textContent = `${profile.host.includes(':') ? `[${profile.host}]` : profile.host}:${profile.port}`;
    choose.append(name, address);
    choose.addEventListener('click', () => selectProfile(profile));
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
        if (action === 'start') void startProfile(profile.id);
        else void openEditor(profile.id);
      });
      actions.append(button);
    }
    row.append(choose, actions);
    return row;
  }));
  element('empty').hidden = profiles.length > 0;
}
async function loadSavedProfile(id: string): Promise<Profile> {
  // A reused home may predate saves in a connection page or another home view.
  // Refresh before starting/editing, but never replace an already-open draft.
  await refreshProfiles(id);
  if (!selected) throw new Error('PROFILE_MISSING');
  return selected;
}
async function openEditor(id: string) {
  await edit(async () => {
    await loadSavedProfile(id);
    returnId = id; editorOpen = true; translate();
  });
  if (editorOpen && selected?.id === id) input('name').focus();
}
async function startProfile(id: string) {
  await edit(async () => {
    const profile = await loadSavedProfile(id);
    const token = await window.anas.backend.call('profiles.launch', { id: profile.id, revision: profile.revision });
    try { await window.anas.openView({ instanceId: profile.id, location: profile.openMode, title: profile.name }); }
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
    passwordAction: !input('remember-password').checked ? 'remove' : selected?.hasPassword && !passwordEdited ? 'keep' : 'set',
    ...(input('remember-password').checked && (passwordEdited || !selected?.hasPassword) ? { password: input('password').value } : {}),
  }) as Profile;
  selected = next;
  passwordEdited = false;
  if (next.hasPassword) input('password').value = '';
  return next;
}
async function edit(action: () => Promise<void>) {
  if (editing || connecting || connected || savingTrust || !ready) return;
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
  const old = bridge;
  const oldUi = ui;
  const oldDesktop = desktop;
  bridge = undefined;
  desktop = undefined;
  ui = undefined;
  desktopAbort?.abort();
  desktopAbort = undefined;
  releaseLayout?.();
  releaseLayout = undefined;
  // IronRDP's input channel is already closed after session.run() ends.
  // A rejected graceful shutdown must not prevent transport or UI cleanup.
  try { oldUi?.shutdown(); } catch { /* The helper below owns transport cleanup. */ }
  oldDesktop?.remove();
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
async function makeDesktop(): Promise<UserInteraction> {
  const remote = document.createElement('iron-remote-desktop') as HTMLElement & { module: typeof Backend };
  remote.setAttribute('scale', 'fit');
  remote.setAttribute('flexcenter', 'true');
  remote.setAttribute('verbose', 'false');
  const abort = new AbortController();
  desktopAbort = abort;
  const ready = new Promise<UserInteraction>((resolve, reject) => {
    const timer = setTimeout(() => { abort.abort(); }, 5000);
    abort.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Desktop initialization canceled or timed out.')); }, { once: true });
    remote.addEventListener('ready', event => {
      clearTimeout(timer);
      fitDesktop(remote);
      resolve((event as CustomEvent).detail.irgUserInteraction);
    }, { once: true, signal: abort.signal });
  });
  remote.module = Backend;
  desktop = remote;
  element('desktop').append(remote);
  return ready;
}
function fitDesktop(remote: HTMLElement) {
  const root = remote.shadowRoot;
  const canvas = root?.querySelector('canvas');
  if (!root || !canvas) return;
  // The pinned component's fit calculation uses the whole browser viewport.
  // Size its viewer to our desktop slot; retain its centering and canvas input
  // mapping, which uses the canvas's actual bounding rectangle.
  const style = document.createElement('style');
  style.textContent = '.screen-viewer{width:var(--desktop-width)!important;height:var(--desktop-height)!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important}';
  root.append(style);
  const resize = () => {
    if (!canvas.width || !canvas.height) return;
    const ratio = Math.min(remote.clientWidth / canvas.width, remote.clientHeight / canvas.height);
    remote.style.setProperty('--desktop-width', `${canvas.width * ratio}px`);
    remote.style.setProperty('--desktop-height', `${canvas.height * ratio}px`);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(remote);
  const attributes = new MutationObserver(resize);
  attributes.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
  releaseLayout = () => { observer.disconnect(); attributes.disconnect(); };
  resize();
}
async function connect() {
  if (connecting || connected || disconnecting || savingTrust || editing || !ready) return;
  if (instanceId === 'main') {
    await saveEditor();
    return;
  }
  const current = target();
  let password = input('password').value;
  const mine = ++generation;
  connecting = true;
  pendingTrust = undefined;
  element('trust').hidden = true;
  element('error').hidden = true;
  status('status.connecting');
  controls();
  let poll: ReturnType<typeof setInterval> | undefined;
  let prepared = false;
  try {
    const profile = await saveProfile();
    if (generation !== mine) return;
    if (profile.hasPassword) password = await window.anas.backend.call('profiles.password', { id: profile.id, revision: profile.revision }) as string;
    trusts = await window.anas.backend.call('trusts.list', {}) as Trust[];
    if (generation !== mine) return;
    prepared = true;
    const trustedSha256 = trusts.find(item => item.host === current.host && item.port === current.port)?.sha256;
    const created = await window.anas.backend.call('create', { owner, host: current.host, port: current.port, trustedSha256 }) as Bridge;
    if (generation !== mine) { await window.anas.backend.call('disconnect', { owner, id: created.id }); return; }
    bridge = created;
    const currentUi = await makeDesktop();
    if (generation !== mine) return;
    ui = currentUi;
    currentUi.setEnableClipboard(false);
    currentUi.setEnableAutoClipboard(false);
    poll = setInterval(() => {
      void window.anas.backend.call('status', { owner, id: created.id }).then(value => {
        if (generation !== mine || !connecting) return;
        const state = (value as BridgeStatus).state;
        if (state === 'streaming') status('status.authenticating');
      }).catch(() => {});
    }, 1000);
    const destination = current.host.includes(':') ? `[${current.host}]:${current.port}` : `${current.host}:${current.port}`;
    const config = currentUi.configBuilder().withUsername(current.username).withPassword(password).withServerDomain(current.domain)
      .withDestination(destination).withProxyAddress(created.proxy).withAuthToken(created.token).withDesktopSize({ width: 1280, height: 800 }).build();
    const session: NewSessionInfo = await currentUi.connect(config);
    if (generation !== mine) { try { currentUi.shutdown(); } catch { /* Canceled transport has closed. */ } return; }
    input('password').value = '';
    connecting = false;
    connected = true;
    currentUi.setVisibility(true);
    status('status.connected');
    controls();
    try { await session.run(); }
    catch { if (generation === mine) failure('errors.interrupted'); }
    if (generation === mine) await disconnect();
  } catch (error) {
    if (generation !== mine) return;
    const info = bridge ? await window.anas.backend.call('status', { owner, id: bridge.id }).catch(() => null) as BridgeStatus | null : null;
    if (generation !== mine) return;
    if (!prepared) profileFailure(error);
    else if (info?.state === 'certificate_required' && info.certificate) {
      pendingTrust = { host: current.host, port: current.port, sha256: info.certificate.sha256 };
      element('fingerprint').textContent = pendingTrust.sha256;
      translateTrust();
      element('trust').hidden = false;
    } else failure('errors.connection');
    await disconnect();
  } finally { clearInterval(poll); }
}

element('connection').addEventListener('submit', event => { event.preventDefault(); void connect(); });
element('password').addEventListener('input', () => { passwordEdited = true; });
element('remember-password').addEventListener('change', () => controls());
function newProfile() { returnId = selected?.id; editorOpen = true; selectProfile(); input('name').focus(); }
element('new').addEventListener('click', newProfile);
element('add-server').addEventListener('click', newProfile);
async function saveEditor() {
  if (!element<HTMLFormElement>('connection').reportValidity()) return;
  await edit(async () => { const profile = await saveProfile(); await refreshProfiles(profile.id); editorOpen = false; translate(); status('status.saved'); });
}
element('save').addEventListener('click', () => void saveEditor());
element('cancel-edit').addEventListener('click', () => void edit(async () => { await refreshProfiles(returnId); editorOpen = false; translate(); }));
element('reload').addEventListener('click', () => void edit(async () => { await refreshProfiles(); status('status.reloaded'); }));
element('retry-profiles').addEventListener('click', () => void edit(async () => { await refreshProfiles(); status('status.reloaded'); }));
element('copy').addEventListener('click', () => void edit(async () => {
  if (!selected) return;
  const profile = await window.anas.backend.call('profiles.copy', { id: selected.id, revision: selected.revision, name: t('profiles.copy_name', { name: selected.name.slice(0, 100) }).slice(0, 120) }) as Profile;
  await refreshProfiles(profile.id);
}));
element('delete').addEventListener('click', () => {
  if (!selected) return;
  deletePending = true; translate(); input('cancel-delete').focus();
});
element('cancel-delete').addEventListener('click', () => { deletePending = false; translate(); input('delete').focus(); });
element('confirm-delete').addEventListener('click', () => {
  if (!deletePending || !selected) return;
  void edit(async () => {
    const index = profiles.findIndex(item => item.id === selected?.id);
    const nextId = profiles[index + 1]?.id ?? profiles[index - 1]?.id;
    await window.anas.backend.call('profiles.delete', { id: selected?.id, revision: selected?.revision });
    await refreshProfiles(nextId); status('status.deleted');
  });
});
for (const [id, direction] of [['up', -1], ['down', 1]] as const) element(id).addEventListener('click', () => void edit(async () => {
  if (!selected) return;
  const index = profiles.findIndex(item => item.id === selected?.id);
  profiles = await window.anas.backend.call('profiles.move', { id: selected.id, revision: selected.revision, direction, neighborId: profiles[index + direction]?.id ?? null }) as Profile[];
  renderProfiles(); selectProfile(profiles.find(item => item.id === selected?.id)); status('status.reordered');
}));
element('disconnect').addEventListener('click', () => void disconnect());
element('accept-certificate').addEventListener('click', async () => {
  const current = target();
  if (savingTrust || connecting || connected || !pendingTrust || pendingTrust.host !== current.host || pendingTrust.port !== current.port) return;
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
  if (checkingLaunch || closing || !ready || instanceId === 'main') return;
  checkingLaunch = true;
  const busy = connecting || connected || disconnecting || editing || savingTrust;
  const mine = generation;
  try {
    const profile = await window.anas.backend.call('profiles.consumeLaunch', { id: instanceId, location }) as Profile | null;
    if (!profile || busy || closing || mine !== generation || connecting || connected || disconnecting || editing || savingTrust) return;
    selectProfile(profile);
    if (profile.hasPassword) void connect();
    else { status('status.password_required'); input('password').focus(); }
  } catch (error) { if (!busy && !closing) profileFailure(error); }
  finally { checkingLaunch = false; }
}
window.addEventListener('pagehide', () => { closing = true; releaseViewListener?.(); releaseToolbarListener?.(); clearInterval(infoTimer); clearInterval(launchTimer); void disconnect(); });

function translateTrust() {
  if (pendingTrust) element('trust-message').textContent = t('certificate.verify', { host: pendingTrust.host, port: pendingTrust.port });
}
function translate() {
  const labels: Record<string, string> = { name: 'name', 'open-mode': 'open_mode', 'remember-password': 'remember_password', host: 'host', port: 'port', username: 'username', domain: 'domain', password: 'password' };
  for (const [id, key] of Object.entries(labels)) document.querySelector('[data-label="' + id + '"]')!.textContent = t('fields.' + key);
  const buttons = { 'add-server': 'actions.add_server', 'cancel-edit': 'actions.cancel', 'confirm-delete': 'actions.delete', 'cancel-delete': 'actions.cancel', 'retry-profiles': 'actions.reload', copy: 'actions.copy', save: 'actions.save', reload: 'actions.reload', 'mode-sidebar': 'modes.sidebar', 'mode-window': 'modes.window', 'accept-certificate': 'certificate.accept' };
  for (const [id, key] of Object.entries(buttons)) element(id).textContent = t(key);
  for (const [id, key] of Object.entries({ new: 'actions.new', delete: 'actions.delete', up: 'actions.up', down: 'actions.down' })) {
    element(id).title = t(key); element(id).setAttribute('aria-label', t(key));
  }
  for (const row of Array.from(element('profiles').querySelectorAll<HTMLElement>('li'))) {
    row.classList.toggle('selected', row.dataset.id === selected?.id);
    row.querySelector('button')!.setAttribute('aria-pressed', String(row.dataset.id === selected?.id));
    for (const button of Array.from(row.querySelectorAll<HTMLElement>('[data-action]'))) button.textContent = t(`actions.${button.dataset.action}`);
  }
  element('profiles').setAttribute('aria-label', t('fields.profiles'));
  element('toolbar').setAttribute('aria-label', t('fields.profiles'));
  element('empty-message').textContent = t('profiles.empty');
  element('delete-confirm').hidden = !deletePending;
  element('delete-message').textContent = t('profiles.delete_confirm', { name: selected?.name ?? '' });
  element('connect').textContent = t('actions.connect');
  element('language-warning').textContent = t('errors.language');
  element('desktop').setAttribute('aria-label', t('plugin.name'));
  element('title').textContent = instanceId === 'main' ? (editorOpen ? selected?.name ?? t('profiles.new') : t('plugin.name')) : selected?.name ?? t('plugin.name');
  document.title = instanceId === 'main' ? t('plugin.name') : selected?.name ?? t('plugin.name');
  element('toolbar-error').textContent = t('errors.toolbar');
  status(statusKey);
  if (errorKey) element('error').textContent = t(errorKey);
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
  } finally { refreshingInfo = false; }
}

try {
  const languages = await window.anas.getLanguageResources();
  await initializeLanguages(languages.resources);
  element('language-warning').hidden = languages.errors.length === 0;
  releaseToolbarListener = window.anas.onToolbarAction(async id => {
    if (id !== 'disconnect' || (!connecting && !connected)) return;
    await disconnect();
  });
  let viewChanged = false;
  releaseViewListener = window.anas.onViewChanged(view => {
    viewChanged = true;
    instanceId = view.instanceId;
    location = view.location;
    presentation();
  });
  const info = await window.anas.getInfo();
  if (!viewChanged) { instanceId = info.view.instanceId; location = info.view.location; }
  document.body.dataset.manager = String(instanceId === 'main');
  await syncInfo();
  await refreshProfiles(instanceId === 'main' ? undefined : instanceId);
  await init('OFF');
  ready = true;
  status('status.idle');
  controls();
  if (instanceId !== 'main') { await checkLaunch(); launchTimer = setInterval(() => { void checkLaunch(); }, 1000); }
  infoTimer = setInterval(() => { void syncInfo().catch(() => {}); }, 5000);
  window.addEventListener('focus', () => {
    void syncInfo().catch(() => {});
    void checkLaunch();
  });
} catch (error) { if (String(error).includes('PROFILE_')) profileFailure(error); else failure('errors.load'); }
