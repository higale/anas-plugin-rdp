# Anas RDP v0.1.4

## 简体中文

需要 **Anas 3.3.5 或更新版本**（插件 API 1）。

- 连接页可在侧边栏与独立窗口间移动，保留连接、桌面和未保存表单。
- 独立窗口标题栏显示连接状态及断开／取消图标，提供悬停提示，页面不再重复显示操作栏。
- 完善异步取消和关闭清理；标题栏更新失败时保留页面操作入口并显示错误。
- macOS 打包排除系统元数据，避免 ZIP 混入额外文件。

下载 `anas-rdp-0.1.4-universal.zip`，从 Anas「设置 → 插件」安装。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

仍为预览版。本轮已验证 macOS 界面、窗口切换和本地传输取消；Windows 新界面及真实 macOS RDP 登录尚未实机验收。macOS 程序未公证。

## English

Requires **Anas 3.3.5 or later** (plugin API 1).

- Move connection pages between sidebar and window while preserving connections, desktops, and unsaved forms.
- Show connection status and Disconnect/Cancel icons with tooltips in the window titlebar, removing duplicate page controls.
- Improve asynchronous cancellation and cleanup; retain page controls and report errors if titlebar updates fail.
- Exclude macOS filesystem metadata from ZIP packages.

Install `anas-rdp-0.1.4-universal.zip` from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

This remains a preview. This round verified macOS UI, window transfers, and local transport cancellation. The new Windows UI and real macOS RDP login still need hardware acceptance testing. macOS builds are not notarized.
