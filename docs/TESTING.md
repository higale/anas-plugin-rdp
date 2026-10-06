# 开发测试

## 已完成的 Windows x64 验证

本轮真实宿主基线为 Anas `c6dc6589`（3.3.2、插件 API 1），并在 Anas `4c559fe6`（3.3.3）中直接安装下载的 v0.1.2 通用 ZIP，完整重复下列宿主检查通过。IronRDP 为 `upstream.lock.json` 固定提交，本机 Node 24.19.0、Rust 1.94.1。以下结果来自实际执行，不能代替 macOS 实机验收。

| 检查 | 实际结果 |
| --- | --- |
| 上游 | WASM、两个 Web 包构建和类型检查通过，137 项测试通过 |
| 原生桥接 | 8 项单元／进程测试，rustfmt、clippy、release 构建通过；包含浏览器可用端口范围及占用重试 |
| 界面回归 | 4 项实际 app.ts 回归通过：旧连接错误隔离、保存配置中取消、损坏信任配置、信任保存失败 |
| 插件后台 | 页面归属、幂等断开、无效目标拒绝、后台强制退出后 helper 回收通过 |
| 最小 Electron | 真实认证、桌面像素、鼠标移动／Shift 发送、断开后退出通过 |
| 真实 Anas | 3.3.2 从完整目录安装，3.3.3 从正式发布 ZIP 安装；侧边页和独立窗口认证、桌面像素通过；插件内无 window.gale |
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
npm run test:ui
npm run test:live
npm run test:host
npm run package
npm run verify:package
```

`test:live` 和 `test:host` 读取相邻 Anas 已安装的 Electron／Playwright 依赖；后者还需要已构建的 Anas。两个脚本使用独立测试环境，不修改个人配置；结果分别保存在 `.local/live-result.json` 和 `.local/host-result.json`。宿主测试记录实际提交、工作区状态、平台、架构、依赖版本及安装包 BUILD.json；可用 `RDP_TEST_PACKAGE` 指向已解压的发布包，默认安装 `dist/`。使用 Windows 进程查询审计本次测试目录中的 helper，不要直接当作 macOS 已验证的脚本。

Anas 3.3.3 起安装器选择文件，运行 `test:host` 时另设 `RDP_TEST_INSTALL_SOURCE` 为待验证 ZIP 或 `PLUGIN.json`；`RDP_TEST_PACKAGE` 仍指向对应解压目录，以记录包内构建来源。旧宿主默认使用目录。正式下载包的测试必须先核对 Release 校验文件及 CI 清单，不能拿本地重新编译的目录代替。

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

## 三平台 CI 与进一步验收

v0.1.1 的 Windows x64、macOS ARM64 和 macOS Intel 构建与通用包验证已通过，首轮记录见 [CI 37503477530](https://github.com/higale/anas-plugin-rdp/actions/runs/37503477530)。v0.1.2 起公共 Web/WASM 与 JavaScript 只构建一次，运行上游 137 项测试、类型检查和 4 项界面回归；三个 native job 分别运行 8 项 Rust 测试、clippy 和原生构建。最终通用 ZIP 在三种 runner 上解压，检查逐文件摘要、三份 helper、WASM 编译及后台／辅助程序启动回收；macOS 同时验证可执行权限及 ad-hoc 签名。具体版本以该标签对应的 Actions 结果为准。

v0.1.2 的 [CI 37512782490](https://github.com/higale/anas-plugin-rdp/actions/runs/37512782490) 九个 job 全部成功。Release 仅含通用 ZIP（8,237,349 字节）和校验文件；实下载 SHA-256 为 `c3e967d601a0ae96450dd0c1855a3e5c0dc9558a67eef4d5d3e61a044f2957d8`，与 GitHub 摘要和 CI 清单一致，862 个文件通过解压核验。

CI 使用合成目标，没有真实远程凭据。macOS 实际下载文件的系统拦截行为、系统证书读取、真实 RDP 认证与 Anas 界面交互仍由用户实机验证；构建与进程测试成功不能替代这些验收。

后续验收包括：完整键鼠／中文输入、高 DPI、隐藏保活与焦点切换、多页面归属、网络中断后的状态一致性、长时间连接，以及各平台强制退出回收。所有未验证能力保留在 [待办](../TODO.md)，不能用 Windows 成功推断 macOS 成功。

## 2026-10-07 全项目审核

范围覆盖本仓库前后台、原生桥接、会话归属与进程清理、证书和凭据处理、构建／打包／发布脚本、许可证和文档，并核对固定上游在本插件中的使用路径；不等同于逐行审计全部第三方源码。

已修复五项问题：取消／重连后旧状态查询污染新会话；保存配置期间取消仍创建 helper；损坏信任列表阻断初始化；证书信任保存失败未处理且内存提前更新；系统分配的回环端口被 Chromium 拦截。前四项先复现回归失败再修复，端口问题在真实 Anas 中复现，修复后重跑完整宿主测试通过。

依赖扫描使用 npm 官方 registry 与 cargo-audit 0.22.2。扫描结果按实际编译目标和调用方式复核：

| 范围 | 结果与适用范围 |
| --- | --- |
| 本仓库 npm 与原生 Rust | npm 扫描无漏洞项；native/Cargo.lock 无漏洞或维护告警 |
| 上游两个 Web 包 | 完整 lock 扫描分别有 26、19 个受影响依赖条目，包括重复的传递依赖；多数涉及 Vite 开发／预览服务、Vitest UI 服务和构建工具。本流程仅处理固定源码，执行 build 与非交互测试，安装包不携带这些工具或服务 |
| 随包 Svelte 5.20.5 | 保留 SSR 与 DOM clobbering 类告警。当前仅客户端渲染，远端画面进入 canvas，不接收外部 HTML；没有 SSR、任意 HTML 插入或启用剪贴板／文件传输的路径。该适用性判断不是漏洞已修复的声明，仍跟踪上游升级 |
| 上游 Rust 工作区 | 完整 Cargo.lock 有 9 条漏洞记录，其中 8 条不在 ironrdp-web 的 wasm32 普通／构建依赖图。实际 WASM 图包含 rsa 的 [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)，上游暂无修复。该告警针对 RSA 私钥操作的计时侧信道；本插件采用密码／NTLM CredSSP，未配置智能卡、客户端 RSA 私钥或 KDC proxy，TLS 由 native rustls 处理，当前连接路径未使用相关私钥操作 |

上游 Rust 扫描另有 4 项停止维护和 2 项已撤回版本告警；当前 WASM 图涉及后者中的 chacha20 0.10.1。上游 [0.10.2 修复说明](https://github.com/RustCrypto/stream-ciphers/releases/tag/chacha20-v0.10.2)针对 SSE 后端，不用于本插件的 wasm32 目标，仍纳入升级跟踪。

原始扫描结果和依赖图保存在忽略的 `.local/audit/`；不随包分发。新增认证方式、SSR／外部 HTML、剪贴板或文件功能前须重新评估，不能把当前路径结论扩展到未提供的功能。

## 宿主回归

修改 Anas 时遵守其 AGENTS.md，并在该仓库运行对应行为测试、`npm run typecheck`、`npm run build`、`node scripts/electron-plugins.cjs`。涉及启动响应性时另运行 `npm run test:e2e -- --startup-only`。保持纯 UI 与可选后台示例兼容，不自行修改正式版本号。
