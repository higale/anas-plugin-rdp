# 测试说明

## 当前验证范围

实机测试任务覆盖 Windows x64 和 macOS Intel。Apple Silicon 实机测试已移出任务范围；保留其平台构建，不将 Intel 结果视为 arm64 实测。

### 工具、输入与生命周期

- Windows x64 和 macOS Intel 已分别验证模型连接、查询、截图、断开、独立／跨轮工具调用复用连接、后台展示及页面交接。会话保持同一次认证；原生测试四次重建页面、宿主三次往返通过。模型服务使用受控本地端点，不代表外部视觉模型识别效果。
- 输入验证覆盖动作间隔、完整序列预校验、并发忙碌拒绝、派发前取消、派发后取消等待真实回执、长序列中截图及及时断开。取消不会无条件终止共享后台。页面键鼠与工具按键记录独立，工具 down/up 可跨调用保持；Windows 已检查真实 Ctrl 状态、显式重置键盘和 PAGE_DOWN 翻页。
- Unicode 工具输入已在 Windows x64 和 macOS Intel 客户端核对远端实际内容。2026-10-13 macOS `test:unicode` 通过隔离的 Windows 文本框，对中文、emoji、组合字符、引号、反斜线、4096 个重复字符、1000 个 emoji，以及文本后接 Enter／Ctrl+Enter，逐项比较 UTF-16 长度和 UTF-8 SHA-256。工具成功回执与内容校验分开；这不代表本地输入法组合输入已实现，也不保证所有远端控件以相同方式处理控制字符。
- 本地输入锁覆盖工具和界面入口、迟到快照／回执、旧页面输入拒绝、跨窗口交接及后台恢复。工具仍可输入，手动解锁入口保持可用。明确重置恢复普通键和修饰键并停止待发输入；Windows 实测 Caps／Num／Scroll Lock，Kana Lock 仅核对协议标志。
- 服务器列表定位、编辑／连接互斥、草稿交接、后台恢复、密码保存、停用／卸载及进程退出清理已通过。宿主另在 Windows 验证了历史图片、已删除会话恢复及插件配置备份。

### 剪贴板

