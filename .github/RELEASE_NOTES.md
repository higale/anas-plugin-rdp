# Anas RDP v0.1.8

## 简体中文

需要 **Anas 3.3.12 或更新版本**（插件 API 2）。请先升级 Anas，再安装此插件。

- 新增模型工具与操作技能：管理服务器、连接、截图、键鼠及 Unicode 文本输入；连接可跨对话复用。
- 新增本地输入锁、重置键盘、固定分辨率和独立窗口适配；统一侧栏与标题栏图标。
- 剪贴板按连接独立启用，仅活动桌面同步新内容，在途文件传输继续收尾。Windows 支持文件双向按需复制，macOS 支持文本双向同步和本地文件上传。

下载 `anas-rdp-0.1.8-universal.zip`，从 Anas「设置 → 插件」安装。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

仍为预览版。核心连接与输入已在 Windows x64、macOS Intel 实测；Windows 多连接剪贴板及 Explorer 粘贴／取消、断网清理仍待补验，Apple Silicon 未实测。Finder 按需粘贴已延期；本地输入法文本框尚未实现。macOS 程序未公证。完整边界见[测试说明](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md)。

## English

Requires **Anas 3.3.12 or later** (plugin API 2). Upgrade Anas before installing this plugin.

- Add model tools and an operation Skill for profile management, connections, screenshots, keyboard/mouse and Unicode text input; connections persist across conversations.
- Add local input locking, keyboard reset, fixed resolutions and window fitting; share icons between the sidebar and titlebar.
- Enable clipboard sharing per connection. Only the active desktop synchronizes new content while existing file transfers finish. Windows supports bidirectional on-demand file copying; macOS supports bidirectional text and local-file uploads.

Install `anas-rdp-0.1.8-universal.zip` from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

This remains a preview. Core connections and input have been tested on Windows x64 and Intel macOS. Windows multi-connection clipboard behavior, Explorer paste/cancel, and network-loss cleanup still need verification; Apple Silicon has not been tested on hardware. On-demand Finder paste is deferred; the local-IME text dialog is not implemented. macOS builds are not notarized. See [testing notes](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md) for full limitations.
