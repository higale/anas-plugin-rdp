import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { host, port = 3389 } = JSON.parse(readFileSync(resolve(root, '.local/display-test.json'), 'utf8'));
const targetKey = createHash('sha256').update(JSON.stringify([host, port])).digest('hex');
const trustFile = resolve(root, '.local/display-trust.json');
let trustedSha256;
if (existsSync(trustFile)) {
  const trust = JSON.parse(readFileSync(trustFile, 'utf8'));
  if (trust.target_key === targetKey) trustedSha256 = trust.certificate_sha256;
}
const binary = resolve(root, `native/target/debug/anas-rdp-session${process.platform === 'win32' ? '.exe' : ''}`);
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', data => { output += data; });
child.stderr.resume();
const timer = setTimeout(() => child.kill(), 20_000);
try {
  child.stdin.end(JSON.stringify({ host, port, trusted_sha256: trustedSha256 }));
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) throw new Error('Probe failed before producing a result.');
  const result = JSON.parse(output);
  result.target_key = targetKey;
  writeFileSync(resolve(root, '.local/probe-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`RDP probe: ${result.status}. Details saved to .local/probe-result.json.`);
} finally { clearTimeout(timer); }
