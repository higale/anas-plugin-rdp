# Anas RDP Plugin

[简体中文](README.md)

Use a Windows remote desktop in an Anas sidebar or separate window. A pinned native IronRDP engine owns the connection and framebuffer in the plugin backend; pages provide canvas display and keyboard/mouse input. No separate gateway is required.

RDP 0.1.7 requires **Anas 3.3.8 or later** (plugin API 2). Upgrade the host before installing the plugin; older hosts do not support the new page handoff and specified-instance movement interfaces.

Moving rebuilds the presentation while retaining the original connection and unsaved input. Run in background is off by default in the profile editor: closing the desktop ends its connection. When enabled, the connection survives closing the desktop, with Resume desktop and Disconnect available in the list. The context menu can start or resume in the sidebar or a window; successful openings and moves remember the position for later background-session recovery. Connection pages and profile editing are mutually exclusive. Background connections block editing and deletion. Disconnect, stopping the plugin backend, or quitting the host ends the connection.

## Use

Install the ZIP or select `PLUGIN.json` in the complete directory in Anas Settings → Plugins. Add a server from the top plugin menu and select its opening location. Double-click a row or select Start to connect. Profile editing and connection pages are separate: saving never connects, and connecting never implicitly saves a profile. See the bundled [user guide](docs/USER_GUIDE.md) for installation, password protection, certificates, and languages.

Supports 200 saved profiles and four concurrent connections. Basic keyboard/mouse input is provided. Local IME composition is not yet supported; remote IMEs, complex shortcuts, high DPI, and extended operation need dedicated verification. Clipboard, audio, file transfer, and multiple displays are not provided.

Real Anas tests on Windows x64 cover repeated moves, background-session recovery, disconnection on desktop close by default, and connection retention when Run in background is enabled. The page-handoff architecture was previously tested on macOS x64; the background-running option and server-list selection have not yet been retested on macOS. Native Apple Silicon arm64 runtime acceptance remains outstanding.

## Development

Requires Node.js 24 and Rust 1.94.1. `upstream.lock.json` pins IronRDP; `native/Cargo.lock` locks native dependencies.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:ui
```

`dist/` is the installable local-platform directory. For distribution, run `npm run package` and `npm run verify:package`. CI builds shared UI and three native targets, combines a universal ZIP, and retains dependency licenses.

[Architecture](docs/DEVELOPMENT.md) · [Tests](docs/TESTING.md) · [Publishing](docs/SOURCE_PUBLISHING.md) · [Remaining work](TODO.md)
