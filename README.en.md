# Anas RDP Plugin

[简体中文](README.md)

Use a Windows remote desktop in an Anas sidebar or separate window. A pinned native IronRDP engine owns the connection and framebuffer in the plugin backend; pages provide canvas display and keyboard/mouse input. No separate gateway is required.

Requires **Anas 3.3.12 or later** (plugin API 2) for window fitting, package-provided toolbar icons, and backend view activity subscriptions. Upgrade the host before installing the plugin.

Moving rebuilds the presentation while retaining the original connection and unsaved input. Run in background is off by default in the profile editor: closing the desktop ends its connection. When enabled, the connection survives closing the desktop, with Resume desktop and Disconnect available in the list. The context menu can start or resume in the sidebar or a window; successful openings and moves remember the position for later background-session recovery. Connection pages and profile editing are mutually exclusive. Background connections block editing and deletion. Disconnect, stopping the plugin backend, or quitting the host ends the connection.

Each server supports a fixed resolution: 1024×768, 1280×800, 1600×900, 1920×1080, 2560×1440, or custom dimensions, defaulting to 1280×800. Changes apply to the next new connection. Resizing a window, moving a page, or resuming a background desktop keeps the existing resolution. Separate windows initially fit the actual desktop. Display scale never exceeds 100% (one remote pixel per CSS pixel): smaller windows scale down proportionally, and larger windows center the desktop without enlarging it. Fit window to desktop in the titlebar resizes the window again, leaving maximized or fullscreen mode when needed. If the desktop exceeds the current screen work area, it scales down to remain fully visible. The sidebar continues to scale to fit.

Clipboard support is off by default for each server; enabling it reveals the clipboard toggle. Each new connection starts with sharing off. Connections can enable sharing independently, and moving or retaining a desktop in the background preserves its switch. Only the active desktop synchronizes new content: a separate window must be foreground; a sidebar desktop must be selected and its tab, content or toolbar must be the current interaction region. Clicking the chat area, hiding the sidebar or switching tabs pauses synchronization; hovering does not activate it. Inactive connections retain published copies for pasting and finish existing file transfers. A newly active connection takes over new synchronization without disabling the other switches. Manually disabling sharing still waits for file transfers to finish and does not retract copied text. Tooltips indicate syncing, waiting for activation or finishing a transfer.

Windows supports bidirectional file and folder copy/paste: copying exchanges metadata, and pasting reads file contents on demand. Remote files are not downloaded in advance, and source files are never moved or deleted. Intel macOS tests cover bidirectional text, local-folder uploads, active-connection switching, and transfer cancellation/disconnection. An upload may remain busy for about a minute after cancellation. Direct remote-file paste into Finder remains deferred; Windows multi-connection switching and local Explorer paste/cancel still need verification. Images and rich text are not supported.

## Use

Install the ZIP or select `PLUGIN.json` in the complete directory in Anas Settings → Plugins. Add a server from the top plugin menu and select its opening location. Double-click a row or select Start to connect. Profile editing and connection pages are separate: saving never connects, and connecting never implicitly saves a profile. See the bundled [user guide](docs/USER_GUIDE.md) for installation, password protection, certificates, and languages.

Supports 200 saved profiles and four concurrent connections. Basic keyboard/mouse input is provided. Local IME composition is not yet supported; remote IME and complex-shortcut behavior depends on the target application. Audio and multiple displays are not provided.

The plugin provides connection, profile management (create, read, update, delete), mouse and keyboard control, session listing, background screenshots, desktop display and disconnect tools. Select the tools in Anas capability settings. Screenshots return PNG images directly and work with surviving connections after their desktop page closes. Connections use saved passwords and existing certificate trust. The plugin manages connections independently of conversations. `connect` creates a background connection; `show_desktop` displays it. Run in background determines whether closing the desktop retains the connection. Input supports Unicode `text`, named keys, chords, and inter-action delays. One `input.actions` sequence can enter text then press Enter or Ctrl+Enter; sequences are validated and sent as requested. Raw down/up events can span calls; the plugin neither tracks nor automatically clears tool-held input. Text uses paced small batches; input lasting more than 10 seconds can continue in the background. An input deadline stops only the remaining steps, not the connection or plugin backend.

The Reset keyboard button and `reset_keyboard(session_id)` tool share one implementation: RDP Synchronize with toggle flags 0 releases ordinary keys and modifiers and turns off Caps Lock, Num Lock, Scroll Lock and Kana Lock. It runs only on explicit invocation, never on tool or conversation completion. It interrupts any pending tool input sequence on that connection (the original call returns `RDP_INPUT_RESET`) without changing the connection or local input lock.

The desktop toolbar and separate window titlebar provide Lock local input. When selected, local keyboard, mouse and wheel input are blocked while display and model tools remain available; unlocking, disconnecting and closing remain available. Models use `set_ui_locked(session_id, locked)`; `connect` and `list_sessions` return `ui_locked`. The lock belongs to the live connection and survives moves, background recovery and conversation completion. New connections start unlocked; it is not saved in configuration. Models explicitly unlock after continuous work, and users can unlock manually at any time. The lock does not exclude other tool callers, and manual unlocking does not stop an executing tool.

Windows x64 tests cover model connection, queries, screenshots, disconnection, keyboard/mouse input, page handoff, desktop display, and connection reuse across turns. macOS x64 tests cover the new tool input APIs, local input locking, page handoff, background recovery, cross-turn connection reuse, server-list focus, and shutdown cleanup. Exact Unicode tool input content has also been verified on the remote desktop. See [testing notes](docs/TESTING.md).

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
