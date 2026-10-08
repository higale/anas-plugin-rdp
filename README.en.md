# Anas RDP Plugin

[简体中文](README.md)

An optional Windows remote desktop plugin providing a real web desktop in an Anas side panel or separate window. It uses pinned IronRDP Web components, WASM, and a bundled native bridge, without a separately deployed gateway.

Windows x64 has passed authentication, rendering, basic keyboard input, and connection lifecycle checks inside Anas. CI covers native builds and universal package verification on Windows x64, Apple Silicon macOS, and Intel macOS; real macOS Anas/RDP interaction still awaits hardware acceptance testing. Chinese input and full keyboard/mouse compatibility need dedicated verification. Clipboard, audio, file transfer, and multiple displays are not provided.

## Usage

Requires **Anas 3.3.5 or later** (plugin API 1), including live window movement and titlebar actions.

For published versions, download the universal ZIP from [GitHub Releases](https://github.com/higale/anas-plugin-rdp/releases); the same package works on Windows x64, Apple Silicon Macs, and Intel Macs. Install from Anas Settings → Plugins: select the ZIP directly or select `PLUGIN.json` inside the complete extracted folder. Development builds use the complete `dist/` directory. For certificates not trusted by the system, independently verify the SHA-256 before trusting that target. Multiple profiles support sidebar or window placement and optional password storage. Saved passwords use AES-GCM with a built-in versioned key and restore across machines through Anas backups; anyone with the configuration and plugin code can decrypt them. Plugin names and UI use the same i18next JSON language-pack format as Anas, with English and Simplified Chinese included. Add or edit translations in the ZIP’s `lang/` directory and install; the plugin follows the host’s selected language. Only host language packs create selectable languages; plugin-only languages are ignored. Missing text falls back to English. Reinstallation uses only the new package’s translations. Language, theme, and font size follow the host without reconnecting. See [language-pack instructions](lang/README.md). See the [bilingual user guide](docs/USER_GUIDE.md). End users do not need Rust, Node, or build tools.

The home page opens a server list in the sidebar by default, retaining any saved location preference. The top `+ / − / ↑ / ↓` controls add, delete, and reorder servers; hovering or keyboard focus reveals Start and Edit. A separate form handles saving or canceling edits. Start opens the configured location and connects with a saved password, or prompts for one. Change “Home page opens in” by selecting RDP in Anas Settings → Plugins; the preference is saved in plugin configuration and used by the top menu on the next opening. Each server’s “Remote desktop opens in” setting is independent. Changing the home location does not close pages or interrupt connections.

Use the Anas header controls to move a connection page between the sidebar and a window while retaining the same page and connection. Changing an opening preference only affects future opens. Moving reports a conflict and preserves both pages if the destination already contains the same instance.

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
```

For daily changes, build `dist/` and install its `PLUGIN.json`. Run `npm run package` and `npm run verify:package` when publishing, distributing, or testing ZIP installation.

The upstream build also runs type checks and 137 tests. `dist/` is the installable directory; `artifacts/` contains ZIP archives, checksums, and file inventories. Local builds target one platform and CPU architecture; GitHub CI builds the shared Web/WASM and JavaScript once, builds native helpers on three platforms, and combines and verifies the universal package. Releases contain only the universal ZIP and `SHA256SUMS.txt`; component archives and file inventories stay in Actions. Dependency versions, licenses, and original notices are retained. The public repository uses independent source snapshots; see the [publishing workflow](docs/SOURCE_PUBLISHING.md).

Read [AGENTS.md](AGENTS.md), [architecture and host interfaces](docs/DEVELOPMENT.md), [testing notes](docs/TESTING.md), and the [task list](TODO.md). These developer documents are in Simplified Chinese. Anas source lives in the adjacent `../Anas` repository.

Real connection details belong in the ignored `.local/rdp-test.json`. Credentials, logs, screenshots, and test results are excluded from commits and packages. Run real connection tests separately.

Connection windows show status and a Disconnect/Cancel icon in the host titlebar, hiding the duplicate connection header. Moving back to the sidebar restores that header without reconnecting.
