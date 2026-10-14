---
name: remote-desktop
description: Connect to a saved Windows RDP server, inspect its desktop, and perform mouse or keyboard actions. Use for remote desktop work, showing or moving a live desktop, or inspecting remote session state.
---

Use the available RDP tool mapping supplied by the host. Keep the profile ID, live session ID, and display location distinct.

1. Call `list` to inspect saved profiles, connection_state, session_id and actual view. Use the stable profile_id for `control`: foreground connects and shows a desktop; background connects and closes its desktop; closed stops the connection and closes any desktop, even one already disconnected. Use the stable profile_id for every tool targeting this server, including screenshot, input and control. session_id is informational and changes when reconnected. Screenshot/input and control without state require an existing connection; they never connect implicitly or redirect remaining input to a replacement connection. Profile editing still requires the current revision.
2. A missing saved password or certificate confirmation needs the user's plugin UI. Do not invent credentials, automatically accept a certificate, or repeatedly reconnect.
3. Capture the current session. Images use original desktop pixel coordinates, regardless of the local window's scale. Check dimensions again after changes. The metadata reports local frame, cursor and input observations; it does not prove remote application completion.
4. Before continuous desktop operations, use `control({profile_id, ui_locked: true})` to prevent local UI interference. Unlock when your sequence finishes, including when you abandon it after an error. If it was already locked, preserve that prior state. Users can always unlock manually; the lock does not exclude other tool callers and is not tied to conversations.
5. Send a short input sequence, then observe another screenshot to decide the next action. Never act indefinitely on old coordinates or blindly replay an input whose receipt was lost.
6. To show a desktop, request state foreground and check both connection_state and view. An optional location selects sidebar or window without changing the saved preference. Existing desktops are reused, including reconnection of disconnected pages. With no location, keep an existing desktop in place or use the saved preference for a new desktop. State background keeps the connection while closing the page.
7. Connections survive tool calls, conversations and closing desktop tabs/windows. Explicit Disconnect or state closed stops the connection and closes the desktop; unexpected disconnections retain the desktop for retry. A returned closed state can still have a view after a failure; inspect both. Do not close a connection merely because a conversation ends. Stopping the plugin ends its connections.

`control` accepts optional state, location, ui_locked and reset_input. Omission means no change. At least one operation is required; location requires state foreground, and state closed cannot combine with other settings. foreground means a visible desktop, not OS focus. To connect, show and lock in one call, use `{"profile_id":"<ID>","state":"foreground","location":"window","ui_locked":true}`. Order is connect, lock/unlock, reset, then presentation. Inspect `ok`, actual connection_state/view and `applied`; on failure check failed_step/error and never blindly repeat completed steps. A failed status read returns status_error rather than an invented snapshot. applied lists confirmed receipts; a missing receipt does not prove no effect. Reset receipts appear in applied.reset_input; acceptance is not remote completion.

When configuration tools are enabled, use `profile` with action get/add/update/delete. Get requires profile_id; add requires changes.host; update requires profile_id, latest revision and nonempty changes; delete requires profile_id and latest revision. list already includes current saved profiles and revisions. All profile fields use snake_case (profile_id, open_mode, has_password, desktop_width, etc.). Updates preserve unspecified fields and passwords; close the desktop and stop the connection before editing/deleting. No configuration call connects.

## Showing a screenshot

Use `screenshot({profile_id, save: true})` when the user should see the image in your reply. It still returns the image for inspection; successful saving adds an absolute `saved_path` to the metadata. Render it as `![Remote desktop](<ABSOLUTE_SAVED_PATH>)`, substituting the returned path (use forward slashes on Windows). If `save_error` is returned, do not invent a path or claim the file was saved. Files are temporary and may disappear during host cleanup; save only when needed for display or another file-based operation.

## Input

An input call takes 1–64 ordered actions and validates the entire sequence before dispatch. The plugin sends the requested events without maintaining or protecting held-key state, inserting releases, or resetting state between calls. Raw key and mouse-button down/up events are independent; a down can remain active across screenshots, later calls and page handoffs until an up or another actual input changes it. Named keys and scan codes use the remote keyboard layout; neither injects arbitrary Unicode text.

Check the tool result first. `RDP_INVALID_INPUT` means the whole sequence was rejected before dispatch; correct the reported input error. After acceptance, observe the remote application before diagnosing focus or deciding the next action.

