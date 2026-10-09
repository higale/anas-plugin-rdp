import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { ironrdp } = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
const targets = { 'win32-x64': 'x86_64-pc-windows-msvc', 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin' };
if (!targets[`${process.platform}-${process.arch}`]) throw new Error('Build tools are supported on Windows x64 and macOS arm64/x64.');
execFileSync('rustup', ['toolchain', 'install', ironrdp.rustToolchain, '--profile', 'minimal', '--component', 'rustfmt,clippy'], { stdio: 'inherit' });
