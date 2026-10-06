# Anas 远程桌面 / Remote Desktop

## 简体中文

此版本为开发原型，已在 Windows x64 验证。macOS 尚未实机验证。
需要包含提交 `c2250c06` 的 Anas 开发版本（插件 API 1）；仅正式版本号 3.3.1 不足以判断是否包含所需表单修复。

1. 在 Anas「设置 → 插件」中从文件夹安装完整构建目录；ZIP 包先解压，再选择解压目录。
2. 在侧边页或独立窗口打开远程桌面，填写地址、端口、用户名、可选域和密码。
3. 点击「连接」。证书不受系统信任时，先独立核对服务器证书 SHA-256，再选择信任并重试。证书变化会再次提示。
4. 桌面区域内操作键鼠；点击「断开」结束连接，连接过程中可点击「取消」。

地址、账户、域和按目标确认的证书指纹会保存。密码只驻留连接内存，连接成功后清空输入框，不写入普通配置或备份。卸载保留普通配置，重新安装同 ID 插件可继续使用。每个页面拥有自己的连接；两个页面登录同一 Windows 账户时，服务端可能将原会话断开。

此版本提供画面、基本键鼠、窗口适配、证书信任和连接回收。剪贴板、声音、文件传输、多显示器、活动会话跨窗口转移及保存密码尚未提供。中文输入和全部组合键的支持范围仍需专项验证。

安装包已包含 Web 组件、WASM、原生辅助程序和第三方声明，用户无需安装 Rust 或 Node。推荐通用 ZIP，它包含 Windows x64、macOS Apple Silicon 和 Intel 三种辅助程序并自动选择；较小的独立平台包只适用于指定操作系统及架构。macOS 辅助程序采用 ad-hoc 签名，未经过 Apple 公证。

## English

This is a development prototype verified on Windows x64. macOS has not been tested on hardware.
It requires an Anas development build containing commit `c2250c06` (plugin API 1). The application version 3.3.1 alone does not identify the required form fix.

1. In Anas Settings → Plugins, install the complete build directory from a folder. Extract ZIP packages first, then select the extracted directory.
2. Open Remote Desktop in a side panel or separate window. Enter the address, port, username, optional domain, and password.
3. Select Connect. If the system does not trust the server certificate, independently verify its SHA-256 before accepting it and retrying. Certificate changes require confirmation again.
4. Use the keyboard and mouse inside the desktop. Select Disconnect to end the session, or Cancel while connecting.

The address, account, domain, and certificate fingerprints approved per target are saved. Passwords stay in connection memory, are cleared from the input after connection, and are excluded from ordinary configuration and backups. Uninstalling retains ordinary configuration for reinstallation under the same plugin ID. Each page owns its connection; Windows may disconnect an earlier session when another page signs in with the same account.

This version provides desktop rendering, basic keyboard/mouse input, scaling, certificate trust, and connection cleanup. Clipboard, audio, file transfer, multiple displays, moving active sessions between windows, and password storage are not provided. Chinese input and full shortcut coverage still require dedicated verification.

The package includes Web components, WASM, native helpers, and third-party notices. End users do not need Rust or Node. The recommended universal ZIP includes Windows x64, Apple Silicon macOS, and Intel macOS helpers selected automatically at runtime; smaller platform packages only work on their specified operating system and architecture. macOS helpers are ad-hoc signed and are not notarized by Apple.
