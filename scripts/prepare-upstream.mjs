import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { ironrdp } = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
const checkout = resolve(root, '.local/upstream/IronRDP');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

if (!existsSync(checkout)) {
  git('clone', '--depth', '1', '--filter=blob:none', ironrdp.repository, checkout);
}
if (git('-C', checkout, 'status', '--porcelain')) {
  throw new Error('Upstream checkout has local changes; preserve them before preparing it.');
}
if (git('-C', checkout, 'remote', 'get-url', 'origin') !== ironrdp.repository) {
  throw new Error('Upstream origin does not match the locked repository.');
}
if (git('-C', checkout, 'rev-parse', 'HEAD') !== ironrdp.revision) {
  git('-C', checkout, 'fetch', '--depth', '1', 'origin', ironrdp.revision);
  git('-C', checkout, 'checkout', '--detach', ironrdp.revision);
}
for (const name of ['LICENSE-MIT', 'LICENSE-APACHE']) {
  const upstream = readFileSync(resolve(checkout, name), 'utf8').replaceAll('\r\n', '\n');
  const retained = readFileSync(resolve(root, 'third-party/IronRDP', name), 'utf8');
  if (upstream !== retained) throw new Error(`Retained ${name} differs from locked upstream.`);
}
console.log(`IronRDP source verified: ${ironrdp.revision}`);
