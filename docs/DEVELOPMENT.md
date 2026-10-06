# RDP 插件开发说明

核对日期：2026-10-07。Windows x64 已能在真实 Anas 侧边页及独立窗口认证、显示桌面和发送输入。Windows x64、macOS ARM64／x64 的构建和通用包检查已在 GitHub CI 通过；macOS 实际 Anas／RDP 交互尚待验收。实际检查范围见 [测试说明](TESTING.md)，剩余工作见 [待办](../TODO.md)。

## 依赖与构建

- Anas 需要包含提交 `c2250c06`，正式版本仍为 3.3.1，插件 API 仍为 1。该提交为 iframe 增加 `allow-forms`，使表单校验、点击及 Enter 触发的脚本提交可用；CSP `form-action 'none'` 仍阻止表单网络提交。仅版本号不足以判断是否包含修复。
- [IronRDP](https://github.com/Devolutions/IronRDP) 固定为 `2c08bda7c5f9ad490e01f123b3be5521cf3c6e9d`，见 `upstream.lock.json`。原生依赖使用 `native/Cargo.lock`，两个 Web 包沿用固定提交中的 npm 锁文件。
- 工具链为 Rust 1.94.1、`wasm32-unknown-unknown` target、wasm-pack 0.15.0、Node.js 24；本机验证 Node 24.19.0。辅助程序按本机操作系统和 CPU 架构构建，拒绝 Node 与 Rust 主机架构不一致的构建。
- 许可证原文及声明在 `third-party/`。构建时收集依赖版本、许可证和原始通知，清单同时包含构建依赖，不代表每项均链接到运行时。部分发布包缺失的许可证从其精确源码提交补齐，来源见 `license-supplements/sources.json`。

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

`prepare:upstream` 核对 `.local/upstream/IronRDP` 的固定源码、Git 来源及许可证，不覆盖已有修改。`build:upstream` 构建 WASM 和两个 Web 包，运行它们的类型检查及 137 项测试。可通过 `WASM_PACK_PATH` 指定 wasm-pack 路径；Cargo 默认并行数为 4，可用 `CARGO_BUILD_JOBS` 调整。

生成的 WASM loader 保留独立 WASM 文件，避免 Vite 内嵌的 `data:` URL 被宿主 CSP 拦截；仅调整被忽略的生成文件。`artifacts/upstream/` 保存上游产物，`dist/` 是完整可安装目录，包含清单、UI、WASM、Node 后台、平台辅助程序、双语说明和许可证。最终用户不需要构建工具。

`package` 核对产物范围及宿主大小限制，生成平台／架构 ZIP、SHA-256 和文件清单。`verify:package` 解压后核对逐文件摘要、WASM 编译及辅助程序生命周期，macOS 另检查可执行权限和 ad-hoc 签名。ZIP 先解压再安装。`BUILD.json` 记录源码提交及工作区状态、平台、工具版本和依赖锁摘要。Windows x64 完整目录约 13.2 MiB；其他平台不能借用 Windows 辅助程序。

GitHub 工作流在三个平台分别构建并检查，再合并共享 Web/WASM 与三个原生程序，生成通用 ZIP；合并时核对源码及依赖锁、保留全部许可证，并在三个平台重新验证通用包。详见[源码快照与构建流程](SOURCE_PUBLISHING.md)。开发者可运行 `node scripts/setup-build-tools.mjs` 安装固定 Rust 组件并下载校验 wasm-pack；脚本需要预先安装 rustup，非 CI 环境需将输出路径设置为 `WASM_PACK_PATH`。

## 实际架构

```text
Anas 侧边页 / 独立窗口
  ├─ IronRDP Web Component + WASM：认证、图形、键鼠、会话
  ├─ window.anas.backend.call：create / status / disconnect
  └─ loopback WebSocket 二进制流
       ↓
插件 Node 后台：页面归属、随机票据、辅助程序管理
       ↓
Rust 辅助程序：IronRDP RDCleanPath / X.224、TLS、有界流式转发
       ↓
Windows RDP 服务
```

页面仅使用公开 `window.anas` API。密码留在页面与 WASM 连接内存，不进入后台控制参数、命令行、普通 JSON 数据或日志。`connection` 只保存地址、端口、用户名和域；`certificate_trust` 保存按目标确认的 SHA-256。连接成功后清空密码输入框。卸载保留普通配置，应用备份包含普通配置及证书信任。

后台最多管理四条连接，每页使用独立 owner 和连接 ID。创建只等待辅助程序准备好入口；认证及持续桌面数据走 WebSocket，不占用长时间 RPC。

辅助程序绑定随机 loopback 端口，限定 `anas-plugin://rdp` 来源与 `/rdp` 路径。随机票据采用常量时间比较并绑定目标；拒绝客户端替换目标、提交服务器认证或任意预连接数据。入口 30 秒失效，单次 WebSocket 握手 3 秒，RDCleanPath 请求上限 64 KiB，二进制消息上限 1 MiB；协商及 TLS 总期限 15 秒，写入期限 10 秒。持续流分块、有背压，并用 ping/pong 检查存活。

TLS 默认校验系统信任及名称。不受信任的证书先拒绝并显示 SHA-256，用户独立核对后按主机和端口固定叶证书。已有指纹变化时再次拒绝，不能退回系统信任绕过固定指纹。TLS 签名仍由 rustls 校验，不全局跳过证书验证。

## 生命周期与界面

每个页面拥有自己的连接，侧边页与独立窗口不是同一会话。上游组件处理桌面缩放和焦点输入，插件提供连接、取消、断开、证书提示及可观察错误。打开页面时从宿主读取明暗主题、语言和字号，控件高度为 `max(30px, 字号 + 18px)`。宿主暂无设置变更订阅，修改外观后重新打开插件生效。

断开终止 Web 会话并关闭辅助程序 stdin，必要时有界终止子进程。上游会话结束后再次 `shutdown()` 可能抛错，插件仍继续清理传输和界面。关闭页面通过 WebSocket 断开回收；后台退出会关闭 stdin 控制管道，辅助程序自行退出，不能仅依赖正常 `deactivate()`。

停用、卸载、备份和恢复使用宿主已有停止流程，恢复不自动登录。Windows 已验证后台及实际宿主主进程强制退出后的回收；Electron 启动器 PID 可能与实际主进程不同。macOS 必须单独验证。首版不提供活动会话转移、密码保存、剪贴板、文件传输、多显示器或声音功能。

## 宿主接口与扩展边界

相邻 `../Anas/docs/PLUGINS.md` 是接口说明，源码是最终依据。

| 能力 | 已核对的约束 |
| --- | --- |
| 清单 | `version: 0`、`api_version: 1`；UI 和后台至少一个；`platforms` 不包含 CPU 架构选择 |
| 页面 | `anas-plugin://<id>/`，无 Node 和 `window.gale`；SDK 为 `/_anas/sdk.js` |
| SDK | `getInfo`、`data.get/set`、`openExternal`、`backend.call`；暂无安全密码存储、剪贴板、通用事件订阅 |
| 后台 | `.cjs` 导出 activate、call、deactivate；上下文含插件 ID、包目录和数据目录 |
| RPC | JSON 1 MiB、最多 32 个待处理请求；后台串行执行，启动及调用含排队均有 30 秒期限 |
| 停止 | 3 秒总预算，清理失败向调用方报告；不承诺回收任意原生后代进程 |
| 数据 | 普通 JSON，单插件 1 MiB；卸载保留、备份包含，不用于明文密码 |
| 包 | 最多 10,000 项、总计 512 MiB、单文件 128 MiB；安装时不编译 |

仅针对已复现的通用缺口扩展宿主，补齐文档和行为测试。RDP 协议、依赖与专用界面留在此仓库；不扩大 IPC、关闭隔离或向宿主硬编码 RDP。两个仓库独立提交推送，不自动合并或发布 Anas。
