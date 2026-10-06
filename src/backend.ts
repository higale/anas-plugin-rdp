import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type Context = { pluginId: string; packageDirectory: string; dataDirectory: string };
type Session = { owner: string; child: ChildProcessWithoutNullStreams; state: string; certificate?: { sha256: string; trusted: boolean }; exited: Promise<void>; closed: boolean };
let context: Context;
const sessions = new Map<string, Session>();

export function activate(value: Context) { context = value; }
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

export async function call(method: string, params: unknown) {
  const input = record(params);
  const owner = text(input.owner, 80);
  if (!owner) throw new Error('Missing page owner.');
  if (method === 'create') {
    for (const [id, session] of sessions) if (session.closed) sessions.delete(id);
    if (sessions.size >= 4) throw new Error('At most four connections can run at once.');
    const host = text(input.host, 253).trim();
    const port = input.port ?? 3389;
    const trustedSha256 = input.trustedSha256 == null ? undefined : text(input.trustedSha256, 64);
    if (!host || /[\s/\\?#]/.test(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535 || (trustedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(trustedSha256))) throw new Error('Invalid target or certificate fingerprint.');
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const binary = join(context.packageDirectory, 'native', `${process.platform}-${process.arch}`, `anas-rdp-bridge${process.platform === 'win32' ? '.exe' : ''}`);
    const child = spawn(binary, ['--serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const session: Session = { owner, child, state: 'starting', exited: Promise.resolve(), closed: false };
    session.exited = new Promise(resolve => child.once('close', () => { session.closed = true; if (!['connection_failed', 'certificate_required'].includes(session.state)) session.state = 'closed'; resolve(); }));
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
          // Preserve actionable failure after the final closed notification.
          if (event.status !== 'closed' || !['connection_failed', 'certificate_required'].includes(session.state)) session.state = event.status;
          if (event.certificate) session.certificate = event.certificate;
          if (event.status === 'ready') resolve(event.port);
        } catch { session.state = 'connection_failed'; child.kill(); }
      });
    });
    child.stdin.write(JSON.stringify({ host, port, trusted_sha256: trustedSha256, origin: `anas-plugin://${context.pluginId}`, token }) + '\n');
    try {
      const localPort = await ready;
      return { id, token, proxy: `ws://127.0.0.1:${localPort}/rdp` };
    } catch (error) { await stop(session); sessions.delete(id); throw error; }
    finally { clearTimeout(timer); }
  }
  const id = text(input.id, 80);
  const session = sessions.get(id);
  // A host backup or backend restart may have already reclaimed this session.
  if (!session && method === 'disconnect') return null;
  if (!session || session.owner !== owner) throw new Error('Connection does not belong to this page.');
  if (method === 'status') return { state: session.state, certificate: session.certificate ?? null };
  if (method === 'disconnect') { await stop(session); sessions.delete(id); return null; }
  throw new Error('Unknown RDP operation.');
}

export async function deactivate() {
  await Promise.all([...sessions.values()].map(stop));
  sessions.clear();
}
