import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
assert.ok(['win32', 'darwin'].includes(process.platform), 'Windows/macOS clipboard interoperability test');
let probeName;
if (process.platform === 'win32') {
    execFileSync('cargo', ['test', '--manifest-path', 'native/Cargo.toml', '--test', 'clipboard_interop', '--no-run', '--quiet'], { stdio: 'inherit' });
    probeName = (await readdir('native/target/debug/deps')).find(name => /^clipboard_interop-.*\.exe$/.test(name));
    assert.ok(probeName, 'Native clipboard probe built');
}
const root = process.cwd();
const require = createRequire(resolve(root, '../Anas/package.json'));
const { _electron: electron } = require('playwright');
const config = JSON.parse(await readFile('.local/rdp-test.json', 'utf8'));
let pin;
try {
    const trust = JSON.parse(await readFile('.local/rdp-trust.json', 'utf8'));
    if (trust.target_key === createHash('sha256').update(JSON.stringify([config.host, config.port ?? 3389])).digest('hex'))
        pin = trust.certificate_sha256;
}
catch { }
if (!pin) {
    const state = JSON.parse(await readFile(join(homedir(), '.galeAnas/plugins_data/rdp/profiles.json'), 'utf8'));
    pin = state.certificate_trust.find(t => t.host === config.host && t.port === (config.port ?? 3389))?.sha256;
}
assert.ok(pin, 'Previously verified certificate required');
const fileMiB = Number(process.env.RDP_TEST_FILE_MIB ?? 3);
assert.ok(Number.isInteger(fileMiB) && fileMiB >= 1 && fileMiB <= 128, 'Test file size must be 1–128 MiB');
const testId = randomUUID(), dir = resolve('tmp/clipboard-proof', testId);
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'main.cjs'), "const {app}=require('electron'); app.whenReady().then(()=>{setInterval(()=>{},1000);});");
const app = await electron.launch({ executablePath: require('electron'), args: [join(dir, 'main.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
let savedText = await app.evaluate(({ clipboard }) => clipboard.readText());
const clip = { write: text => app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text), read: () => app.evaluate(({ clipboard }) => clipboard.readText()) };
const helper = spawn(resolve('dist/native', process.platform + '-' + process.arch, 'anas-rdp-session' + (process.platform === 'win32' ? '.exe' : '')), ['--session'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
helper.stderr.on('data', data => console.log(data.toString().trim()));
helper.stdin.on('error', () => { });
const pending = new Map();
let state = 'starting';
let clipboardState = 'disabled', drainedWhilePaused = false;
let ended = false;
helper.on('close', () => { ended = true; for (const p of pending.values())
    p.reject(new Error('helper closed')); pending.clear(); });
createInterface({ input: helper.stdout }).on('line', line => { const m = JSON.parse(line); if (m.status)
    state = m.status;
if (m.clipboardState) { clipboardState = m.clipboardState; if (clipboardState === 'draining') drainedWhilePaused = true; }
if (m.request) {
    const p = pending.get(m.request);
    if (p) {
        pending.delete(m.request);
        m.error ? p.reject(Error(m.error)) : p.resolve(m.result);
    }
} });
function command(method, fields = {}) { return new Promise((resolve, reject) => { const request = randomUUID(); let timer = setTimeout(() => { pending.delete(request); reject(Error('test command deadline ' + method)); }, 30000); pending.set(request, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } }); helper.stdin.write(JSON.stringify({ request, method, ...fields }) + '\n'); }); }
async function until(predicate, label, limit = 30000) { const end = Date.now() + limit; while (!await predicate()) {
    assert.ok(!ended, 'helper stopped');
    assert.ok(Date.now() < end, label);
    await new Promise(r => setTimeout(r, 100));
} }
const input = actions => command('input', { actions, interval_ms: 80 });
async function remote(script) { const encoded = Buffer.from(script, 'utf16le').toString('base64'); await input([{ type: 'hotkey', keys: ['WIN', 'R'] }]); await new Promise(r => setTimeout(r, 250)); await input([{ type: 'text', text: 'cmd.exe' }, { type: 'press', key: 'ENTER' }]); await new Promise(r => setTimeout(r, 500)); await input([{ type: 'text', text: 'powershell.exe -NoProfile -STA -WindowStyle Hidden -EncodedCommand ' + encoded + ' & exit' }, { type: 'press', key: 'ENTER' }]); }
const psQuote = s => "'" + s.replaceAll("'", "''") + "'";
async function localShell(script) { await new Promise((resolve, reject) => { const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' }); p.on('close', code => code === 0 ? resolve() : reject(Error('Local clipboard helper failed ' + code))); }); }
const token = randomBytes(32).toString('hex');
let result = [];
try {
    helper.stdin.write(JSON.stringify({ host: config.host, port: config.port ?? 3389, username: config.username, password: config.password, domain: config.domain ?? '', trusted_sha256: pin, token, origin: 'http://127.0.0.1', clipboard_support: true }) + '\n');
    await until(() => state === 'connected', 'connect', 40000);
    await until(async () => { try {
        await command('screenshot');
        return true;
    }
    catch {
        return false;
    } }, 'first frame');
    const local = 'local ' + testId + ' 你好 🐟\r\nsecond line';
    await clip.write(local);
    await until(async () => { try {
        await command('setClipboardEnabled', { enabled: true });
        return true;
    }
    catch (e) {
        if (e.message !== 'RDP_CLIPBOARD_UNAVAILABLE')
            throw e;
        return false;
    } }, 'clipboard negotiation');
    await command('setClipboardActivity', { active: true, publish: true });
    await new Promise(r => setTimeout(r, 700));
    await input([{ type: 'hotkey', keys: ['WIN', 'R'] }]);
    await new Promise(r => setTimeout(r, 600));
    await input([{ type: 'text', text: `powershell -NoProfile -STA -WindowStyle Hidden -Command "Set-Clipboard ('echo:'+(Get-Clipboard -Raw))"` }, { type: 'press', key: 'ENTER' }]);
    await until(async () => await clip.read() === 'echo:' + local, 'bidirectional unicode clipboard');
    result.push('bidirectional unicode text');
    await command('setClipboardEnabled', { enabled: false });
    await remote("Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::SetText('off:'+" + psQuote(testId) + ')');
    await new Promise(r => setTimeout(r, 5000));
    assert.equal(await clip.read(), 'echo:' + local);
    result.push('disabled isolation');
    await command('setClipboardEnabled', { enabled: true });
    console.log('Clipboard text roundtrip and isolation passed; checking files.');
    const folder = 'clipboard-' + testId;
    const source = join(dir, folder);
    await mkdir(join(source, '子目录'), { recursive: true });
    await writeFile(join(source, '子目录', '空文件.txt'), '');
    const smallText = 'Anas 🐟\r\n你好';
    await writeFile(join(source, '子目录', '你好.txt'), smallText);
    const filename = 'clipboard-' + testId + '.bin';
    const data = randomBytes(fileMiB * 1024 * 1024);
    await writeFile(join(source, filename), data);
    const sha = createHash('sha256').update(data).digest('hex').toUpperCase();
    const smallSha = createHash('sha256').update(smallText).digest('hex').toUpperCase();
    const expectedReceipt = 'sha:' + sha + ':' + smallSha + ':0';
    if (process.platform === 'win32') await localShell('Set-Clipboard -Path ' + psQuote(source));
    else await app.evaluate(({ clipboard }, url) => clipboard.writeBuffer('public.file-url', Buffer.from(url)), pathToFileURL(source).href);
    await new Promise(r => setTimeout(r, 700));
    // Paste into remote Explorer without introducing another file-transfer protocol.
    const remoteDir = "$env:TEMP+'\\anas-clipboard-" + testId + "'";
    await remote(`
      Add-Type -AssemblyName System.Windows.Forms
      $d=${remoteDir}; New-Item -ItemType Directory -Force -Path $d | Out-Null
      $f=Join-Path $d ${psQuote(folder + "\\" + filename)}
      $small=Join-Path $d ${psQuote(folder + "\\子目录\\你好.txt")}
      $empty=Join-Path $d ${psQuote(folder + "\\子目录\\空文件.txt")}
      $end=[DateTime]::UtcNow.AddSeconds(180); $receipt='upload-failed'
      do {
        try {
          if ((Get-Item -LiteralPath $f -ErrorAction Stop).Length -ne ${data.length}) { throw 'Incomplete binary' }
          if ((Get-Item -LiteralPath $small -ErrorAction Stop).Length -ne ${Buffer.byteLength(smallText)}) { throw 'Incomplete text' }
          $emptySize=(Get-Item -LiteralPath $empty -ErrorAction Stop).Length
          $receipt='sha:'+(Get-FileHash -LiteralPath $f -ErrorAction Stop).Hash+':'+(Get-FileHash -LiteralPath $small -ErrorAction Stop).Hash+':'+$emptySize
          break
        } catch { Start-Sleep -Milliseconds 200 }
      } until ([DateTime]::UtcNow -gt $end)
      [Windows.Forms.Clipboard]::SetText($receipt)
    `);
    await new Promise(r => setTimeout(r, 2000));
    await input([{ type: 'hotkey', keys: ['WIN', 'R'] }]);
    await new Promise(r => setTimeout(r, 500));
    await input([{ type: 'text', text: '%TEMP%\\anas-clipboard-' + testId }, { type: 'press', key: 'ENTER' }]);
    await new Promise(r => setTimeout(r, 1000));
    await command('setClipboardActivity', { active: false, publish: true });
    await input([{ type: 'hotkey', keys: ['CTRL', 'V'] }]);
    await until(() => drainedWhilePaused && clipboardState === 'paused', 'published files remain readable and finish while paused', 190000);
    assert.notEqual(await clip.read(), expectedReceipt, 'Paused connections do not fetch a new remote copy');
    await command('setClipboardActivity', { active: true, publish: true });
    await until(async () => await clip.read() === expectedReceipt, 'all uploaded file contents', 190000);
    result.push(`Explorer upload while paused verified ${fileMiB} MiB SHA256, Unicode text bytes and empty file size`);
    await command('setClipboardEnabled', { enabled: false });
    await command('setClipboardEnabled', { enabled: true });
    result.push('upload unlock');
    if (process.platform === 'win32') {
        await remote("Add-Type -AssemblyName System.Windows.Forms; $d=" + remoteDir + "; $f=Join-Path $d " + psQuote(folder + "\\" + filename) + "; $list=New-Object System.Collections.Specialized.StringCollection; [void]$list.Add((Join-Path $d " + psQuote(folder) + ")); [Windows.Forms.Clipboard]::SetFileDropList($list)");
        await new Promise(r => setTimeout(r, 1000));
        const downloaded = join(dir, 'download');
        await mkdir(downloaded);
        // Do not render/read the remote file before Paste.
        await assert.rejects(stat(join(downloaded, folder, filename)));
        let busyCheck;
        await new Promise((resolveTest, reject) => {
            const probe = spawn(resolve('native/target/debug/deps', probeName), ['--ignored', '--nocapture'], { windowsHide: true, env: { ...process.env, ANAS_RDP_CLIPBOARD_TEST_DEST: downloaded }, stdio: ['ignore', 'pipe', 'pipe'] });
            let logs = '';
            probe.stdout.on('data', data => { logs += data; if (!busyCheck && logs.includes('paste-finishing'))
                busyCheck = assert.rejects(command('setClipboardEnabled', { enabled: false }), /RDP_CLIPBOARD_BUSY/); });
            probe.stderr.on('data', data => { logs += data; });
            probe.on('close', code => code === 0 ? resolveTest() : reject(Error('Clipboard interop ' + code + ' ' + logs)));
        });
        await busyCheck;
        result.push('busy switch protected');
        await until(async () => { try {
            return (await stat(join(downloaded, folder, filename))).size === data.length;
        }
        catch {
            return false;
        } }, 'download file', 100000);
        assert.equal(createHash('sha256').update(await readFile(join(downloaded, folder, filename))).digest('hex').toUpperCase(), sha);
        assert.equal(await readFile(join(downloaded, folder, '子目录', '你好.txt'), 'utf8'), 'Anas 🐟\r\n你好');
        assert.equal((await stat(join(downloaded, folder, '子目录', '空文件.txt'))).size, 0);
        result.push('Windows virtual-file folder paste verified SHA256, Unicode names and empty files');
        await command('setClipboardEnabled', { enabled: false });
        result.push('download unlock');
    } else {
        console.log('Finder download is not implemented; download and download-cancellation checks were not run.');
        await command('setClipboardEnabled', { enabled: false });
    }
    await remote("$d=[IO.Path]::GetFullPath(" + remoteDir + "); if([IO.Path]::GetDirectoryName($d) -ne [IO.Path]::GetFullPath($env:TEMP).TrimEnd(\'\\\')){throw \'Unexpected test directory\'}; Remove-Item -LiteralPath $d -Recurse -Force");
    await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
catch (e) {
    await writeFile(join(dir, 'clipboard.txt'), await clip.read());
    const shot = await command('screenshot').catch(() => null);
    if (shot)
        await writeFile(join(dir, 'failure.png'), Buffer.from(shot[1].data, 'base64'));
    console.log('proof directory', dir);
    console.error(e.message);
    console.log(JSON.stringify(result));
    process.exitCode = 1;
}
finally {
    helper.stdin.end();
    await until(() => ended, 'close').catch(() => { });
    await clip.write(savedText);
    await app.close();
}
