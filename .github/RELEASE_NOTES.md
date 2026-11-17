# Anas RDP v0.1.14

## 简体中文

需要 **Anas 5.2.12 或更新版本**（插件 API 2）。本次双光标修复依赖宿主新增的原生鼠标离开通知，请同时更新宿主和插件。

- 修复 macOS 鼠标移出并重新进入窗口后，本地箭头未隐藏、持续显示双光标的问题；独立窗口和侧栏共用修复。
- 重新进入画面时立即恢复光标位置和隐藏状态，并保留留白、输入锁定和页面交接的行为。
- 优化分辨率图标，将输入文本图标换为更清晰的文字符号，适配明暗主题。

从 Anas「设置 → 插件」覆盖安装 `anas-rdp-0.1.14-universal.zip`。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

本插件仍为预览版，macOS 程序未公证。此次 Windows 发布审核不代替 macOS 原生光标实机复测；验证方法见 `npm run test:cursor`，其他范围见[测试说明](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md)。

## English

Requires **Anas 5.2.12 or later** (plugin API 2). The double-cursor fix depends on the host's native pointer-exit notification; update both the host and plugin.

- Fix the local arrow remaining visible alongside the remote cursor after leaving and re-entering a window on macOS. The fix covers separate windows and the sidebar.
- Restore cursor position and visibility immediately on re-entry while preserving letterboxing, input locks and page handoff behavior.
- Refine the resolution icon and replace the text-input icon with a clearer text symbol, supporting light and dark themes.

Install `anas-rdp-0.1.14-universal.zip` over the existing plugin from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

This remains a preview, and macOS builds are not notarized. The Windows release review does not replace a native macOS cursor retest; use `npm run test:cursor` for that check and see [testing notes](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md) for other validation limits.
