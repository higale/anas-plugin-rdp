# Anas RDP v0.1.1

## 简体中文

首次公开预览版：使用 IronRDP Web/WASM 和随包原生桥接，在 Anas 侧边页或独立窗口连接 Windows 远程桌面。支持连接、取消、断开、按目标确认 TLS 证书、画面适配及基本键鼠；密码不写入普通配置。

- 推荐下载 `anas-rdp-0.1.1-universal.zip`，同一目录包含 Windows x64、macOS Apple Silicon 和 macOS Intel 的辅助程序，运行时自动选择；同时提供体积更小的三个独立包。
- ZIP 解压后，在 Anas「设置 → 插件」从文件夹安装完整目录。无需安装 Rust 或 Node。
- 需要包含开发提交 `c2250c06` 的 Anas（插件 API 1、iframe 表单支持）。当前 GitHub 上的 Anas 3.3.1 发布包尚未包含此修复；本次插件发布不替代宿主更新。
- 三平台 CI 校验构建、原生传输测试、ZIP 内容、WASM 编译与解压后的辅助程序启动／回收；通用包在三种 runner 上再次验证。macOS 使用 ad-hoc 签名，未进行 Apple 公证。
- Windows 真实 Anas 认证、画面、证书和生命周期测试已通过。macOS 的真实 RDP／Anas 交互仍待用户实机验收；CI 通过不代表远程连接验收通过。
- 中文输入、完整键鼠兼容性和长期稳定性仍需专项验证；剪贴板、音频、文件传输、多显示器、会话转移及保存密码暂不提供。

校验值见 `SHA256SUMS.txt`，各 ZIP 附有逐文件清单与构建来源。

## English

First public preview: connect to a Windows remote desktop from an Anas side panel or separate window using IronRDP Web/WASM and bundled native bridges. Includes connect/cancel/disconnect, target-bound TLS certificate trust, scaling, and basic keyboard/mouse input. Passwords are excluded from ordinary settings.

- Prefer `anas-rdp-0.1.1-universal.zip`: one directory contains helpers for Windows x64, Apple Silicon macOS, and Intel macOS, selected automatically at runtime. Three smaller platform packages are also provided.
- Extract the ZIP and install the complete folder from Anas Settings → Plugins. Rust and Node are not required for end users.
- Requires Anas containing development commit `c2250c06` (plugin API 1, iframe form support). The current Anas 3.3.1 GitHub release does not contain this fix; this plugin release does not update the host.
- CI checks all three builds, native transport tests, archive contents, WASM compilation, and helper startup/cleanup after extraction. The universal package is checked again on all three runners. macOS helpers are ad-hoc signed and are not notarized by Apple.
- Authentication, rendering, certificate handling, and lifecycle behavior were tested in Anas on Windows. Real macOS RDP/Anas interaction awaits user hardware validation; CI success is not a remote connection acceptance test.
- Chinese input, full keyboard/mouse compatibility, and long-term stability require further validation. Clipboard, audio, file transfer, multiple displays, session transfer, and password storage are not included.

See `SHA256SUMS.txt` for checksums. Each ZIP includes an accompanying file inventory and build provenance.
