# Anas RDP v0.1.2

## 简体中文

完成插件前后台、原生桥接、连接生命周期、构建发布和依赖使用范围审核，修复以下问题并精简下载项：

- 修复旧连接的延迟错误干扰新连接，以及保存配置期间取消仍启动辅助程序的问题。
- 损坏的证书信任配置不再阻断初始化；保存信任失败会显示错误，不会按未保存的信任继续连接。
- 回环 WebSocket 使用动态端口范围并处理占用，避免系统分配的端口被 Chromium 拦截。
- 公共 UI、JS 和 WASM 只构建一次；仅 native 分 Windows x64、macOS ARM64、macOS x64 构建。最终仅提供一个通用 ZIP 和 SHA256SUMS.txt。逐文件清单与组件包保留在 Actions，构建来源与许可证仍在 ZIP 内。

下载 anas-rdp-0.1.2-universal.zip，从 Anas「设置 → 插件」安装：Anas 3.3.3 起直接选择 ZIP，或选择完整解压目录中的 PLUGIN.json；Anas 3.3.2 先解压，再选择整个目录。三种平台使用同一个 ZIP，无需安装 Rust 或 Node。需要 Anas 3.3.2 或包含提交 c2250c06 的开发版本（插件 API 1、iframe 表单支持）。

新增 4 项界面回归测试，原生测试增至 8 项。Windows 真实 Anas 的认证、画面、证书、取消及退出回收测试通过；发布流程要求通用 ZIP 在三个平台完成内容、WASM、辅助程序启动／回收验证。macOS 辅助程序使用 ad-hoc 签名，未公证；实际 macOS RDP／Anas 交互仍由用户实机验证。固定上游的依赖告警及当前适用范围见 docs/TESTING.md，不声明依赖扫描全部清零。

仍为预览版。中文输入、完整键鼠兼容性和长期稳定性待专项验证；暂不提供剪贴板、音频、文件传输、多显示器、会话转移和保存密码。GitHub 自动提供的两项 Source code 下载属于源码，不是插件安装包。

## English

Reviewed the plugin UI and backend, native bridge, connection lifecycle, build/release pipeline, and dependency usage. This release fixes the following issues and simplifies downloads:

- Late errors from an old connection no longer interfere with a new connection. Cancelling while settings are being saved no longer starts a helper afterward.
- Malformed certificate trust settings no longer block initialization. Trust persistence failures are shown to the user and do not start a connection using unsaved trust.
- The loopback WebSocket uses the dynamic port range with collision handling, avoiding ports blocked by Chromium.
- Shared UI, JavaScript, and WASM are built once; only native helpers are built separately for Windows x64, macOS ARM64, and macOS x64. Releases provide one universal ZIP and SHA256SUMS.txt. File inventories and component archives stay in Actions; build provenance and licenses remain inside the ZIP.

Download anas-rdp-0.1.2-universal.zip and install from Anas Settings → Plugins. In Anas 3.3.3 or later, select the ZIP directly or select PLUGIN.json inside the complete extracted folder. In Anas 3.3.2, extract first and select the entire folder. The same ZIP serves all three platforms. Rust and Node are not required. Requires Anas 3.3.2 or a development build containing commit c2250c06 (plugin API 1, iframe form support).

Added 4 UI regression tests; the native suite now contains 8 tests. Authentication, rendering, certificates, cancellation, and process cleanup passed in Anas on Windows. Publication requires the universal ZIP to pass content, WASM, and helper startup/cleanup checks on all three platforms. macOS helpers are ad-hoc signed and are not notarized; real macOS RDP/Anas interaction still awaits user hardware validation. See docs/TESTING.md for pinned upstream dependency advisories and applicability; this is not a claim of zero dependency findings.

This remains a preview. Chinese input, full keyboard/mouse compatibility, and long-term stability need dedicated verification. Clipboard, audio, file transfer, multiple displays, session transfer, and password storage are not included. GitHub's two automatic Source code downloads contain source code, not an installable plugin.
