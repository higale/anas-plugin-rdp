import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = resolve(root, '.local/upstream/IronRDP');
const { ironrdp } = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
function run(command, args, cwd = upstream, env = process.env) {
  if (command === 'npm.cmd') {
    args = [process.env.npm_execpath || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args];
    command = process.execPath;
  }
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });
}
run(process.execPath, [resolve(root, 'scripts/prepare-upstream.mjs')], root);
if (Number(process.versions.node.split('.')[0]) !== ironrdp.nodeMajor) throw new Error('Use Node.js 24.');
const wasmPack = process.env.WASM_PACK_PATH || 'wasm-pack';
const wasmPackVersion = execFileSync(wasmPack, ['--version'], { encoding: 'utf8' }).trim();
if (wasmPackVersion !== `wasm-pack ${ironrdp.wasmPack}`) throw new Error(`Use wasm-pack ${ironrdp.wasmPack}.`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packages = ['iron-remote-desktop', 'iron-remote-desktop-rdp'];
for (const name of packages) run(npm, ['ci', '--ignore-scripts'], resolve(upstream, 'web-client', name));

run(wasmPack, ['build', '--target', 'web', '--release', '--no-opt', '--locked'], resolve(upstream, 'crates/ironrdp-web'), {
  ...process.env, RUSTUP_TOOLCHAIN: ironrdp.rustToolchain,
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4',
});
// Keep WASM external: Anas CSP permits package URLs, not fetch(data:...).
const glue = resolve(upstream, 'crates/ironrdp-web/pkg/ironrdp_web.js');
const original = readFileSync(glue, 'utf8');
const loader = "new URL('ironrdp_web_bg.wasm', import.meta.url)";
if (!original.includes(loader)) throw new Error('WASM loader changed; review the upstream build adapter.');
writeFileSync(glue, original.replace(loader, "new globalThis.URL('ironrdp_web_bg.wasm', import.meta.url)"));

for (const name of packages) {
  const cwd = resolve(upstream, 'web-client', name);
  run(npm, ['run', 'check'], cwd);
  run(npm, ['run', name === 'iron-remote-desktop' ? 'build' : 'build-alone'], cwd);
  run(npm, ['test'], cwd);
  const output = resolve(root, 'artifacts/upstream', name);
  mkdirSync(output, { recursive: true });
  cpSync(resolve(cwd, 'dist'), output, { recursive: true });
  if (name === 'iron-remote-desktop-rdp') cpSync(resolve(upstream, 'crates/ironrdp-web/pkg/ironrdp_web_bg.wasm'), resolve(output, 'ironrdp_web_bg.wasm'));
}
console.log('Verified upstream artifacts are available in artifacts/upstream.');