- Text: `{"type":"text","text":"你好，Anas 🐟"}` sends Unicode characters unchanged, in batches of at most 8 Unicode characters, with 50 ms settling after each batch (including the last), without keyboard-layout translation. Each text action accepts 1–4096 Unicode characters; the complete actions JSON must fit 12000 UTF-8 bytes, including escaping. No trimming, newline conversion, appended Enter, clipboard fallback, or implicit modifier release. Support for Unicode and control characters depends on the remote application; use explicit press/hotkey actions for keyboard operations.
- Press one key: `{"type":"press","key":"ENTER"}`. Repeated presses are separate actions.
- Chord: `{"type":"hotkey","keys":["CTRL","A"]}`. Keys press together in array order and release in reverse order. Each press or chord holds for 50 ms. These actions always send their downs and ups, even for keys already held.
- Use uppercase names without separators: A–Z, 0–9, F1–F12, CTRL, SHIFT, ALT, WIN, ENTER, ESC, SPACE, TAB, BACKSPACE, LEFT/UP/RIGHT/DOWN, PAGEDOWN, PAGEUP, HOME, END, INSERT, DELETE, and uppercase browser KeyboardEvent.code names such as ALTRIGHT. To page down, use `{"type":"press","key":"PAGEDOWN"}`.
- Move: `{"type":"move","x":100,"y":120}`. If unsure where to click, first move without pressing a mouse button, then take a screenshot with `include_cursor: true` to check the pointer against the target. Adjust if needed and click after confirming the position. When coordinates are clear, click directly.
- Click: button down and button up at the observed coordinates; button is `left`, `right` or `middle`. Double click uses two down/up pairs.
- Drag: button down at the start, moves, then button up at the destination, in order.
- Scroll: `{"type":"wheel","x":100,"y":120,"delta":-120}`; positive is up, negative is down, allowed range −256…255 (nonzero).
- Raw key for precise sequences: `{"type":"key","code":29,"down":true}` uses Set 1 scan codes; `extended:true` represents an E0-prefixed key. Release main keys before modifiers.

Top-level `interval_ms` is the gap from one completed action to the next (0–1000 ms, default 50). A value of 0 removes that gap but retains the 50 ms hold within press/hotkey. A whole text counts as one action; its internal pacing remains enabled even when interval_ms is 0. The entire input call has a 300-second execution deadline. Long input can take more than 10 seconds; if Anas returns a background call ID, wait for that call and never resend the sequence. For double Alt with an 80 ms gap:

```json
{
  "profile_id": "<server profile ID>",
  "interval_ms": 80,
  "actions": [
    {"type": "press", "key": "ALT"},
    {"type": "press", "key": "ALT"}
  ]
}
```

To enter text then submit with Ctrl+Enter (use `press ENTER` instead when appropriate):

```json
{
  "profile_id": "<server profile ID>",
  "actions": [
    {"type": "text", "text": "你好，Anas 🐟"},
    {"type": "hotkey", "keys": ["CTRL", "ENTER"]}
  ]
}
```

To hold Ctrl across observations, send raw `{"type":"key","code":29,"down":true}`, capture, perform subsequent clicks or `press A`, capture again, and send `{"type":"key","code":29,"down":false}`. Use `press A` while holding Ctrl to retain that modifier. Calling `hotkey CTRL+A` instead sends its own Ctrl up and releases it. The same applies to manual input: neither source is protected from the other's events. Decide and send any needed recovery input explicitly; the plugin does not infer it from an error, a caller's lifetime, or conversation completion.

The receipt waits until every step is queued; this is not remote application success. Another input call on that session returns `RDP_INPUT_BUSY` before dispatch while a gesture is pending. After dispatch, caller cancellation lets the bounded sequence finish its requested events. Reaching the original execution deadline, a send failure or disconnection stops the remaining steps without invented releases, rollback, or reconnect; an error may follow partial dispatch. A deadline failure stops only that sequence; it does not stop the connection or plugin backend. Inspect current state after an error or lost receipt before sending more input. Calls do not claim exclusive control: when unlocked, UI input may interleave, and other tools may change the desktop between observations.

Use `control` with `{"profile_id":"<server profile ID>","reset_input":true}` when you explicitly decide to reset keyboard and mouse input. It sends RDP Synchronize with toggle flags 0: all ordinary keys and modifiers become released, and Caps Lock, Num Lock, Scroll Lock and Kana Lock turn off. It also releases left, middle and right mouse buttons at the last known pointer position. The same operation is available from the desktop toolbar. It interrupts an unfinished input sequence with `RDP_INPUT_RESET`; already sent events are not undone. It keeps the connection and local input lock unchanged. Observe a screenshot after acceptance; no reset happens automatically at the end of input or a conversation.

If the session ends, report it. A newly authenticated connection is a new session, not continued execution of the previous one.

## Clipboard

`profile` and `list` expose `clipboard_support`; profile add/update changes use the same field (optional, default false). It negotiates clipboard support on the next connection. Actual clipboard sharing starts off and is controlled by the desktop toolbar, independently of input tools and conversations. Do not enable it implicitly or describe `input` text as clipboard paste. Windows file copy/paste transfers contents only on paste and never removes the originals. macOS remote-file paste into Finder is not implemented.
