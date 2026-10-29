# Anas RDP v0.1.11

## 简体中文

需要 **Anas 4.0.4 或更新版本**（插件 API 2）。

- 修复侧栏按钮悬停提示偶发不显示：插件页面统一使用 DOM 提示，支持键盘聚焦、动态文字和页面边缘避让，并在点击、移出、菜单、Esc、失焦及页面关闭时清理。
- 将画面／光标更新与控件状态通知分开；状态不变的下载轮询不刷新界面，单项操作只更新受影响的按钮属性。
- 保留协议版本推进和迟到回执保护，补充提示生命周期、连续画面更新与按钮刷新回归测试。

下载 `anas-rdp-0.1.11-universal.zip`，从 Anas「设置 → 插件」覆盖安装。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

本轮 160 项 UI／桌面测试、类型检查和本机构建通过。macOS Electron 真实连接中验证了 7 个按钮连续 3 轮悬停、中英文明暗主题、窗口往返及停止连接；Windows tooltip 尚未实测。CI 构建和包内自检不代替真实远端或各平台交互验收。

仍为预览版。Apple Silicon 未实机验证，macOS 程序未公证；Finder 直接粘贴远端文件未实现，最终“直接保存到所选目录”下载流程、Windows 多连接剪贴板及 Explorer 粘贴／取消仍需补充实机验证。完整范围见[测试说明](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md)。

若同时从 Anas 4.0 之前版本升级宿主，请先阅读 [4.x 升级数据说明](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.zh-CN.md)，了解历史数据布局变化；这不是本次插件更新新增的数据变更。

## English

Requires **Anas 4.0.4 or later** (plugin API 2).

- Fix intermittent sidebar button tooltips with document-local DOM tooltips, including keyboard focus, changing labels, viewport edge placement, and cleanup on clicks, pointer exit, menus, Escape, blur, and page disposal.
- Separate desktop/cursor updates from control-state notifications. Unchanged download polls no longer refresh the UI, and individual actions update only affected button attributes.
- Preserve protocol revision tracking and stale-receipt protection, with regression coverage for tooltip lifecycle, continuous display updates, and button mutations.

Install `anas-rdp-0.1.11-universal.zip` over the existing plugin from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

All 160 UI/desktop tests, type checking, and the local build passed. Live macOS Electron checks covered three hover rounds over seven buttons, Chinese/English and light/dark themes, window handoff, and connection shutdown. Windows tooltips have not been tested on hardware. CI builds and package self-tests do not replace live remote or platform interaction testing.

This remains a preview. Apple Silicon has not been tested on hardware, and macOS builds are not notarized. Direct remote-file paste into Finder is not implemented. The final download flow that saves directly into the chosen directory, Windows multi-connection clipboard behavior, and Explorer paste/cancel still need further live testing. See [testing notes](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md) for the full scope.

If also upgrading the host from Anas versions before 4.0, read the [4.x data upgrade notes](https://github.com/higale/anas-agent/blob/main/data/help/UPGRADE_TO_4.en.md) for historical layout changes; these are not new data changes introduced by this plugin update.
