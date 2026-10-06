# Anas RDP Plugin

[简体中文](README.md)

An optional Windows remote desktop plugin providing a real web desktop in an Anas side panel or separate window. It uses pinned IronRDP Web components, WASM, and a bundled native bridge, without a separately deployed gateway.

Windows x64 has passed authentication, rendering, basic keyboard input, and connection lifecycle checks inside Anas. CI covers native builds and universal package verification on Windows x64, Apple Silicon macOS, and Intel macOS; real macOS Anas/RDP interaction still awaits hardware acceptance testing. Chinese input and full keyboard/mouse compatibility need dedicated verification. Clipboard, audio, file transfer, multiple displays, active session transfer, and password storage are not provided.

## Usage

Requires Anas 3.3.2 or a development build containing commit `c2250c06` (plugin API 1, iframe form support).

Install the complete `dist/` folder from Anas Settings → Plugins, or extract a ZIP from [GitHub Releases](https://github.com/higale/anas-plugin-rdp/releases) first and select that folder. The universal ZIP works on Windows x64, Apple Silicon Macs, and Intel Macs from one directory. For certificates not trusted by the system, independently verify the SHA-256 before trusting that target. Passwords remain in memory and are excluded from ordinary settings and backups. See the [bilingual user guide](docs/USER_GUIDE.md). End users do not need Rust, Node, or build tools.

## Development

Builds require Node.js 24, Rust 1.94.1, the `wasm32-unknown-unknown` target, and wasm-pack 0.15.0. IronRDP source and versions are pinned in `upstream.lock.json`.

```powershell
npm ci
npm run prepare:upstream
npm run build:upstream
npm run typecheck
npm run test:ui
npm run build
npm test
npm run package
npm run verify:package
```

The upstream build also runs type checks and 137 tests. `dist/` is the installable directory; `artifacts/` contains ZIP archives, checksums, and file inventories. Local builds target one platform and CPU architecture; GitHub CI builds the shared Web/WASM and JavaScript once, builds native helpers on three platforms, and combines and verifies the universal package. Releases contain only the universal ZIP and `SHA256SUMS.txt`; component archives and file inventories stay in Actions. Dependency versions, licenses, and original notices are retained. The public repository uses independent source snapshots; see the [publishing workflow](docs/SOURCE_PUBLISHING.md).

Read [AGENTS.md](AGENTS.md), [architecture and host interfaces](docs/DEVELOPMENT.md), [testing notes](docs/TESTING.md), and the [task list](TODO.md). These developer documents are in Simplified Chinese. Anas source lives in the adjacent `../Anas` repository.

Real connection details belong in the ignored `.local/rdp-test.json`. Credentials, logs, screenshots, and test results are excluded from commits and packages. Run real connection tests separately.
