# Anas RDP v0.1.9

## 简体中文

需要 **Anas 3.3.13 或更新版本**（插件 API 2）。请先升级 Anas，再安装此插件。

- 工具统一为 list、profile、control、screenshot、input，使用稳定的 profile_id 定位；旧工具名及参数不再使用。已有定制能力选择请核对新工具列表。
- 关闭桌面保留后台连接，主动断开同时关闭桌面，异常断开保留重连入口；打开及移动桌面不再改写保存的位置偏好。完善剪贴板通道就绪判断。
- 显示远程光标，支持可关闭的本地鼠标动画；截图可保存为临时 PNG，重置输入同时释放键盘及鼠标按钮。
- 分辨率菜单提供配置默认项和独立的窗口／侧栏自适应偏好；修复窗口尺寸取整、跨屏移动、全屏恢复及首次显示，缩小桌面但不放大。
- 新增支持本机输入法的文本弹窗，多行内容分批发送并显示进度，取消或失败保留未完成内容，不自动重发。

下载 `anas-rdp-0.1.9-universal.zip`，从 Anas「设置 → 插件」安装。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

仍为预览版。本轮窗口、文本弹窗交互和 TCP 断网清理已在 Windows x64 实测；macOS 本轮改动、显示器物理拔插／重排及 Windows 多连接剪贴板、Explorer 粘贴／取消未完成实机复测。Apple Silicon 未实测，Finder 按需粘贴未实现，macOS 程序未公证。完整验证范围及依赖告警见[测试说明](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md)。

## English

Requires **Anas 3.3.13 or later** (plugin API 2). Upgrade Anas before installing this plugin.

- Consolidate tools into list, profile, control, screenshot and input, addressed by stable profile_id values. Previous tool names and parameters are removed; review custom capability selections against the new list.
- Closing a desktop keeps its connection in the background. Explicit disconnect also closes the desktop; unexpected disconnects keep reconnect controls. Opening or moving a desktop no longer changes saved placement preferences. Improve clipboard-channel readiness checks.
- Display the remote cursor with optional local movement animation. Screenshots can be saved as temporary PNG files, and input reset releases both keyboard and mouse buttons.
- Add configured defaults and separate window/sidebar adaptive preferences to the resolution menu. Fix window-size rounding, cross-display moves, fullscreen restoration and initial display; scale desktops down without enlarging them.
- Add a local-IME text dialog with multiline editing, paced batches and progress. Cancellation or failure retains unfinished input without automatic replay.

Install `anas-rdp-0.1.9-universal.zip` from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

This remains a preview. Current window behavior, text-dialog interactions and TCP-disconnection cleanup were tested on Windows x64. Current macOS changes, physical display unplugging/reordering, Windows multi-connection clipboard behavior and Explorer paste/cancel have not completed hardware retesting. Apple Silicon has not been tested on hardware; on-demand Finder paste is not implemented, and macOS builds are not notarized. See [testing notes](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md) for full validation scope and dependency advisories.
