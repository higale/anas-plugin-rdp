import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scope = process.env.RDP_BUILD_COMPONENT ?? 'all';
if (!['all', 'web', 'native'].includes(scope)) throw new Error('Invalid license scope.');
const output = resolve(root, 'artifacts/licenses');
// Only the generated notice directory is replaced; source notices stay in third-party.
if (output !== resolve(root, 'artifacts/licenses')) throw new Error('Invalid notice directory.');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const inventory = new Map();
function retain(ecosystem, item, directory, fallback) {
  const key = `${ecosystem}/${item.name.replaceAll('/', '_')}-${item.version}`;
  if (inventory.has(key)) return;
  let files = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /^(licen[sc]e|notice|copying|copyright)([-_.]|$)/i.test(entry.name)).map(entry => resolve(directory, entry.name));
  if (item.license_file) files.push(resolve(directory, item.license_file));
  if (!files.length && fallback) files = ['LICENSE-MIT', 'LICENSE-APACHE'].map(name => resolve(fallback, name));
  const supplement = resolve(root, 'third-party/license-supplements', `${item.name}-${item.version}`);
  if (!files.length && existsSync(supplement)) files = readdirSync(supplement).map(name => resolve(supplement, name));
  // These published npm packages carry their license declaration in README only.
  if (!files.length && ecosystem === 'npm' && ['is-reference', 'locate-character'].includes(item.name)) {
    files = [resolve(directory, 'README.md'), resolve(directory, 'package.json')];
  }
  const destination = resolve(output, key);
  mkdirSync(destination, { recursive: true });
  for (const path of new Set(files)) cpSync(path, resolve(destination, basename(path)));
  inventory.set(key, { name: item.name, version: item.version, license: item.license ?? null, repository: item.repository ?? null, notices: files.map(path => basename(path)) });
}
for (const [cwd, name, platform] of [
  [resolve(root, 'native'), 'anas-rdp-bridge', `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'win32' ? 'pc-windows-msvc' : 'apple-darwin'}`],
  [resolve(root, '.local/upstream/IronRDP'), 'ironrdp-web', 'wasm32-unknown-unknown'],
]) {
  if ((scope === 'web' && name !== 'ironrdp-web') || (scope === 'native' && name === 'ironrdp-web')) continue;
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', platform], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const packages = new Map(metadata.packages.map(item => [item.id, item]));
  const nodes = new Map(metadata.resolve.nodes.map(item => [item.id, item]));
  const entry = metadata.packages.find(item => item.name === name).id;
  const seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    const pkg = packages.get(id);
    if (id !== entry || name === 'ironrdp-web') {
      const directory = dirname(pkg.manifest_path);
      const fallback = directory.includes('IronRDP') || pkg.source?.includes('IronRDP') ? resolve(root, 'third-party/IronRDP') : undefined;
      retain('rust', pkg, directory, fallback);
    }
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dep.pkg);
  };
  visit(entry);
}
// Runtime libraries embedded by the upstream Web Component build.
const npmRoot = resolve(root, '.local/upstream/IronRDP/web-client/iron-remote-desktop/node_modules');
const visitNpm = (name, modules = npmRoot) => {
  const directory = resolve(modules, name);
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  const key = `npm/${pkg.name.replaceAll('/', '_')}-${pkg.version}`;
  if (inventory.has(key)) return;
  retain('npm', pkg, directory);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) if (existsSync(resolve(modules, dependency, 'package.json'))) visitNpm(dependency, modules);
};
if (scope !== 'native') {
  visitNpm('svelte');
  visitNpm('ua-parser-js');
  visitNpm('i18next', resolve(root, 'node_modules'));
}
const entries = [...inventory.entries()].sort(([a], [b]) => a.localeCompare(b));
writeFileSync(resolve(output, 'inventory.json'), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n');
const missing = entries.filter(([, item]) => !item.notices.length);
if (missing.length) throw new Error('License texts need review: ' + missing.map(([key]) => key).join(', '));
console.log(`Retained license notices for ${inventory.size} Rust and JavaScript dependencies.`);