- Windows x64：已验证中文／emoji／多行文本双向同步、关闭隔离，3 MiB 文件夹经远端 Explorer 上传后由本机 OLE 虚拟文件接口按需读回，SHA-256、中文路径、文本及空文件通过；传输中关闭共享保护和完成后释放通过。此结果早于多连接活动切换实现，Windows 客户端仍须补多连接验证；OLE 接口验证不替代本机 Explorer UI 粘贴／取消验收。
- macOS Intel：2026-10-13 已验证文本双向同步、关闭隔离，以及暂停同步后仍能在远端 Explorer 粘贴文件夹并正常收尾。32 MiB 二进制和中文／emoji 文本文件分别通过 SHA-256，空文件大小为 0；恢复同步与关闭共享正常。测试后停止连接并恢复本机原有剪贴板格式；32 MiB 样本不代替任意大文件和中途取消验收。
- macOS `test:clipboard-focus` 已通过两个真实 Windows 服务端验证独立共享开关、活动连接同步与后台隔离、侧栏标签／聊天区／悬停／工具栏、独立窗口焦点和最小化、跨窗口交接及后台恢复，会话 ID 不变。
- 2026-10-13 Intel Mac 双连接补充验收：128 MiB 文件在远端 Explorer 上传途中，由后台活动通知将发布权交给另一连接。原连接保持 draining，第二条连接正常同步文本；上传完成后原连接回到 paused，第二条连接的剪贴板未被覆盖。恢复原连接后重新读取远端文件 SHA-256，与本地一致。此专项直接调用正式后台与原生进程，实际窗口焦点判定由上述宿主测试覆盖。
- 同轮 32 MiB 文件在远端 Explorer 点击取消后，复制窗口关闭，未完成文件被移除；另一连接仍可同步文本。原连接约一分钟后由上游闲置锁回收恢复 paused，并能关闭、重新开启共享；取消并不立即释放插件的传输占用。
- 32 MiB 文件实际上传中主动断开，工具返回 closed，对应原生进程退出，另一条连接继续同步文本。
- Finder 按需粘贴远端文件尚未实现，已按用户要求延期，相关下行与取消检查跳过。WebDAV 原型结果和采用障碍见[开发说明](DEVELOPMENT.md#finder-按需粘贴候选方案尚未接入)。图片、富文本尚未实现。

### 界面、构建与交付

- Windows x64 和 macOS Intel 已验证窗口等比缩小、不放大、居中、鼠标坐标、最大化／全屏后恢复，以及包内工具栏图标在明暗主题中的绘制和交接。macOS 固定分辨率实际确认 1024×768、1440×960。
- macOS `test:languages` 已验证宿主语言选择、插件缺失翻译回退、已有页面切换语言和保留草稿、停用／重装语言资源。插件从现行启动菜单打开；所有临时结果写入 `tmp/`。
- 宿主／插件 typecheck、build 和相关行为测试已通过；插件后台／配置 40 项、UI 93 项，以及 Rust 格式检查和严格 clippy 已有通过记录。构建保留 340 项依赖声明。
- 2026-10-13 macOS x64 压缩包已校验 671 个文件的路径、大小、SHA-256、原生程序可执行权限和签名，并通过解压产物的后台／进程生命周期 19 项测试。修复打包清单遗漏 `skills/` 后，声明的技能正文随包保留并验证存在。此检查不代表通用 ZIP 下载后的系统拦截、公证或实际安装验收已完成。

## 剩余边界

- 标题栏文本输入尚未实现。当前补验仅保留 Windows 剪贴板关键行为、断网后的状态与停止清理，具体见[待办](../TODO.md)。其余场景随相关修改或具体问题补充验证。
- macOS 宿主测试曾出现 `PANEL_LOAD_FAILED`；此前联调出现过 `PANEL_ACTION_FAILED`，原生测试也有一次最终画面颜色采样失败。后续复测通过但原因未定位，不视为修复。画面采样已保留采样值及脱敏错误堆栈；通用页面加载／交接问题同时由宿主 TODO 跟踪。
- 原生依赖审计使用 cargo-audit 0.22.2、2026-10-12 RustSec 数据库（`57dcc0f`），2026-10-13 结果退出码 1：`rsa 0.10.0-rc.18` 报 [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)，该次数据库没有修复版本；`atomic-polyfill 1.0.3` 报 [RUSTSEC-2023-0089](https://rustsec.org/advisories/RUSTSEC-2023-0089.html) 停止维护。前者经 picky／sspi／winscard 引入；后者经 heapless → iso7816 → winscard → sspi 引入，本机目标未启用，但完整锁文件仍包含。未添加忽略规则，也未改锁定的 IronRDP 版本。

## 可重复检查

```sh
npm run typecheck
npm run build
npm test
npm run test:ui
cd native
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

- `test:session-tools` 验证工具调用和资源边界；`test:live` 直接检查原生会话与 canvas；`test:host` 使用相邻 `../Anas` 的构建产物和隔离数据，验证实际宿主接入。
- `test:home`、`test:languages` 检查配置界面及语言。`package`、`verify:package` 检查本平台归档及解压后的程序；平台 CI 构建与实机远程操作分开记录。
- `test:unicode` 当前用于 macOS 客户端：通过正式插件工具连接及输入，在远端临时文本框读取真实内容摘要，通过剪贴板返回校验；结束后关闭测试窗口、停止连接并恢复本机剪贴板，不改远端系统配置。
- `test:clipboard` 支持 Windows／macOS，检查文本与本地文件夹上传；可用 `RDP_TEST_FILE_MIB` 指定 1–128 MiB 文件，默认 3 MiB。Windows 另验证虚拟文件下载；macOS 跳过延期的 Finder 下行。测试临时使用两端剪贴板、在远端临时目录创建测试数据。
- `test:clipboard-focus` 当前用于 macOS 双机活动状态验证，使用隔离宿主数据与测试包，结束后恢复本机剪贴板并停止连接。

实机脚本读取 Git 忽略的 `.local/rdp-test.json`；双机脚本另读 `.local/rdp-test-2.json`，只复用已核对的证书指纹，不自动信任新证书。与其他真实桌面／剪贴板操作串行执行。凭据和证书保留在 `.local/`，日志、截图、结果及打包中间文件写入忽略的 `tmp/`；相关任务结束后可整目录删除，脚本按需重建。

修改宿主时执行其相关行为测试、typecheck、build 和 `node scripts/electron-plugins.cjs`；涉及启动响应性时使用 `npm run test:e2e -- --startup-only`。
