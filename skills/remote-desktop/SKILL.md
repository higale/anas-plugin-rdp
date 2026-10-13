---
name: remote-desktop
description: Connect to a saved Windows RDP server, inspect its desktop, and perform mouse or keyboard actions. Use for remote desktop work, showing or moving a live desktop, or inspecting remote session state.
---

Use the available RDP tool mapping supplied by the host. Keep the profile ID, live session ID, and display location distinct.

1. List profiles and sessions. Reuse an appropriate live session. To connect, use the profile's current revision; on a revision conflict, read the latest profile before deciding to retry.
2. A missing saved password or certificate confirmation needs the user's plugin UI. Do not invent credentials, automatically accept a certificate, or repeatedly reconnect.
3. Capture the current session. Images use original desktop pixel coordinates, regardless of the local window's scale. Check dimensions again after changes. The metadata reports local frame, cursor and input observations; it does not prove remote application completion.
4. Before continuous desktop operations, use `set_ui_locked(session_id, true)` to prevent local UI interference. Unlock when your sequence finishes, including when you abandon it after an error. If it was already locked, preserve that prior state. Users can always unlock manually; the lock does not exclude other tool callers and is not tied to conversations.
5. Send a short input sequence, then observe another screenshot to decide the next action. Never act indefinitely on old coordinates or blindly replay an input whose receipt was lost.
6. When the user asks to open or show a desktop, call `show_desktop` after connecting and check its returned `view`. A successful `connect` does not open a desktop; `profile.openMode` is only the saved location preference. Opening, focusing or moving the page preserves the same connection.
7. Connections belong to the plugin and survive tool calls and conversations. Reuse the live session ID in later calls. Disconnect only the intended session when finished with it or asked to disconnect. Closing a desktop disconnects it unless the profile enables background running; stopping the plugin also ends its connections.

## Input

An input call takes 1–64 ordered actions and validates the entire sequence before dispatch. The plugin sends the requested events without maintaining or protecting held-key state, inserting releases, or resetting state between calls. Raw key and mouse-button down/up events are independent; a down can remain active across screenshots, later calls and page handoffs until an up or another actual input changes it. Named keys and scan codes use the remote keyboard layout; neither injects arbitrary Unicode text.

Check the tool result first. `RDP_INVALID_INPUT` means the whole sequence was rejected before dispatch; correct the reported input error. After acceptance, observe the remote application before diagnosing focus or deciding the next action.

- Text: `{"type":"text","text":"你好，Anas 🐟"}` sends Unicode characters unchanged, in batches of at most 8 Unicode characters, with 50 ms settling after each batch (including the last), without keyboard-layout translation. Each text action accepts 1–4096 Unicode characters; the complete actions JSON must fit 12000 UTF-8 bytes, including escaping. No trimming, newline conversion, appended Enter, clipboard fallback, or implicit modifier release. Support for Unicode and control characters depends on the remote application; use explicit press/hotkey actions for keyboard operations.
- Press one key: `{"type":"press","key":"ENTER"}`. Repeated presses are separate actions.
- Chord: `{"type":"hotkey","keys":["CTRL","A"]}`. Keys press together in array order and release in reverse order. Each press or chord holds for 50 ms. These actions always send their downs and ups, even for keys already held.
- Use uppercase names without separators: A–Z, 0–9, F1–F12, CTRL, SHIFT, ALT, WIN, ENTER, ESC, SPACE, TAB, BACKSPACE, LEFT/UP/RIGHT/DOWN, PAGEDOWN, PAGEUP, HOME, END, INSERT, DELETE, and uppercase browser KeyboardEvent.code names such as ALTRIGHT. To page down, use `{"type":"press","key":"PAGEDOWN"}`.
- Move: `{"type":"move","x":100,"y":120}`.
- Click: button down and button up at the observed coordinates; button is `left`, `right` or `middle`. Double click uses two down/up pairs.
- Drag: button down at the start, moves, then button up at the destination, in order.
- Scroll: `{"type":"wheel","x":100,"y":120,"delta":-120}`; positive is up, negative is down, allowed range −256…255 (nonzero).
- Raw key for precise sequences: `{"type":"key","code":29,"down":true}` uses Set 1 scan codes; `extended:true` represents an E0-prefixed key. Release main keys before modifiers.

Top-level `interval_ms` is the gap from one completed action to the next (0–1000 ms, default 50). A value of 0 removes that gap but retains the 50 ms hold within press/hotkey. A whole text counts as one action; its internal pacing remains enabled even when interval_ms is 0. The entire input call has a 300-second execution deadline. Long input can take more than 10 seconds; if Anas returns a background call ID, wait for that call and never resend the sequence. For double Alt with an 80 ms gap:

```json
{
  "session_id": "<live session ID>",
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
  "session_id": "<live session ID>",
  "actions": [
    {"type": "text", "text": "你好，Anas 🐟"},
    {"type": "hotkey", "keys": ["CTRL", "ENTER"]}
  ]
}
```

To hold Ctrl across observations, send raw `{"type":"key","code":29,"down":true}`, capture, perform subsequent clicks or `press A`, capture again, and send `{"type":"key","code":29,"down":false}`. Use `press A` while holding Ctrl to retain that modifier. Calling `hotkey CTRL+A` instead sends its own Ctrl up and releases it. The same applies to manual input: neither source is protected from the other's events. Decide and send any needed recovery input explicitly; the plugin does not infer it from an error, a caller's lifetime, or conversation completion.

The receipt waits until every step is queued; this is not remote application success. Another input call on that session returns `RDP_INPUT_BUSY` before dispatch while a gesture is pending. After dispatch, caller cancellation lets the bounded sequence finish its requested events. Reaching the original execution deadline, a send failure or disconnection stops the remaining steps without invented releases, rollback, or reconnect; an error may follow partial dispatch. A deadline failure stops only that sequence; it does not stop the connection or plugin backend. Inspect current state after an error or lost receipt before sending more input. Calls do not claim exclusive control: when unlocked, UI input may interleave, and other tools may change the desktop between observations.

Use `reset_keyboard` with `{"session_id":"<live session ID>"}` when you explicitly decide to reset the keyboard. It sends RDP Synchronize with toggle flags 0: all ordinary keys and modifiers become released, and Caps Lock, Num Lock, Scroll Lock and Kana Lock turn off. The same operation is available from the desktop toolbar. It interrupts an unfinished input sequence with `RDP_INPUT_RESET`; already sent events are not undone. It keeps the connection and local input lock unchanged. Observe a screenshot after acceptance; no reset happens automatically at the end of input or a conversation.

If the session ends, report it. A newly authenticated connection is a new session, not continued execution of the previous one.

## Clipboard

Profiles expose `clipboardSupport`; add/update profile changes use `clipboard_support` (optional, default false). It negotiates clipboard support on the next connection. Actual clipboard sharing starts off and is controlled by the desktop toolbar, independently of input tools and conversations. Do not enable it implicitly or describe `input` text as clipboard paste. Windows file copy/paste transfers contents only on paste and never removes the originals. macOS remote-file paste into Finder is not implemented.
