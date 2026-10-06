import { init, Backend } from '../../artifacts/upstream/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js';
import '../../artifacts/upstream/iron-remote-desktop/iron-remote-desktop.js';
import type { UserInteraction, NewSessionInfo } from '../../artifacts/upstream/iron-remote-desktop/index';

declare global {
  interface Window {
    anas: {
      getInfo(): Promise<{ language: string; theme: string; fontSize: number }>;
      data: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
      backend: { call(method: string, params: unknown): Promise<unknown> };
    };
  }
}
type Target = { host: string; port: number; username: string; domain: string };
type Trust = { host: string; port: number; sha256: string };
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
let trusts: Trust[] = [];
let pendingTrust: Trust | undefined;
let connecting = false;
let connected = false;
let zh = true;
const message = (cn: string, en: string) => zh ? cn : en;
function status(cn: string, en: string) { element('status').textContent = message(cn, en); }
function failure(cn: string, en: string) { element('error').hidden = false; element('error').textContent = message(cn, en); }
function controls() {
  input('connect').disabled = connecting || connected;
  input('disconnect').disabled = !connecting && !connected;
  input('disconnect').textContent = connecting ? message('取消', 'Cancel') : message('断开', 'Disconnect');
  for (const id of ['host', 'port', 'username', 'domain', 'password']) input(id).disabled = connecting || connected;
  document.body.dataset.connected = String(connected);
}
function target(): Target { return { host: input('host').value.trim(), port: Number(input('port').value), username: input('username').value, domain: input('domain').value }; }
async function disconnect() {
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
  // IronRDP's input channel is already closed after session.run() ends.
  // A rejected graceful shutdown must not prevent transport or UI cleanup.
  try { oldUi?.shutdown(); } catch { /* The helper below owns transport cleanup. */ }
  oldDesktop?.remove();
  try {
    if (old) await window.anas.backend.call('disconnect', { owner, id: old.id });
  } catch {
    if (generation === mine) failure('连接进程清理失败，请停用插件。', 'Connection cleanup failed. Disable the plugin.');
  } finally {
    if (generation === mine) { status('已断开', 'Disconnected'); controls(); }
  }
}
async function makeDesktop(): Promise<UserInteraction> {
  const remote = document.createElement('iron-remote-desktop') as HTMLElement & { module: typeof Backend };
  remote.setAttribute('scale', 'fit');
  remote.setAttribute('verbose', 'false');
  const abort = new AbortController();
  desktopAbort = abort;
  const ready = new Promise<UserInteraction>((resolve, reject) => {
    const timer = setTimeout(() => { abort.abort(); }, 5000);
    abort.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Desktop initialization canceled or timed out.')); }, { once: true });
    remote.addEventListener('ready', event => { clearTimeout(timer); resolve((event as CustomEvent).detail.irgUserInteraction); }, { once: true, signal: abort.signal });
  });
  remote.module = Backend;
  desktop = remote;
  element('desktop').append(remote);
  return ready;
}
async function connect() {
  if (connecting || connected) return;
  const current = target();
  const password = input('password').value;
  const mine = ++generation;
  connecting = true;
  pendingTrust = undefined;
  element('trust').hidden = true;
  element('error').hidden = true;
  status('正在连接…', 'Connecting…');
  controls();
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    await window.anas.data.set('connection', current);
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
        if (state === 'streaming') status('正在认证…', 'Authenticating…');
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
    status('已连接', 'Connected');
    controls();
    try { await session.run(); }
    catch { if (generation === mine) failure('远程连接已中断。', 'The remote connection was interrupted.'); }
    if (generation === mine) await disconnect();
  } catch {
    if (generation !== mine) return;
    const info = bridge ? await window.anas.backend.call('status', { owner, id: bridge.id }).catch(() => null) as BridgeStatus | null : null;
    if (info?.state === 'certificate_required' && info.certificate) {
      pendingTrust = { host: current.host, port: current.port, sha256: info.certificate.sha256 };
      element('fingerprint').textContent = pendingTrust.sha256;
      element('trust-message').textContent = message(`请核对 ${current.host}:${current.port} 的证书 SHA-256。信任仅适用于此目标，指纹变化将再次提示。`, `Verify the certificate SHA-256 for ${current.host}:${current.port}. Trust applies only to this target; changes require confirmation.`);
      element('trust').hidden = false;
    } else failure('连接失败，请检查地址、账户和远程服务。', 'Connection failed. Check the address, credentials, and remote service.');
    await disconnect();
  } finally { clearInterval(poll); }
}

element('connection').addEventListener('submit', event => { event.preventDefault(); void connect(); });
element('disconnect').addEventListener('click', () => void disconnect());
element('accept-certificate').addEventListener('click', async () => {
  const current = target();
  if (!pendingTrust || pendingTrust.host !== current.host || pendingTrust.port !== current.port) return;
  trusts = trusts.filter(item => item.host !== current.host || item.port !== current.port);
  trusts.push(pendingTrust);
  await window.anas.data.set('certificate_trust', trusts);
  await connect();
});
window.addEventListener('pagehide', () => { try { ui?.shutdown(); } catch { /* Page teardown closes its WebSocket. */ } });

try {
  const info = await window.anas.getInfo();
  zh = !info.language.toLowerCase().startsWith('en');
  document.documentElement.lang = zh ? 'zh-CN' : 'en';
  document.documentElement.dataset.theme = info.theme;
  document.documentElement.style.fontSize = `${info.fontSize}px`;
  const labels = { host: ['地址', 'Address'], port: ['端口', 'Port'], username: ['用户名', 'Username'], domain: ['域（可选）', 'Domain (optional)'], password: ['密码', 'Password'] };
  for (const [key, [cn, en]] of Object.entries(labels)) document.querySelector(`[data-label=${key}]`)!.textContent = message(cn, en);
  element('title').textContent = message('远程桌面', 'Remote Desktop');
  element('connect').textContent = message('连接', 'Connect');
  element('accept-certificate').textContent = message('信任此证书并重试', 'Trust certificate and retry');
  element('hint').textContent = message('密码仅用于当前连接。每个页面拥有独立连接。', 'Passwords stay in memory. Each page owns a separate connection.');
  const saved = await window.anas.data.get('connection') as Partial<Target> | null;
  if (saved) for (const key of ['host', 'port', 'username', 'domain'] as const) if (saved[key] !== undefined) input(key).value = String(saved[key]);
  const savedTrust = await window.anas.data.get('certificate_trust');
  if (Array.isArray(savedTrust)) trusts = savedTrust.filter(item => typeof item.host === 'string' && Number.isInteger(item.port) && /^[a-f0-9]{64}$/.test(item.sha256));
  await init('OFF');
  status('未连接', 'Disconnected');
  controls();
} catch { failure('组件加载失败，请重新打开插件。', 'Component loading failed. Reopen the plugin.'); }
