import { execFileSync } from 'node:child_process';
import { mkdirSync, cpSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const component = process.env.RDP_BUILD_COMPONENT ?? 'all';
if (!['all', 'web', 'native'].includes(component)) throw new Error('Invalid build component.');
const out = resolve(root, component === 'all' ? 'dist' : `artifacts/components/${component}`);
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a three-part plugin version.');
if (!['win32', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Build on a supported Windows/macOS architecture.');
const nativeTarget = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'win32' ? 'pc-windows-msvc' : 'apple-darwin'}`;
const rustInfo = execFileSync('rustc', ['-vV'], { cwd: resolve(root, 'native'), encoding: 'utf8' });
if (!rustInfo.split(/\r?\n/).includes(`host: ${nativeTarget}`)) throw new Error('Use a Rust toolchain matching the Node process architecture; cross builds are not verified.');
// Only these exact generated directories can be replaced.
if (!['dist', 'artifacts/components/web', 'artifacts/components/native'].some(path => out === resolve(root, path))) throw new Error('Invalid build directory.');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (component !== 'web') execFileSync('cargo', ['build', '--release', '--locked', '--target', nativeTarget], { cwd: resolve(root, 'native'), stdio: 'inherit', env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4' } });
execFileSync(process.execPath, [resolve(root, 'scripts/collect-licenses.mjs')], { cwd: root, stdio: 'inherit' });
if (component !== 'native') {
  const { build } = await import('esbuild');
  await build({ entryPoints: [resolve(root, 'src/backend.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: resolve(out, 'backend.cjs') });
  await build({ entryPoints: [resolve(root, 'src/ui/app.ts')], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: resolve(out, 'app.js') });
  // WASM resolves relative to the final bundled module.
  cpSync(resolve(root, 'artifacts/upstream/iron-remote-desktop-rdp/ironrdp_web_bg.wasm'), resolve(out, 'ironrdp_web_bg.wasm'));
  for (const name of ['index.html', 'style.css']) cpSync(resolve(root, 'src/ui', name), resolve(out, name));
  cpSync(resolve(root, 'third-party'), resolve(out, 'third-party'), { recursive: true });
  cpSync(resolve(root, 'docs/USER_GUIDE.md'), resolve(out, 'USER_GUIDE.md'));
  cpSync(resolve(root, 'lang'), resolve(out, 'lang'), { recursive: true });
  writeFileSync(resolve(out, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'rdp', name: 'Remote Desktop', lang: 'lang', home: { default_location: 'sidebar', locations: ['sidebar', 'window'] }, plugin_version: version, api_version: 1, platforms: component === 'web' ? ['win32', 'darwin'] : [process.platform], ui: 'index.html', backend: 'backend.cjs' }, null, 2) + '\n');
}
if (component !== 'web') {
  const binary = `anas-rdp-bridge${process.platform === 'win32' ? '.exe' : ''}`;
  mkdirSync(resolve(out, 'native', `${process.platform}-${process.arch}`), { recursive: true });
  cpSync(resolve(root, 'native/target', nativeTarget, 'release', binary), resolve(out, 'native', `${process.platform}-${process.arch}`, binary));
  if (process.platform === 'darwin') {
    const helper = resolve(out, 'native', `${process.platform}-${process.arch}`, binary);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', helper], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', helper], { stdio: 'inherit' });
  }
}
cpSync(resolve(root, 'artifacts/licenses'), resolve(out, 'third-party/dependencies'), { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(resolve(out, 'BUILD.json'), JSON.stringify({ version, component, plugin_commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')), platform: process.platform, architecture: process.arch, native_target: component === 'web' ? null : nativeTarget, node: process.version, rust: rustInfo.split(/\r?\n/)[0], host_dependency: '3.3.4', upstream: JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8')), locks_sha256: Object.fromEntries(['package-lock.json', 'native/Cargo.lock'].map(name => [name, createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex')])) }, null, 2) + '\n');
console.log(`Built ${component}: ${out}`);
