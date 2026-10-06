const childProcess = require('node:child_process');
const path = require('node:path');
const original = childProcess.spawn;
let helperPid;
childProcess.spawn = (...args) => { const child = original(...args); helperPid = child.pid; return child; };
const directory = process.argv[2];
const backend = require(path.join(directory, 'backend.cjs'));
backend.activate({ pluginId: 'rdp', packageDirectory: directory, dataDirectory: directory });
backend.call('create', { owner: 'fixture', host: 'test.invalid', port: 3389 }).then(() => process.send({ ready: true, pid: helperPid }));
