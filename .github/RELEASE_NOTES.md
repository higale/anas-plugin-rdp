# Anas RDP v0.1.7

## 简体中文

需要 **Anas 3.3.8 或更新版本**（插件 API 2）。请先升级 Anas，再安装此插件。

- 使用原生 IronRDP 引擎在后台持有会话与画面；侧栏和独立窗口间移动可恢复未保存输入，继续原连接。
- 分离服务器编辑和连接页面，支持连接时选择保存加密密码；连接页存在或后台运行时禁止编辑，避免配置与会话不一致。
- 新增默认关闭的「后台运行」：关闭桌面默认断开，勾选后可从列表恢复同一会话；断开状态只在桌面页仍存在时显示。
- 右键可在侧栏或独立窗口启动／恢复，成功打开和移动后记住位置；统一操作图标，「服务器列表」定位当前条目并保留编辑草稿。

下载 `anas-rdp-0.1.7-universal.zip`，从 Anas「设置 → 插件」安装。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

仍为预览版。Windows 已验证连接与页面交接；Apple Silicon 实机验收及 macOS 本轮功能复核尚未完成。macOS 程序未公证。

## English

Requires **Anas 3.3.8 or later** (plugin API 2). Upgrade Anas before installing this plugin.

- Keep sessions and framebuffers in a native IronRDP backend; moving between the sidebar and windows restores unsaved input and retains the original connection.
- Separate profile editing from connection pages and optionally save an encrypted password when connecting. Existing desktop pages and background sessions block editing to keep profiles and sessions consistent.
- Add Run in background, off by default: closing a desktop normally disconnects; when enabled, resume the same session from the list. Show Disconnected only while its desktop page still exists.
- Start or resume in either location from the context menu and remember successful openings and moves. Unify action icons; Server list selects the current row without discarding an edit draft.

Install `anas-rdp-0.1.7-universal.zip` from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

This remains a preview. Connections and page handoff have been verified on Windows; Apple Silicon hardware acceptance and macOS verification of this round’s features remain pending. macOS builds are not notarized.
