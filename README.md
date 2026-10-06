# Anas RDP 插件

[English](README.en.md)

可选安装的 Windows 远程桌面插件，在 Anas 侧边页或独立窗口中提供真正的 Web 远程桌面。使用固定版本的 IronRDP Web 组件、WASM 和随包原生桥接，不需要另行部署网关。

Windows x64 开发原型已完成真实 Anas 中的认证、画面、基本键盘输入和连接生命周期验证。macOS 是目标客户端平台，尚未完成构建和实机验证。中文输入及完整键鼠兼容性仍待专项验证；剪贴板、声音、文件传输、多显示器、活动会话转移和保存密码尚未提供。

## 使用

需要包含提交 `c2250c06` 的 Anas 开发版本（插件 API 1）。正式版本号 3.3.1 本身不能判断是否包含所需表单修复。

从 Anas「设置 → 插件」安装完整 `dist/` 文件夹，或先解压 [GitHub Releases](https://github.com/higale/anas-plugin-rdp/releases) 的 ZIP，再选择解压目录。推荐通用 ZIP，同一目录可用于 Windows x64、Apple Silicon Mac 和 Intel Mac；也提供三个较小的独立包。证书不受系统信任时，独立核对 SHA-256 后按目标信任。密码只驻留内存，不写入普通配置或备份。详见[中英用户说明](docs/USER_GUIDE.md)。最终用户无需安装 Rust、Node 或编译工具。

## 开发

需要 Node.js 24、Rust 1.94.1、`wasm32-unknown-unknown` target 和 wasm-pack 0.15.0。IronRDP 源码及版本见 `upstream.lock.json`。

```powershell
npm ci
npm run prepare:upstream
npm run build:upstream
npm run typecheck
npm run build
npm test
npm run package
npm run verify:package
```

上游构建同时运行类型检查及 137 项测试。`dist/` 为可安装目录，`artifacts/` 保存 ZIP、校验值和文件清单；本地按平台与 CPU 架构分别构建，GitHub CI 合并并验证通用包。依赖版本、许可证及原始通知随包保留。公开仓库采用独立源码快照，见[同步与发布流程](docs/SOURCE_PUBLISHING.md)。

开发前阅读 [AGENTS.md](AGENTS.md)、[架构与宿主接口](docs/DEVELOPMENT.md)、[测试说明](docs/TESTING.md)和[待办](TODO.md)。Anas 源码在相邻 `../Anas` 仓库。

真实联调资料放在已忽略的 `.local/rdp-test.json`。凭据、日志、截图和测试结果不提交、不随安装包分发；真实连接测试单独运行。
