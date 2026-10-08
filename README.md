# Anas RDP 插件

[English](README.en.md)

可选安装的 Windows 远程桌面插件，在 Anas 侧边页或独立窗口中提供真正的 Web 远程桌面。使用固定版本的 IronRDP Web 组件、WASM 和随包原生桥接，不需要另行部署网关。

Windows x64 已完成真实 Anas 中的认证、画面、基本键盘输入和连接生命周期验证。CI 覆盖 Windows x64、macOS Apple Silicon 和 Intel 的原生构建及通用包校验；macOS 的实际 Anas／RDP 交互仍待实机验收。中文输入及完整键鼠兼容性仍待专项验证；剪贴板、声音、文件传输、多显示器尚未提供。

## 使用

需要 **Anas 3.3.5 或更新版本**（插件 API 1），支持窗口切换和标题栏操作。

已发布版本可下载 [GitHub Releases](https://github.com/higale/anas-plugin-rdp/releases) 的通用 ZIP，同一包可用于 Windows x64、Apple Silicon Mac 和 Intel Mac。从 Anas「设置 → 插件」安装：直接选择 ZIP，或选择完整解压目录中的 `PLUGIN.json`。开发构建使用完整 `dist/` 目录。证书不受系统信任时，独立核对 SHA-256 后按目标信任。支持多服务器配置、按配置选择侧边栏或独立窗口，以及可选密码保存。保存的密码使用内置版本密钥的 AES-GCM 加密，随 Anas 备份跨机器恢复；持有配置及插件代码即可解密。插件名称和界面使用与 Anas 相同的 i18next JSON 语言包，内置简体中文／英文；用户可在 ZIP 的 `lang/` 中新增或修改翻译，安装后跟随宿主当前语种，缺失文字回退英文。可选语种只来自宿主语言包，插件中独有的语种不显示、不能选择。重装完全使用新包语言文件，不保留旧翻译。语言、主题和字号跟随宿主，切换时不重连。见[语言包说明](lang/README.md)。详见[中英用户说明](docs/USER_GUIDE.md)。最终用户无需安装 Rust、Node 或编译工具。

首页默认在侧边栏显示服务器列表（保留已保存的位置选择）；顶部 `＋ / − / ↑ / ↓` 用于新增、删除和排序，悬停或键盘聚焦显示「启动」「编辑」。新增／编辑在单独表单中保存或取消；启动按服务器设置打开连接，有保存密码时直接连接，否则提示输入。可在 Anas「设置 → 插件」中选中 RDP，设置「首页打开位置」，自动保存到插件配置，顶部入口下次打开时生效。每台服务器的「远程桌面打开位置」独立设置，切换首页位置不关闭页面或中断连接。

连接页可通过 Anas 标题栏按钮在侧边栏与独立窗口间移动，同一页面及连接保持运行。修改打开位置仅影响下次打开；目标已有相同页面时，移动会提示冲突并保留双方。

## 开发

需要 Node.js 24、Rust 1.94.1、`wasm32-unknown-unknown` target 和 wasm-pack 0.15.0。IronRDP 源码及版本见 `upstream.lock.json`。

```powershell
npm ci
npm run prepare:upstream
npm run build:upstream
npm run typecheck
npm run test:ui
npm run build
npm test
```

日常修改生成 `dist/`，直接选择其中的 `PLUGIN.json` 安装；发布、分发或验证 ZIP 安装时再运行 `npm run package` 和 `npm run verify:package`。

上游构建同时运行类型检查及 137 项测试。`dist/` 为可安装目录，`artifacts/` 保存 ZIP、校验值和文件清单；本地按平台与 CPU 架构分别构建，GitHub CI 只构建一次公共 Web/WASM 与 JavaScript，分别构建三平台原生程序，再合并并验证通用包。Release 仅提供通用 ZIP 和 `SHA256SUMS.txt`，组件包与逐文件清单留在 Actions。依赖版本、许可证及原始通知随包保留。公开仓库采用独立源码快照，见[同步与发布流程](docs/SOURCE_PUBLISHING.md)。

开发前阅读 [AGENTS.md](AGENTS.md)、[架构与宿主接口](docs/DEVELOPMENT.md)、[测试说明](docs/TESTING.md)和[待办](TODO.md)。Anas 源码在相邻 `../Anas` 仓库。

真实联调资料放在已忽略的 `.local/rdp-test.json`。凭据、日志、截图和测试结果不提交、不随安装包分发；真实连接测试单独运行。

独立连接窗口在宿主标题栏显示连接状态及断开／取消图标，隐藏页面中重复的连接栏；移回侧边栏恢复原布局，连接保持不变。
