# 开发测试

## 已完成的 Windows x64 验证

宿主基线为 Anas `c2250c06`（3.3.1、插件 API 1），IronRDP 为 `upstream.lock.json` 固定提交，Node 24.19.0、Rust 1.94.1。以下结果来自实际执行，不代表 macOS 已支持。

| 检查 | 实际结果 |
| --- | --- |
| 上游 | WASM、两个 Web 包构建和类型检查通过，137 项测试通过 |
| 原生桥接 | 7 项单元／进程测试，rustfmt、clippy、release 构建通过 |
| 插件后台 | 页面归属、幂等断开、无效目标拒绝、后台强制退出后 helper 回收通过 |
| 最小 Electron | 真实认证、桌面像素、鼠标移动／Shift 发送、断开后退出通过 |
| 真实 Anas | 从完整目录安装；侧边页和独立窗口认证、桌面像素通过；插件内无 window.gale |
| 输入与连接 | 超过 30 秒 RPC 期限后仍连接；Meta 输入后远端画面发生变化，Escape 关闭菜单 |
| 外观 | 明暗主题、14／18px 字号、窄侧边页无横向溢出；截图已视检 |
| 证书界面 | 首次不受信任证书被拒绝；核对已批准指纹后，从界面信任并重试成功 |
| 生命周期 | 断开、协商中取消、关闭页面、停用、卸载、备份、恢复及宿主实际主进程强制终止后无遗留 helper |
| 持久化 | 普通连接配置不包含密码；卸载保留配置；恢复不自动登录 |
| 宿主回归 | 表单修复前行为测试复现失败，修复后类型检查、构建及完整 Electron 插件回归通过 |

鼠标移动与 Shift 已发送；完整点击、拖动、滚轮、全部组合键、中文输入、高 DPI、长期稳定性及多页面输入隔离未完成专项验证。测试只保证观察到的行为，不能把少量输入检查扩展成完整兼容性声明。

## 执行入口

先按 [开发说明](DEVELOPMENT.md)完成构建，再在仓库根执行：

```powershell
npm run typecheck
npm test
npm run test:live
npm run test:host
npm run package
```

`test:live` 和 `test:host` 读取相邻 Anas 已安装的 Electron／Playwright 依赖；后者还需要已构建的 Anas。两个脚本使用独立测试环境，不修改个人配置；结果分别保存在 `.local/live-result.json` 和 `.local/host-result.json`。宿主测试记录实际提交、工作区状态、平台、架构及依赖版本，使用 Windows 进程查询审计本次测试目录中的 helper。不要把它直接当作 macOS 已验证的脚本。

真实连接测试只使用已经核对的目标证书信任，不自动接受未知证书或新指纹。异常退出必须终止 Electron `process.pid` 对应的实际主进程；Windows 下 Playwright 启动器 PID 可能不同。测试不录屏，外观截图在填写真实资料之前生成。

在 `native/` 中执行：

```powershell
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --release --locked
```

覆盖分片 X.224、截断／无效数据、系统信任和名称校验、固定指纹替换、票据与目标绑定、来源限制、超大握手消息及 stdin 关闭后的进程和端口回收。普通测试使用合成目标，不依赖真实远程电脑。

## 连接资料与证书

`.local/rdp-test.json` 保存本机测试配置，字段为 `host`、`port`、`username`、`password`、可选 `domain` 和 `purpose`。该文件不随仓库或插件分发；新工作目录自行准备。工具从文件读取，不将真实值放入命令行、日志、截图或提交说明。日志与结果也放在 `.local/`。

运行 `node scripts/probe.mjs` 仅验证 TCP、X.224、TLS，不发送账户密码。结果写入 `.local/probe-result.json`，内部期限 15 秒，外部进程期限 20 秒；成功不等于完成 NLA 登录。

首次 `certificate_required` 须由用户独立核对 SHA-256。确认后执行 `node scripts/trust-test-certificate.mjs <已核对的64位小写SHA-256>`，写入通过目标摘要绑定的 `.local/rdp-trust.json`。目标或指纹变化必须重新确认，不关闭远程 NLA 或修改系统认证策略。

提交和打包前核对：

```powershell
git check-ignore -v -- .local/rdp-test.json
git diff --cached --name-only
git diff --check
```

安装包只包含明确列出的 `dist/` 产物，不能从仓库根全量打包。`npm run package` 输出 SHA-256、逐文件清单和体积检查结果。

## macOS 与进一步验收

macOS 需先完成原生构建，确认可执行权限、系统证书读取、WASM、loopback WebSocket，再重复真实宿主测试。当前尚无 macOS 实机结果，也未提供可称为已验证的 macOS 安装包。

后续验收包括：完整键鼠／中文输入、高 DPI、隐藏保活与焦点切换、多页面归属、网络中断后的状态一致性、长时间连接，以及各平台强制退出回收。所有未验证能力保留在 [待办](../TODO.md)，不能用 Windows 成功推断 macOS 成功。

## 宿主回归

修改 Anas 时遵守其 AGENTS.md，并在该仓库运行对应行为测试、`npm run typecheck`、`npm run build`、`node scripts/electron-plugins.cjs`。涉及启动响应性时另运行 `npm run test:e2e -- --startup-only`。保持纯 UI 与可选后台示例兼容，不自行修改正式版本号。
