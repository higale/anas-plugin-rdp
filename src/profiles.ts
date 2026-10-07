import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Profile, Target, Trust } from './profile-types';

type Cipher = { version: number; iv: string; ciphertext: string; tag: string };
type StoredProfile = Target & { id: string; revision: number; name: string; open_mode: Profile['openMode']; password?: Cipher };
type State = { version: number; profiles: StoredProfile[]; certificate_trust: Trust[] };
// Portable obfuscation by product choice, not a vault. Keep this versioned key
// for existing backups. Anyone with this code and the file can decrypt it.
const keyV1 = Buffer.from('839e564f135662ec2821e30f483cb751d8d91e20db6d5b20186f2d958c9f8724', 'hex');
const fail = (code = 'PROFILE_INVALID'): never => { throw new Error(code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) return fail();
  return value;
}
function target(value: Record<string, unknown>): Target {
  const host = string(value.host, 253).trim();
  const port = value.port ?? 3389;
  if (!host || /[\s/\\?#]/.test(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) return fail();
  return { host, port: Number(port), username: string(value.username ?? '', 256), domain: string(value.domain ?? '', 256) };
}
function mode(value: unknown): Profile['openMode'] {
  if (value !== undefined && value !== 'sidebar' && value !== 'window') return fail();
  return value ?? 'sidebar';
}
function encrypt(id: string, password: string): Cipher {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyV1, iv);
  cipher.setAAD(Buffer.from(`rdp-password:1:${id}`));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), ciphertext: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decrypt(profile: StoredProfile): string | null {
  const saved = profile.password;
  if (!saved) return null;
  try {
    if (saved.version !== 1 || typeof saved.iv !== 'string' || typeof saved.tag !== 'string' || typeof saved.ciphertext !== 'string') return fail('PASSWORD_UNREADABLE');
    const iv = Buffer.from(saved.iv, 'base64');
    const tag = Buffer.from(saved.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) return fail('PASSWORD_UNREADABLE');
    const cipher = createDecipheriv('aes-256-gcm', keyV1, iv);
    cipher.setAAD(Buffer.from(`rdp-password:1:${profile.id}`));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(Buffer.from(saved.ciphertext, 'base64')), cipher.final()]).toString('utf8');
  } catch { return fail('PASSWORD_UNREADABLE'); }
}
function publicProfile(profile: StoredProfile): Profile {
  const { password, open_mode, ...rest } = profile;
  return { ...rest, openMode: open_mode, hasPassword: password !== undefined };
}
function validTrust(value: unknown): value is Trust {
  if (!value || typeof value !== 'object') return false;
  const item = value as Trust;
  return typeof item.host === 'string' && item.host.length > 0 && item.host.length <= 253
    && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535
    && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256);
}

export class Profiles {
  private queue: Promise<unknown> = Promise.resolve();
  // Explicit Start clicks only. Never persist or replay these after restart/restore.
  private launches = new Map<string, { token: string; revision: number; expires: number }>();
  constructor(private readonly directory: string) {}

