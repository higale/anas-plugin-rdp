import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only after the user has verified and explicitly accepted this fingerprint.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fingerprint = process.argv[2];
if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw new Error('Pass the verified SHA-256 fingerprint.');
const { host, port = 3389 } = JSON.parse(readFileSync(resolve(root, '.local/rdp-test.json'), 'utf8'));
const targetKey = createHash('sha256').update(JSON.stringify([host, port])).digest('hex');
const report = JSON.parse(readFileSync(resolve(root, '.local/probe-result.json'), 'utf8'));
if (report.target_key !== targetKey || report.certificate?.sha256 !== fingerprint) throw new Error('Fingerprint or target differs from the last probe. Probe again before accepting.');
writeFileSync(resolve(root, '.local/rdp-trust.json'), JSON.stringify({ target_key: targetKey, certificate_sha256: fingerprint }, null, 2) + '\n');
console.log('Certificate trust recorded for the current test target only.');
