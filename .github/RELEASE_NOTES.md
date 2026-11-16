# Anas RDP v0.1.12

## 简体中文

需要 **Anas 5.2.10 或更新版本**（插件 API 2）。本轮新增窗口上限接口依赖，请同时更新宿主与插件。

- 关闭独立窗口自适应时，允许手动缩小，放大上限跟随实际远端画面；开启自适应后解除上限及最大化／全屏限制。
- 保留缩小后的窗口尺寸，重新打开或在侧栏与窗口间移动时恢复；远端分辨率变化时更新上限，调整失败时恢复实际画面的限制。
- 配套宿主修复应用缩放、小画面及 macOS 自适应切换中的窗口约束问题。此次不改变已保存的连接配置或数据格式。

从 Anas「设置 → 插件」覆盖安装 `anas-rdp-0.1.12-universal.zip`。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

相关行为测试、类型检查、本机构建和包内自检通过。Windows Electron 使用模拟远端画面验证窗口上限、缩小、缩放、自适应切换和侧栏往返；用户反馈 macOS 上切换自适应已恢复正常。上述结果不代表完整的真实远端或跨平台验收。本插件仍为预览版，macOS 程序未公证；其余验证范围见[测试说明](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md)。

## English

Requires **Anas 5.2.10 or later** (plugin API 2). This update depends on the new window-size limit API; update both the host and the plugin.

- With separate-window adaptation disabled, allow manual shrinking and cap enlargement at the actual remote desktop size. Enabling adaptation removes the size limit and restores maximize/fullscreen support.
- Retain smaller window sizes across reopening and sidebar/window handoffs. Update limits when the remote resolution changes and restore the actual-frame limit after a failed resolution change.
- The matching host fixes window constraints during application zoom, with small desktops, and when toggling adaptation on macOS. Saved connection configuration and data formats are unchanged.

Install `anas-rdp-0.1.12-universal.zip` over the existing plugin from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

Relevant behavior tests, type checking, local builds, and package self-tests passed. Windows Electron checks used a synthetic remote display to verify size limits, shrinking, zoom, adaptation toggles, and sidebar handoffs. The user reported that adaptation toggles now work on macOS. These results do not constitute complete live remote or cross-platform acceptance. This remains a preview, and macOS builds are not notarized; see [testing notes](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md) for other validation limits.
