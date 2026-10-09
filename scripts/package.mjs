import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, process.env.RDP_PACKAGE_DIRECTORY ?? 'dist');
const build = JSON.parse(readFileSync(resolve(source, 'BUILD.json'), 'utf8'));
const universal = build.platform === 'universal';
const component = build.component ?? 'all';
assert.ok(['all', 'web', 'native'].includes(component));
if (!universal) {
  assert.equal(build.platform, process.platform);
  assert.equal(build.architecture, process.arch);
}
const version = component === 'native' ? build.version : JSON.parse(readFileSync(resolve(source, 'PLUGIN.json'), 'utf8')).plugin_version;
assert.match(version, /^\d+\.\d+\.\d+$/);
let topLevel = ['PLUGIN.json', 'BUILD.json', 'USER_GUIDE.md', 'app.js', 'backend.cjs', 'index.html', 'style.css', 'native', 'third-party', 'lang', 'assets'];
if (component === 'web') topLevel = topLevel.filter(name => name !== 'native');
if (component === 'native') topLevel = ['BUILD.json', 'native', 'third-party'];
assert.deepEqual(readdirSync(source).sort(), topLevel.sort(), 'Unexpected package content');
const files = [];
let entries = 0;
function inspect(directory, prefix = '') {
  for (const name of readdirSync(directory)) {
    assert.ok(++entries <= 10000, 'Too many package entries');
    const relative = prefix + name;
    const path = resolve(directory, name);
    const info = lstatSync(path);
    assert.ok(!info.isSymbolicLink(), 'Package must contain ordinary files');
    assert.ok(!['.local', '.git', 'node_modules', 'target'].includes(name));
    if (info.isDirectory()) inspect(path, relative + '/');
    else {
      assert.ok(info.isFile() && info.size <= 128 * 1024 * 1024);
      files.push({ path: relative, bytes: info.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
    }
  }
}
inspect(source);
const bytes = files.reduce((sum, item) => sum + item.bytes, 0);
assert.ok(files.length <= 10000 && bytes <= 512 * 1024 * 1024);
mkdirSync(resolve(root, 'artifacts'), { recursive: true });
const variant = universal ? 'universal' : component === 'web' ? 'web' : `${component === 'native' ? 'native-' : ''}${build.platform}-${build.architecture}`;
const archive = resolve(root, 'artifacts', `anas-rdp-${version}-${variant}.zip`);
// zip updates existing archives; rebuild this exact output to exclude stale entries.
if (existsSync(archive)) unlinkSync(archive);
// Enumerate the package roots: archiving '.' adds ./ entries that Explorer
// cannot expose and that Anas correctly rejects as non-canonical paths.
if (process.platform === 'win32') execFileSync('tar.exe', ['-a', '-c', '-f', archive, '-C', source, ...topLevel], { stdio: 'inherit' });
// File-system metadata must not become extra AppleDouble entries in the ZIP.
else if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noqtn', source, archive], { stdio: 'inherit' });
else if (process.platform === 'linux' && universal) execFileSync('zip', ['-q', '-r', archive, ...topLevel], { cwd: source, stdio: 'inherit' });
else throw new Error('Packaging is only supported on Windows and macOS.');
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${sha256}  ${archive.split(/[\\/]/).at(-1)}\n`);
writeFileSync(`${archive}.inventory.json`, JSON.stringify({ files, bytes, archive_sha256: sha256, build }, null, 2) + '\n');
console.log(`Packaged ${files.length} files (${bytes} bytes): ${archive}`);
