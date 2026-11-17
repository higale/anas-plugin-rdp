# Anas RDP v0.1.15

## 简体中文

需要 **Anas 5.2.12 或更新版本**（插件 API 2）。

- 在「输入文本」右侧新增「使用本地输入法」开关，默认关闭，按服务器保存选择；支持侧栏、独立窗口及页面交接。
- 本机组词、选字后发送 Unicode，文字与后续按键／点击按序处理；候选框定位在最近点击处。保留远程输入模式和原有多行输入弹窗。
- 修复取消组词的 Esc 可能传给宿主的问题；锁定、失焦和页面交接时取消未确认组合，避免迟到文字进入新页面。
- 使用优化的圆角方框「中」字图标，适配明暗主题，提示统一为「使用本地输入法」。

从 Anas「设置 → 插件」覆盖安装 `anas-rdp-0.1.15-universal.zip`。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

本插件仍为预览版，macOS 程序未公证。本轮已验证 Windows Electron 的浏览器组合事件、窗口交接和图标；系统输入法候选窗口、macOS 输入法及新模式在真实远端应用中的效果仍需实测。候选框不会跟随远端文本光标；不接受 Unicode 输入的应用可切回远程模式。更多范围见[测试说明](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md)。

## English

Requires **Anas 5.2.12 or later** (plugin API 2).

- Add “Use local input method” beside “Input text”, off by default and saved per server, with sidebar, window and page-handoff support.
- Send locally committed Unicode before subsequent keys and clicks. Candidates are anchored near the last click. Remote input mode and the existing multiline input dialog remain available.
- Prevent composition-cancelling Escape from reaching host shortcuts. Discard uncommitted composition on locking, focus loss and page handoff so late text cannot enter a replacement page.
- Use a refined rounded-square “中” icon for light and dark themes with the consistent “Use local input method” tooltip.

Install `anas-rdp-0.1.15-universal.zip` over the existing plugin from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs and Intel Macs; see `SHA256SUMS.txt` for checksums.

This remains a preview, and macOS builds are not notarized. Windows Electron browser composition events, page handoff and icons were checked. OS candidate windows, macOS IMEs and the new mode in real remote applications still need live validation. Candidates do not track the remote text caret; switch back to remote mode for applications that do not accept Unicode. See [testing notes](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md) for other limits.
