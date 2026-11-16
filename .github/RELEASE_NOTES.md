# Anas RDP v0.1.13

## 简体中文

需要 **Anas 5.2.11 或更新版本**（插件 API 2）。本轮依赖宿主新增的最大化控制与窗口适配入口，请先更新宿主。

- Windows 独立窗口隐藏并禁用系统最大化，保留最小化和关闭；macOS 保留原生绿色按钮，自适应开启时可进入系统全屏。
- 窗口工具栏始终提供尺寸入口：自适应时进入／退出全屏，非自适应时通过不同图标恢复到允许的最大尺寸，并继续允许手动缩小。
- 移除与宿主重复的适配按钮；初次适配失败，以及自适应窗口的动态分辨率不可用时，保留本地适配操作。

从 Anas「设置 → 插件」覆盖安装 `anas-rdp-0.1.13-universal.zip`。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

Windows Electron 使用模拟远端画面验证窗口控制及全屏／适配行为；本轮 macOS 窗口交互和真实远端连接未实测。本插件仍为预览版，macOS 程序未公证；其他验证范围见[测试说明](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md)。

## English

Requires **Anas 5.2.11 or later** (plugin API 2). This update depends on the host's new maximization control and window fitting action; upgrade the host first.

- Hide and disable system maximization for separate Windows desktops while retaining minimize and close. Keep the native macOS green button for system fullscreen when adaptation is enabled.
- Always provide a window size action: enter/exit fullscreen with adaptation enabled, or use a distinct icon to restore the allowed maximum size with adaptation disabled. Manual shrinking remains available.
- Remove the duplicate fitting button. Retain local fitting after an initial fitting failure or when dynamic resolution is unavailable in adaptive windows.

Install `anas-rdp-0.1.13-universal.zip` over the existing plugin from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

Windows Electron checks used a synthetic remote display to verify window controls and fullscreen/fitting behavior. macOS window interactions and live remote connections were not retested in this update. This remains a preview, and macOS builds are not notarized; see [testing notes](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md) for other validation limits.