  call(method: string, params: unknown): Promise<unknown> {
    const next = this.queue.then(() => this.execute(method, object(params ?? {})));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<State> {
    let raw: string;
    try { raw = await readFile(join(this.directory, 'profiles.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('PROFILE_READ_FAILED');
      // Migrate the released single-connection format only when no new file exists.
      let values: Record<string, unknown> = {};
      try {
        const legacy = object(JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')));
        if (legacy.version !== 0) return fail();
        values = object(legacy.values);
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') return fail('PROFILE_READ_FAILED');
      }
      const state: State = { version: 0, profiles: [], certificate_trust: Array.isArray(values.certificate_trust) ? values.certificate_trust.filter(validTrust) : [] };
      if (values.connection) {
        const current = target(object(values.connection));
        state.profiles.push({ ...current, id: randomUUID(), revision: 1, name: current.host, open_mode: 'sidebar' });
      }
      await this.write(state);
      return state;
    }
    try {
      if (Buffer.byteLength(raw) > 1024 * 1024) return fail();
      const state = object(JSON.parse(raw));
      if (state.version !== 0 || !Array.isArray(state.profiles) || state.profiles.length > 200) return fail();
      const ids = new Set<string>();
      const profiles = state.profiles.map(value => {
        const row = object(value);
        const id = string(row.id, 80);
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) return fail();
        ids.add(id);
        const name = string(row.name, 120).trim();
        if (!name) return fail();
        if (row.password !== undefined) object(row.password);
        return { ...target(row), id, revision: Number(row.revision), name, open_mode: mode(row.open_mode), ...(row.password === undefined ? {} : { password: row.password as Cipher }) };
      });
      const trusts = state.certificate_trust ?? [];
      if (!Array.isArray(trusts) || !trusts.every(validTrust)) return fail();
      return { version: 0, profiles, certificate_trust: trusts };
    } catch { return fail('PROFILE_READ_FAILED'); }
  }

  private async write(state: State) {
    const json = JSON.stringify(state, null, 2) + '\n';
    if (Buffer.byteLength(json) > 1024 * 1024) return fail('PROFILE_LIMIT');
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `profiles-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, json, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, 'profiles.json'));
    } catch { return fail('PROFILE_WRITE_FAILED'); }
    finally { await unlink(temporary).catch(() => undefined); }
  }

  private async execute(method: string, input: Record<string, unknown>) {
    for (const [key, request] of this.launches) if (request.expires <= Date.now()) this.launches.delete(key);
    if (method === 'profiles.consumeLaunch' || method === 'profiles.cancelLaunch') {
      const key = `${string(input.id, 80)}:${mode(input.location)}`;
      const request = this.launches.get(key);
      if (!request) return null;
      if (method === 'profiles.cancelLaunch') {
        if (request.token === input.token) this.launches.delete(key);
        return null;
      }
      this.launches.delete(key);
      const state = await this.read();
      const profile = state.profiles.find(item => item.id === input.id);
      if (!profile) return fail('PROFILE_MISSING');
      if (profile.revision !== request.revision) return fail('PROFILE_CONFLICT');
      return publicProfile(profile);
    }
    const state = await this.read();
    if (method === 'profiles.list') return state.profiles.map(publicProfile);
    if (method === 'trusts.list') return state.certificate_trust;
    if (method === 'trusts.save') {
      if (!validTrust(input)) return fail();
      state.certificate_trust = [...state.certificate_trust.filter(item => item.host !== input.host || item.port !== input.port), { host: input.host, port: input.port, sha256: input.sha256 }];
      await this.write(state);
      return state.certificate_trust;
    }
    const previous = input.id === undefined ? undefined : state.profiles.find(item => item.id === input.id);
    if (input.id !== undefined && !previous) return fail('PROFILE_MISSING');
    if (previous && input.revision !== previous.revision) return fail('PROFILE_CONFLICT');
    if (method === 'profiles.launch') {
      if (!previous) return fail('PROFILE_MISSING');
      const token = randomUUID();
      this.launches.set(`${previous.id}:${previous.open_mode}`, { token, revision: previous.revision, expires: Date.now() + 30000 });
      return token;
    }
    if (method === 'profiles.move') {
      if (!previous) return fail('PROFILE_MISSING');
      if (input.direction !== -1 && input.direction !== 1) return fail();
      const index = state.profiles.indexOf(previous);
      const adjacent = index + input.direction;
      // Reject a stale neighbour instead of moving past an unintended server.
      if ((state.profiles[adjacent]?.id ?? null) !== input.neighborId) return fail('PROFILE_CONFLICT');
      if (adjacent >= 0 && adjacent < state.profiles.length) {
        [state.profiles[index], state.profiles[adjacent]] = [state.profiles[adjacent], previous];
        await this.write(state);
      }
      return state.profiles.map(publicProfile);
    }
    if (method === 'profiles.password') {
      if (!previous) return fail('PROFILE_MISSING');
      return decrypt(previous);
    }
    if (method === 'profiles.delete') {
      if (!previous) return fail('PROFILE_MISSING');
      state.profiles = state.profiles.filter(item => item.id !== previous.id);
      await this.write(state);
      return null;
    }
    if (method !== 'profiles.save' && method !== 'profiles.copy') return fail();
    if ((!previous || method === 'profiles.copy') && state.profiles.length >= 200) return fail('PROFILE_LIMIT');
    let next: StoredProfile;
    if (method === 'profiles.copy') {
      if (!previous) return fail('PROFILE_MISSING');
      const id = randomUUID();
      const password = decrypt(previous);
      const name = string(input.name, 120).trim();
      if (!name) return fail();
      next = { ...previous, id, revision: 1, name, password: password === null ? undefined : encrypt(id, password) };
    } else {
      const name = string(input.name, 120).trim();
      if (!name) return fail();
      next = { ...target(input), id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, name, open_mode: mode(input.openMode) };
      switch (input.passwordAction) {
        case 'keep': if (previous?.password) next.password = previous.password; break;
        case 'set': next.password = encrypt(next.id, string(input.password, 4096)); break;
        case 'remove': break;
        default: return fail();
      }
      if (previous && ['host', 'port', 'username', 'domain', 'name', 'open_mode'].every(key => previous[key as keyof StoredProfile] === next[key as keyof StoredProfile])
        && JSON.stringify(previous.password) === JSON.stringify(next.password)) return publicProfile(previous);
    }
    if (previous && method === 'profiles.save') state.profiles[state.profiles.indexOf(previous)] = next;
    else state.profiles.push(next);
    await this.write(state);
    return publicProfile(next);
  }
}
