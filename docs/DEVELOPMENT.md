# RDP 插件开发说明

核对日期：2026-10-07。Windows x64 已能在真实 Anas 侧边页及独立窗口认证、显示桌面和发送输入。Windows x64、macOS ARM64／x64 的构建和通用包检查已在 GitHub CI 通过；macOS 实际 Anas／RDP 交互尚待验收。实际检查范围见 [测试说明](TESTING.md)，剩余工作见 [待办](../TODO.md)。

## 依赖与构建

- 本版要求 Anas 3.3.4 或包含开发提交 `ae8a9d3d` 的宿主，提供 `getLanguageResources`、`getHome`、`openHome`、`openView` 和页面实例信息，API 仍为 1。既有 `c2250c06` 的 iframe 表单支持继续保留。插件检测旧宿主并提示升级，不自动发布宿主。
- [IronRDP](https://github.com/Devolutions/IronRDP) 固定为 `2c08bda7c5f9ad490e01f123b3be5521cf3c6e9d`，见 `upstream.lock.json`。原生依赖使用 `native/Cargo.lock`，两个 Web 包沿用固定提交中的 npm 锁文件。
- 工具链为 Rust 1.94.1、`wasm32-unknown-unknown` target、wasm-pack 0.15.0、Node.js 24；本机验证 Node 24.19.0。辅助程序按本机操作系统和 CPU 架构构建，拒绝 Node 与 Rust 主机架构不一致的构建。
- 许可证原文及声明在 `third-party/`。构建时收集依赖版本、许可证和原始通知，清单同时包含构建依赖，不代表每项均链接到运行时。部分发布包缺失的许可证从其精确源码提交补齐，来源见 `third-party/license-supplements/sources.json`。

```powershell
npm ci
npm run prepare:upstream
npm run build:upstream
npm run typecheck
npm run build
npm test
```

`prepare:upstream` 核对 `.local/upstream/IronRDP` 的固定源码、Git 来源及许可证，不覆盖已有修改。`build:upstream` 构建 WASM 和两个 Web 包，运行它们的类型检查及 137 项测试。可通过 `WASM_PACK_PATH` 指定 wasm-pack 路径；Cargo 默认并行数为 4，可用 `CARGO_BUILD_JOBS` 调整。

生成的 WASM loader 保留独立 WASM 文件，避免 Vite 内嵌的 `data:` URL 被宿主 CSP 拦截；仅调整被忽略的生成文件。`artifacts/upstream/` 保存上游产物，`dist/` 是完整可安装目录，包含清单、UI、WASM、Node 后台、平台辅助程序、双语说明和许可证。最终用户不需要构建工具。

日常修改只生成 `dist/`；发布、分发或验证 ZIP 安装时再运行 `npm run package` 和 `npm run verify:package`。

`package` 核对产物范围及宿主大小限制，生成平台／架构 ZIP、SHA-256 和文件清单。Windows 按明确的顶层文件／目录打包，避免 `tar -C <目录> .` 生成 `./` 路径，使资源管理器无法读取、Anas 安装器拒绝安装。`verify:package` 直接校验原始条目名，不移除前缀来掩盖问题；Windows 使用独立的 PowerShell `Expand-Archive` 解压，随后核对逐文件摘要、WASM 编译及辅助程序生命周期，macOS 另检查可执行权限和 ad-hoc 签名。ZIP 可直接安装，也可解压后选择 `PLUGIN.json`。`BUILD.json` 记录源码提交及工作区状态、平台、工具版本和依赖锁摘要。Windows x64 完整目录约 13.2 MiB；其他平台不能借用 Windows 辅助程序。

GitHub 工作流只构建一次共享 Web/WASM 与 JavaScript，在三个平台分别构建并检查原生程序，再合并生成通用 ZIP；合并时核对源码及依赖锁、保留全部许可证，并在三个平台重新验证通用包。详见[源码快照与构建流程](SOURCE_PUBLISHING.md)。开发者可运行 `node scripts/setup-build-tools.mjs` 安装固定 Rust 组件并下载校验 wasm-pack；脚本需要预先安装 rustup，非 CI 环境需将输出路径设置为 `WASM_PACK_PATH`。

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

页面仅使用公开 `window.anas` API。后台集中维护 `plugin_data/rdp/profiles.json`：格式版本 0、最多 200 个配置、单文件 1 MiB，配置包含 UUID、revision、名称、目标、`open_mode` 和可选密码密文；证书信任也集中合并，避免不同页面覆盖。写入使用队列和临时文件原子替换，同配置的陈旧 revision 拒绝保存。缺失新文件时从旧 `state.json` 的 `connection` 和 `certificate_trust` 迁移，保留旧文件；已有新文件为空或损坏时不重复迁移或重置。

用户已选择便于备份的轻量密码保护：AES-256-GCM、随机 12 字节 IV、16 字节认证标签、内置版本密钥，AAD 绑定配置 ID。密文对象含 `version`、`iv`、`ciphertext`、`tag`，复制配置时重新加密。它仅避免明文直读，持有插件代码及配置即可解密，不宣称操作系统凭据库的保护能力。未来版本须保留已有版本解密兼容性。应用备份包含该文件，跨机器恢复不依赖用户账户、系统密钥或主密码。卸载默认保留配置，用户在宿主确认框勾选删除数据时一并删除。

列表仅返回 `hasPassword`，页面不回填密码；连接前通过短后台调用读取选定 revision 的密码交给 WASM，成功后清空输入。只有勾选保存时，密码才经短 RPC 送入后台加密；未保存密码只在页面与连接内存中使用。真实值不进入命令行、日志或明文配置。普通打开配置、刷新页面和恢复备份均不自动登录；首页点击「启动」创建按配置 ID 和打开位置绑定的后台内存请求，30 秒失效、一次消费，后台重启不保留。连接页消费请求后使用已保存密码连接，缺少密码时提示输入；活动连接消费重复请求但不重连。配置 revision 变化拒绝旧启动请求。删除配置不强制中断既有连接，但阻止其再次读取密码或重连。

后台最多管理四条连接，每页使用独立 owner 和连接 ID。创建只等待辅助程序准备好入口；认证及持续桌面数据走 WebSocket，不占用长时间 RPC。

辅助程序绑定动态／私有端口范围（49152–65535）的 loopback 端口，避开浏览器禁止的低端口；碰到占用或系统保留区间会有界重试。限定 `anas-plugin://rdp` 来源与 `/rdp` 路径。随机票据采用常量时间比较并绑定目标；拒绝客户端替换目标、提交服务器认证或任意预连接数据。入口 30 秒失效，单次 WebSocket 握手 3 秒，RDCleanPath 请求上限 64 KiB，二进制消息上限 1 MiB；协商及 TLS 总期限 15 秒，写入期限 10 秒。持续流分块、有背压，并用 ping/pong 检查存活。

TLS 默认校验系统信任及名称。不受信任的证书先拒绝并显示 SHA-256，用户独立核对后按主机和端口固定叶证书。已有指纹变化时再次拒绝，不能退回系统信任绕过固定指纹。TLS 签名仍由 rustls 校验，不全局跳过证书验证。

## 生命周期与界面

首页默认侧边栏，已保存的显式位置不覆盖。位置选择位于 Anas「设置 → 插件」中，插件首页不提供重复控件。宿主设置通过通用插件数据接口保存 `home_open_location`，唯一数据源仍为插件自己的 `plugin_data/rdp/state.json`。清单 `home` 声明默认值及允许位置，宿主顶部入口使用 `openHome()`，在页面／后台启动前读取同一配置。保存失败保留原选项并提示；设置仅影响下次打开首页，不修改每台服务器的 `open_mode`、不关闭页面或转移连接。偏好随插件数据备份恢复，卸载默认保留；宿主通用「删除插件数据」选项可删除整个插件数据目录，RDP 不实现删除接口。

首页使用服务器列表，顶部新增／删除／上移／下移；单击选中，悬停或键盘聚焦显示启动／编辑。启动及进入编辑前按配置 ID 重新读取最新列表和 revision，避免连接页保存后，复用的首页仍使用旧快照。已打开的编辑草稿不自动刷新；保存时仍拒绝真正的并发修改。新增和编辑切换为表单，保存后返回列表，取消丢弃草稿。删除明确确认，数组顺序原子保存；移动核对当前相邻 ID，拒绝过时列表中的意外跨项移动，不改变配置内容及 revision。

配置管理页使用 `main` 实例，每个配置 UUID 对应连接页实例。`openView` 按配置选择侧边栏或独立窗口，同一位置重复打开聚焦原页面。每页拥有独立连接，跨位置不转移会话。上游组件处理缩放与输入，插件提供连接、取消、断开、证书提示及错误。连接页右上方显示断开／取消按钮，不再提供配置列表按钮；返回首页使用宿主顶部插件菜单。密码保护说明保留在用户文档，界面不显示常驻页脚。界面使用独立 i18next 26.4.0 实例，与 Anas 共用 JSON 格式和语种匹配规则。包内 `lang/` 含 `version: 0`、`_meta`、`plugin.name/description` 及界面键；宿主新增通用 `getLanguageResources()` 只返回当前插件资源，名称和默认标题由宿主统一翻译。用户在 ZIP 内新增／修改语言文件；可选语种仅由宿主语言包决定，插件语言不参与注册。安装后插件匹配宿主当前语种，宿主没有的语种不显示、不能选择；缺失文字逐项回退英文。语言属于包内容，卸载重装不保留、不合并旧翻译，无独立覆盖目录。插件保留编译时英文作为初始化失败及缺失英文键的回退；在聚焦及每 5 秒通过不重叠的 `getInfo` 短调用读取语言、主题、字号，原地更新而不重连。控件高度为 `max(30px, 字号 + 18px)`。

断开终止 Web 会话并关闭辅助程序 stdin，必要时有界终止子进程。上游会话结束后再次 `shutdown()` 可能抛错，插件仍继续清理传输和界面。关闭页面通过 WebSocket 断开回收；后台退出会关闭 stdin 控制管道，辅助程序自行退出，不能仅依赖正常 `deactivate()`。

桌面容器使用直角，保留输入焦点边框，避免圆角裁切桌面边缘。端口框隐藏步进箭头，保留整数及 1–65535 范围校验。桌面启用上游 `flexcenter`，水平／垂直居中并保持画面比例。固定上游的 fit 算法按整个浏览器视口计算，插件使用实际桌面容器及 canvas 原始尺寸修正 viewer 大小，避免把工具栏／页脚计入可用画面。ResizeObserver 与 canvas 尺寸监听在断开时释放；鼠标继续由上游按 canvas 实际矩形映射。该小型布局适配依赖固定组件的 `.screen-viewer`，升级上游时须重验布局。

停用、卸载、备份和恢复使用宿主已有停止流程，恢复不自动登录。Windows 已验证后台及实际宿主主进程强制退出后的回收；Electron 启动器 PID 可能与实际主进程不同。macOS 必须单独验证。暂不提供活动会话转移、剪贴板、文件传输、多显示器或声音功能。

## 宿主接口与扩展边界

相邻 `../Anas/docs/PLUGINS.md` 是接口说明，源码是最终依据。

| 能力 | 已核对的约束 |
| --- | --- |
| 清单 | `version: 0`、`api_version: 1`；UI 和后台至少一个；`platforms` 不包含 CPU 架构选择 |
| 页面 | `anas-plugin://<id>/`，无 Node 和 `window.gale`；SDK 为 `/_anas/sdk.js` |
| SDK | `getInfo`（含 view）、`getLanguageResources`、`getHome`、`openHome`、`openView`、`data.get/set`、`openExternal`、`backend.call`；暂无系统密码库、剪贴板、通用事件订阅 |
| 后台 | `.cjs` 导出 activate、call、deactivate；上下文含插件 ID、包目录和数据目录 |
| RPC | JSON 1 MiB、最多 32 个待处理请求；后台串行执行，启动及调用含排队均有 30 秒期限 |
| 停止 | 3 秒总预算，清理失败向调用方报告；不承诺回收任意原生后代进程 |
| 数据 | 普通 JSON，单插件 1 MiB；卸载默认保留，可在宿主勾选删除；备份包含，不用于明文密码 |
| 包 | 最多 10,000 项、总计 512 MiB、单文件 128 MiB；安装时不编译 |

仅针对已复现的通用缺口扩展宿主，补齐文档和行为测试。RDP 协议、依赖与专用界面留在此仓库；不扩大 IPC、关闭隔离或向宿主硬编码 RDP。两个仓库独立提交推送，不自动合并或发布 Anas。
