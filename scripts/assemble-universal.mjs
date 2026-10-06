import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
mkdirSync(resolve(root, '.local'), { recursive: true });
const stage = mkdtempSync(resolve(root, '.local/universal-'));
const output = resolve(stage, 'package');
mkdirSync(output);
const hash = data => createHash('sha256').update(data).digest('hex');
const builds = [];
const licenses = {};
for (const variant of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
  const archive = resolve(root, 'artifacts', `anas-rdp-${version}-${variant}.zip`);
  const inventory = JSON.parse(readFileSync(`${archive}.inventory.json`, 'utf8'));
  assert.equal(hash(readFileSync(archive)), inventory.archive_sha256);
  const destination = resolve(stage, variant);
  mkdirSync(destination);
  const entries = execFileSync(process.platform === 'linux' ? 'unzip' : 'tar', process.platform === 'linux' ? ['-Z1', archive] : ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).map(name => name.replace(/^\.\//, ''));
  for (const name of entries) assert.ok(!name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'));
  assert.deepEqual(entries.filter(name => name && !name.endsWith('/')).sort(), inventory.files.map(file => file.path).sort());
  execFileSync(process.platform === 'linux' ? 'unzip' : 'tar', process.platform === 'linux' ? ['-q', archive, '-d', destination] : ['-xf', archive, '-C', destination], { stdio: 'inherit' });
  for (const file of inventory.files) {
    const path = resolve(destination, file.path);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    assert.equal(hash(readFileSync(path)), file.sha256);
  }
  const manifest = JSON.parse(readFileSync(resolve(destination, 'PLUGIN.json'), 'utf8'));
  assert.equal(manifest.plugin_version, version);
  const build = inventory.build;
  assert.equal(`${build.platform}-${build.architecture}`, variant);
  assert.equal(build.dirty, false, 'Only clean source builds may be combined');
  if (builds.length) for (const key of ['plugin_commit', 'upstream', 'locks_sha256', 'host_dependency']) assert.deepEqual(build[key], builds[0][key], `Mismatched source: ${key}`);
  builds.push(build);
  if (variant === 'win32-x64') {
    // Web/WASM are platform-independent. Use the Windows-tested shared bundle.
    cpSync(destination, output, { recursive: true });
  } else cpSync(resolve(destination, 'native', variant), resolve(output, 'native', variant), { recursive: true });
  const notices = resolve(destination, 'third-party/dependencies');
  const incoming = JSON.parse(readFileSync(resolve(notices, 'inventory.json'), 'utf8'));
  for (const [key, value] of Object.entries(incoming)) {
    if (licenses[key]) assert.deepEqual(licenses[key], value, `Conflicting license metadata: ${key}`);
    licenses[key] = value;
    const target = resolve(output, 'third-party/dependencies', key);
    mkdirSync(target, { recursive: true });
    for (const file of readdirSync(resolve(notices, key))) {
      const bytes = readFileSync(resolve(notices, key, file));
      const path = resolve(target, file);
      if (existsSync(path)) assert.ok(bytes.equals(readFileSync(path)), `Conflicting notice: ${key}/${file}`);
      else cpSync(resolve(notices, key, file), path);
    }
  }
}
writeFileSync(resolve(output, 'third-party/dependencies/inventory.json'), JSON.stringify(Object.fromEntries(Object.entries(licenses).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');
const manifest = JSON.parse(readFileSync(resolve(output, 'PLUGIN.json'), 'utf8'));
manifest.platforms = ['win32', 'darwin'];
writeFileSync(resolve(output, 'PLUGIN.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(resolve(output, 'BUILD.json'), JSON.stringify({ platform: 'universal', architecture: 'multi', plugin_commit: builds[0].plugin_commit, dirty: false, shared_assets_from: 'win32-x64', host_dependency: builds[0].host_dependency, builds }, null, 2) + '\n');
execFileSync(process.execPath, [resolve(root, 'scripts/package.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, RDP_PACKAGE_DIRECTORY: output } });
