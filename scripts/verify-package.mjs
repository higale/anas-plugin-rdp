import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const variant = process.env.RDP_PACKAGE_VARIANT === 'universal' ? 'universal' : `${process.platform}-${process.arch}`;
const archive = resolve(root, 'artifacts', `anas-rdp-${version}-${variant}.zip`);
const inventory = JSON.parse(readFileSync(`${archive}.inventory.json`, 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
assert.equal(hash(readFileSync(archive)), inventory.archive_sha256);
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
const entries = execFileSync(tar, ['-tf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/).map(name => name.replace(/^\.\//, ''));
for (const name of entries) assert.ok(!isAbsolute(name) && !name.includes('\\') && !name.split('/').includes('..'), 'Unsafe archive path');
assert.deepEqual(entries.filter(name => name && !name.endsWith('/')).sort(), inventory.files.map(file => file.path).sort());
mkdirSync(resolve(root, '.local'), { recursive: true });
const extracted = mkdtempSync(resolve(root, '.local/package-check-'));
execFileSync(tar, ['-xf', archive, '-C', extracted], { stdio: 'inherit' });
for (const file of inventory.files) {
  const path = resolve(extracted, file.path);
  const rel = relative(extracted, path);
  assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.size, file.bytes);
  assert.equal(hash(readFileSync(path)), file.sha256);
}
if (process.platform === 'darwin') {
  const helper = resolve(extracted, 'native', `${process.platform}-${process.arch}`, 'anas-rdp-bridge');
  assert.ok(lstatSync(helper).mode & 0o111, 'Native helper lost executable permissions');
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', helper], { stdio: 'inherit' });
}
const manifest = JSON.parse(readFileSync(resolve(extracted, 'PLUGIN.json'), 'utf8'));
assert.ok(manifest.platforms.includes(process.platform));
assert.equal(manifest.plugin_version, version);
await WebAssembly.compile(readFileSync(resolve(extracted, 'ironrdp_web_bg.wasm')));
execFileSync(process.execPath, ['--test', 'test/backend.test.mjs'], { cwd: root, stdio: 'inherit', env: { ...process.env, RDP_TEST_PACKAGE: extracted } });
console.log(`Verified ${inventory.files.length} archived files and native process lifecycle after extraction.`);
