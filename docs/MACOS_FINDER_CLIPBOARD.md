# macOS Finder 文件粘贴：验证记录与后续实现

首次记录：2026-11-17；更新：2026-11-18。状态：**本轮验证已结束，Finder 粘贴方案暂不接入产品，保留 Anas 显式下载**。

2026-11-17 用户要求先记录，等待本项目另一个 agent 完成当前修改后，再开始实现，当时只新增本文档。2026-11-18 用户要求检查更新并按本文开始处理；已确认本地与远端均为 `939a740`，双向文件拖拽已回退，本文保留。当前基于原有剪贴板及显式下载实现继续验证，不恢复已回退的拖拽代码。

## 2026-11-18：取消边界与当前决定点

按后续计划先验证 Finder 取消，发现原型不能直接接入产品：

- 将内容准备延长到约 20 秒，Finder 显示“正在准备拷贝”；实际点击其“停止进程”按钮。
- 原型没有收到取消通知，仍执行到内容准备完成。`NSProgress.currentProgress` 为 `nil`；显式发布源文件 URL 对应的可取消 `NSProgress`，也未收到该次 Finder 停止操作的取消回调。
- 256 KiB 占位文件的目标副本长度相同但内容不匹配；零字节占位的目标留下了零字节文件。上述结果说明必须保护尚未准备好的内容，不能仅依赖读取协调回调。
- 本轮验证的改进为：读取回调开始时先打开专用写句柄，再暂时去除占位文件的读写权限；只经已打开句柄写入，内容完整并同步后恢复权限、放行读取。通过路径重新打开写入会受权限限制，不能沿用原型的普通整文件写入方式。
- 改进后的正常 Finder 粘贴已通过：20 秒准备后，目标 256 KiB 内容逐字节一致。随后使用唯一文件名定位 Finder 对应任务，并按同一行的“停止进程”按钮复测：未保护版本仍留下 0 字节目标；保护版本未生成目标文件，但仍继续准备内容，未触发下载取消。
- Finder 会在同一个进度窗口保留旧错误项，不能用固定按钮序号判断取消结果。中间几轮存在选错任务的干扰，不计入验收；上述结果以 `cancel-matched.mjs` 的唯一文件名及对应按钮位置验证为准。

用户已明确交互要求：进度显示与取消必须由同一处负责；Finder 粘贴应由 Finder 显示进度并取消，不采用 Finder 显示进度、Anas 另设取消入口的混合方案。继续研究两个现有客户端及系统 API 的取消传播，当前原型未收到取消不能作为无法实现的结论。

进一步只读检查了本机客户端的方法调用关系：RDM 的文件请求取消状态可由请求对象销毁触发；Windows App 的 presenter 写入协调回调关联下载取消。这些入口尚未证明由 Finder 的停止按钮触发，不能仅凭 `Cancel` 方法名推断已找到取消链路。给原型补充写入协调、删除及内容变化回调后，点击对应 Finder 任务停止按钮仍未观察到写入／删除通知。

Windows App 与 RDM 的人工取消对照均已完成一轮：Finder 立即结束，但目标留下部分内容，客户端缓存继续准备至完成。详见下文的监测、系统日志与完整内容校验。两者都不能作为“Finder 立即结束即远端下载已取消”的成功基线。

后续验收固定为：Finder 提供进度和停止入口；分别在准备、内容传输和最终复制阶段取消，核对远程读取、缓存写入、传输占用及目标文件。若 Finder 停止后后台仍继续下载或目标留下未完成内容，不算取消链路通过。当前正式源码与构建产物未因本轮调查而修改。

前述原型是本机模拟 Finder 测试，不代表本插件的真实 RDP 取消、断线和大文件已经通过。权限保护也未证明可以覆盖首次回调前的非协调读取、进程强杀等全部边界。

临时复现文件位于 `tmp/clipboard-presenter/`：`cancel-probe.m`、`progress-probe.m`、`protected-probe.m`、`progress-unique.m`、`protected-unique.m`，以及 `protected-normal.mjs`、`cancel-matched.mjs`。早期 `cancel.mjs`、`cancel-progress.mjs`、`cancel-zero.mjs`、`cancel-protected.mjs` 的固定按钮定位不可用作最终取消验收。仍遵循后文的剪贴板、Finder 操作及不并行运行要求。

### Apple 文档与独立进程对照

重新核对官方文档并在本机运行独立的 presenter、reader 和 progress subscriber 进程，避免把 Finder 自动化是否成功与 API 行为混在一起：

- [`NSFileCoordinator.cancel()`](https://developer.apple.com/documentation/foundation/nsfilecoordinator/cancel())：尚未进入读取／写入 accessor 时，取消使协调调用停止等待并返回 `NSUserCancelledError`；已经进入 accessor 时，需要等待该代码结束。文档没有承诺取消提供方正在进行的内容准备。
- [`relinquishPresentedItem(toReader:)`](https://developer.apple.com/documentation/foundation/nsfilepresenter/relinquishpresenteditem(toreader:))：调用传入的 reader 才放行读取；传给 reader 的 reacquirer 表示读取结束后的重新取得访问权，不是独立的准备阶段取消通知。
- [`Progress.publish()`](https://developer.apple.com/documentation/foundation/progress/publish()) 与 [`addSubscriber(forFileURL:withPublishingHandler:)`](https://developer.apple.com/documentation/foundation/progress/addsubscriber(forfileurl:withpublishinghandler:))：允许其他进程按文件 URL 发现进度；[`Progress.cancel()`](https://developer.apple.com/documentation/foundation/progress/cancel()) 会调用其取消处理器。这不能单独证明 Finder 的拷贝任务自动关联了该进度。

实测结果：

| 场景 | 读取方结果 | 提供方结果 |
| --- | --- | --- |
| 正常协调读取 | 等准备完成后读到完整 17 字节样本 | 完成准备后收到 reacquirer |
| 准备中调用 coordinator.cancel，使用 WithoutChanges | 约 0.53 秒返回错误 3072；accessor 未执行 | 约 3.5 秒才完成准备，此后才收到 reacquirer；未收到进度／操作队列取消 |
| 准备中取消，使用默认读取选项 | 同样返回 3072，accessor 未执行 | 准备结束后仍收到 save 回调；未收到准备取消 |
| 已进入 accessor 后调用 cancel | accessor 持续到约 3.1 秒，读取成功 | accessor 结束后收到 reacquirer |
| 第三个进程订阅发布的 NSProgress 并调用 cancel | 仅用于验证取消传播，不作粘贴成功验收 | 收到 cancellationHandler，停止模拟准备并删除自己的占位文件 |

这些结果与文档所述协调取消行为一致，证明跨进程 Progress 取消通道可用，也证明不能把 coordinator 取消自动等同于下载取消。**它们不是 Finder 或真实 RDP 的取消验收。** 随后的人工 Finder 复核见下文。

本轮独立程序及结果位于 `tmp/clipboard-api/coordination.m`、`run.py`、`results.json`；仅属可丢弃实验，不进入正式实现。

五组对照已补充行为断言并重新运行通过。准备人工 Finder 测试时，自动发布剪贴板的版本在约 4 秒后、收到人工操作反馈前就触发了读取；请求方尚未确定，该次不计入人工取消测试。已改为仅注册 presenter，由用户在 Finder 手动复制源文件，再粘贴并停止。该现象也说明发布后可能被其他读取者提前触发，不能仅靠“尚未粘贴”推断未下载。

### 用户手动 Finder 取消复核

首轮用户反馈没有进度；检查发现目标是此前已准备好的 17 字节文件，无法用于取消验收。随后创建全新 `manual-round2` 目录，仅注册 presenter、不主动写入剪贴板，模拟 45 秒准备。用户手动复制 `source.bin`、进入空目标目录粘贴，确认出现进度并点击停止；随后反馈 Finder 显示“正在停止”，刚刚结束。

本轮日志：63.971 秒开始准备，109.292 秒完成准备，共约 **45.321 秒**；109.295 秒收到 reacquirer。期间没有 Progress 取消、操作队列取消、写入协调或删除回调。用户反馈已停止时目标尚无文件；准备结束后目标出现完整 17 字节样本。这次人工复核证实：当前原型未能及时取消准备，且取消后仍可能产生目标文件，不能接入产品。它不证明其他客户端或其他系统接口也存在相同行为。

日志保存在 `tmp/clipboard-api/manual-round2/events.log`。人工测试完成后已停止该原型进程；没有新增真实 RDP 或 Windows 平台测试。

### File Provider 独立扩展验证（已排除）

Apple [`fetchContents(for:version:request:completionHandler:)`](https://developer.apple.com/documentation/fileprovider/nsfileproviderreplicatedextension/fetchcontents(for:version:request:completionhandler:)) 明确规定：系统或用户取消下载时，系统调用返回的 Progress 的 cancel；扩展据此停止获取并通过完成回调报告取消。这是另一个候选接口，不代表 Windows App 或 RDM 使用该方式，也尚未决定用它替代当前插件架构。

已在 `tmp/fileprovider-probe/` 构建独立 `.app` 和嵌入的 `.appex`，只提供 1 MiB 本地模拟内容，准备耗时约 30 秒；未接入 RDP。使用临时签名、插件注册及 Launch Services 应用登记后，`NSFileProviderManager.addDomain` 返回成功，系统创建独立测试目录。只登记 `.appex` 而未登记所属应用时，曾返回 providerNotFound／applicationExtensionNotFound；补齐应用登记后消失。

本轮系统返回 `userEnabled=false`，未执行扩展的内容获取。该状态下取消协调读取返回 3072，不能计为扩展下载取消成功。用户明确不采用需要安装系统扩展的方案，因此停止该路线；已通过 Manager 移除本实验 domain、注销本实验 app／appex，并确认测试 CloudStorage 目录消失。未启用扩展，不动其他提供方。

本机 SDK 还明确说明，File Provider Manager 可由扩展、所属主应用及其包内可执行程序调用。但生命周期、系统启用步骤、分发签名及插件卸载清理均未通过验收；该路线已不在用户接受的实现范围内，不据此新增 Anas 宿主接口。后续回到不安装系统扩展的文件协调路线，以现有客户端的真实行为作对照。

### Windows App 人工取消：界面立即结束，缓存仍完成下载

使用专用测试主机创建 256 MiB 样本：一个随机的 1 MiB 数据块重复 256 次，远端大小回读为 268435456 字节。恢复 Windows App 连接后，用户手动复制、在 Finder 粘贴并点击停止，反馈进度立即结束，随后看到目标文件存在。

2026-11-18 本机时间（Asia/Shanghai）的系统日志与文件校验结果如下：

| 时间／对象 | 已确认结果 |
| --- | --- |
| 11:55:19.015 | Windows App 收到 `relinquishPresentedItemToReader:`，开始准备文件 |
| 11:55:23.473 | Finder 调用协调取消；系统记录该 claim 在 accessor 执行前取消 |
| 11:55:23.480 | 目标文件最后修改。逻辑长度 256 MiB，实际只有前 63.75 MiB 内容，余下 192.25 MiB 为零；完整 SHA-256 与源缓存不符 |
| 11:55:24–38 | 同一个 presenter 持续记录源文件变化 |
| 11:55:38.819 | 源缓存最后修改，Windows App 移除 presenter 并放行／重新取得读取协调，距 Finder 取消约 15.35 秒 |
| 完成后的源缓存 | 实际分配 256 MiB；256 个 1 MiB 块均与样本数据块一致，完整 SHA-256 为 `9375420d965b8168955910931c752917a9f8869d75b98f030a109e21e444f323` |

目标完整 SHA-256 为 `4d268361e9ae9ee6fa4b3c7d5e019561490e2985000037299195192adef6c15b`。复查目标的修改时间及已分配空间不变。**目标显示原文件大小不代表复制完成；本轮 Finder 停止后留下不完整副本，而 Windows App 继续将源缓存准备完整。** 因此，“Finder 进度立即结束”不能用来证明远端读取已取消，也不能将该客户端视为完整取消链路的成功基线。此结论限于本次版本和操作，不外推 RDM 或所有情形。

原先的缓存／NSProgress 监测设有 10 分钟期限，在本次人工操作前已退出；本轮证据来自保留的系统日志及事后源／目标完整内容校验，不能声称逐次网络请求或 Progress 取消已被捕获。此前自动化还发生过远端剪贴板被替换、`dataNotAvailable` 后复制全零占位文件的干扰，已排除出本轮人工验收。

依据位于 `tmp/clipboard-inspection/windows-manual-system.log`、`windows-target-verification.json`、`windows-source-verification.json`；样本准备与元数据见 `prepare-verified.mjs`、`comparison-test.json`。保留本次目标用于对照，不改动客户端缓存；远端专属临时样本待全部对照结束后清理。

### RDM 人工取消：同样留下部分目标，后台继续约 4 分 26 秒

使用同一测试主机和 256 MiB 样本。用户连接 RDM 后，使用全新空目录 `rdm-paste` 进行一次手动复制、粘贴、停止，反馈立即结束。此次缓存监测覆盖复制、取消及取消后持续写入过程，并用系统日志、最终完整校验补齐收尾证据。

- 12:07:57.554，RDM 的 `FreeRDPSandboxed` 进程收到读取协调回调。
- 12:08:04.794，Finder 的对应 claim 在 accessor 执行前取消。目标出现逻辑长度 256 MiB 的文件，实际仅前 **7.625 MiB** 与样本匹配，其余 **248.375 MiB** 为零；之后未继续更新。
- 取消后缓存连续增长。12:12:19 达到完整分配大小时内容尚未完整，不能把磁盘分配量作为下载完成信号。
- 12:12:30.696，源缓存最后写入；12:12:30.733，RDM 放行读取并收到 reacquirer。距 Finder 取消约 **265.94 秒**。最终缓存完整 SHA-256 与 Windows App 的完整缓存及已知样本模式一致，目标 SHA-256 为 `103585c8600c9724576dc340f9a9f30eb40383631543947b4e9aba68c6cb473e`，明确不一致。

结论限于本机 RDM 2026.1.11.4 的这轮测试：**Finder 停止未中止后台内容准备，且留下不完整目标**。与前述方法体等待路径及原型观察相符，不能将其描述为已实现完整取消传播。没有修改 RDM 配置或代码。

记录位于 `tmp/clipboard-inspection/rdm-round-1/events.jsonl`、`system-final.log`、`verification.json`。监测在末段达到完整分配后结束；最终内容完成时刻另由系统日志、文件修改时间及稳定的完整哈希确认。辅助程序为 `watch-round.m`、`verify-round.py`，均未接入产品。

### 无扩展 WebDAV 补测：取消可中断读取，但存在明显等待

在两个客户端对照结束后，使用 macOS 自带 `mount_webdav` 对本机只读模拟服务做 Finder 实测，不安装扩展、不连接远程主机。该路线需要临时挂载，不等同于直接采用文件 presenter。服务仅监听 loopback，使用随机路径，只提供一个 64 MiB 样本；以每 50ms 写出 32 KiB 的方式模拟慢速读取，记录每个请求及连接关闭。旧实验仅用终止 `cat` 验证过读取停止，本轮改为真实 Finder 粘贴及对应任务的停止按钮。

- 发布文件 URL 前后未出现 GET；Finder 粘贴后才开始内容请求。
- 点击对应 Finder 任务的停止按钮后显示“正在停止”；约 **38.04 秒**后 HTTP 请求关闭，已发送 **32 MiB + 64 KiB**，未发送完整 64 MiB，之后无新请求。目标文件不存在，未留下 presenter 路线中的稀疏残缺副本。
- 不取消的再次 Finder 粘贴成功，目标 67108864 字节，完整 SHA-256 与预期一致：`6aac0035f68c4c4b59ec5b2c5131c58af1f2ac254640d78331a28e31447b17d1`。
- 停止发生在 32 MiB 边界附近，但本机实测源卷及目标卷 `statfs.f_iosize` 均为 1 MiB。Apple [copyfile 源码](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.c)允许调用方覆盖读取缓冲大小；目前尚未证实 Finder 本轮所用内部缓冲设置，也未找到可由插件缩短这次等待的公开控制方式，不能把 32 MiB 当成服务端可调参数。

这组本机测试证明了另一条能停止内容读取并清理目标的通路，同时证明本次慢速条件下取消明显延迟。**尚不能作为及时取消的产品实现**；真实 RDP、失败／超时、未知大小、并发、挂载回收和宿主异常退出等边界未通过。未修改插件或宿主正式代码，不因此宣称 Finder 功能已交付。

程序位于 `tmp/clipboard-inspection/webdav-finder.mjs`，本轮日志及结果位于 `tmp/clipboard-webdav/finder-round-1/`。测试结束清除仍由本实验持有的文件 URL，并卸载临时挂载、停止本地服务；保留本机结果供复查。

## 结论与现状

远程文件复制后，在 macOS Finder 中直接粘贴的路线可行。使用 `NSFilePresenter` 协调读取回调，在放行 Finder 读取前完成远程内容准备，已通过本机模拟及真实 RDP 单文件验证。

现有产品已能通过 CLIPRDR 接收文件清单和分块读取内容。`native/src/clipboard.rs` 收到 `Event::Files` 后，Windows 发布 OLE 虚拟文件对象；macOS 只调用 `downloads.offer`，供显式下载使用。缺失的是 Finder 粘贴适配，并非 RDP 协议或 macOS 无法支持。

当前显式下载的实际行为仍以 [开发说明](DEVELOPMENT.md#macos-显式下载) 为准。本文不代表 Finder 功能已经交付，也不决定是否保留现有下载按钮。

## 本地客户端分析

只读检查了以下已安装应用的字符串、Objective-C 类信息及方法符号，没有修改应用包，也没有取得其完整源码。

| 应用版本 | 与文件粘贴有关的证据 |
| --- | --- |
| Windows App 11.4.1 | `RDCFilePresenter` 实现 `NSFilePresenter`，包含 `relinquishPresentedItemToReader:`、`relinquishPresentedItemToWriter:` 和 `savePresentedItemChangesWithCompletionHandler:`；关联 `fileSaveOperationHandler`。`SessionPasteboardFileSaveOperation` 保存 presenter 集合、文件集合、目标 URL 和取消状态。 |
| Remote Desktop Manager 2026.1.11.4 | `Devolutions_Rdp_Native_PasteboardFileContentsRequest` 实现 `NSFilePresenter` 及 `relinquishPresentedItemToReader:`；`Devolutions.Rdp.macOS.dll` 包含文件请求容器和剪贴板数据提供者相关符号。 |

这些证据确认文件协调机制参与其实现，但不证明其完整下载、取消、失败或缓存算法。不要把符号推断写成已还原的实现。

后续只读方法体检查补充：Windows App 的 `fetchAndSaveFiles` 调用 Promise 等待封装，该封装内部创建并等待 dispatch semaphore；RDM 的读取回调等待 `ManualResetEventSlim`。两者均存在等待内容准备的路径，不支持“改成异步派发本身就能获得 Finder 取消”的推断。取消触发条件仍以真实对照为准，未将对方实现复制进产品代码。

[RDM 官方 2022 年说明](https://devolutions.net/blog/copy-paste-in-and-out-of-embedded-rdp-sessions-for-rdm-mac/) 描述了临时占位文件及粘贴时下载的路线；文章当时的限制不应直接套用到当前版本。[Apple NSFilePresenter 文档](https://developer.apple.com/documentation/foundation/nsfilepresenter)说明了读取协调接口。

## 已完成的验证

环境：本机 macOS 26.7.3，Intel x86_64。记录时插件 HEAD 为 `71952a9`，相邻 Anas HEAD 为 `71a0a7ae`；原型未修改这两个仓库的正式实现。真实 RDP 测试调用当前本机构建的原生 helper，未另外验证该二进制与上述 HEAD 的逐项对应关系。

### Finder 本机模拟

独立原生进程初始化 AppKit，在测试专用目录创建占位文件，注册 `NSFilePresenter`，将文件 URL 写入系统剪贴板并持续运行事件循环。测试通过 Finder 的实际“粘贴”菜单触发，而非用 `cp` 或程序文件复制替代。

- 占位大小分别为 0、1 和 262144 字节；粘贴前均未触发内容准备。
- 点击粘贴后收到读取协调回调；模拟等待 2 秒，再写入 256 KiB 内容并放行读取。
- 三种情况下 Finder 目标文件均与预期逐字节一致。
- 多项目测试覆盖一个顶层文件，以及含中文／emoji 文件名和空文件的文件夹；结果均一致。
- 模拟内容准备失败时，原型删除自己的占位源文件后放行读取，目标目录未出现成功粘贴的空文件。尚未确认 Finder 是否提供了充分、稳定的错误提示，不能据此宣称产品级失败处理通过。

观察到的回调序列为 `READY → READ → FETCH_BEGIN → FETCH_END → READ_DONE`。本轮实际粘贴走的是读取回调，未观察到保存回调触发；两种回调的职责仍需在正式实现前明确。

### 真实 RDP 到 Finder

使用用户新提供的临时主机，未使用另一个 agent 正在占用的原测试主机。凭据不写入本文或测试日志；独立配置与已存证书信任见下文。

1. 通过现有原生 helper 建立 RDP 连接并开启剪贴板。
2. 在远端唯一命名的临时目录创建 16 MiB 测试文件，并发布远端文件剪贴板清单。
3. 收到清单后暂停主动剪贴板同步，保留发布权与文件读取能力，模拟用户切到 Finder。
4. 原型发布本地占位文件；等待期间确认尚未开始下载。
5. Finder 读取回调触发后，测试控制器调用现有 `downloadStart`，通过 CLIPRDR 下载到独立 staging 目录。
6. 下载完成后，原型将内容写入占位文件，再放行 Finder 读取。
7. Finder 最终目标文件为 **16777216 字节，SHA-256 与预期一致**。

测试结束后关闭 helper、恢复本机剪贴板并关闭本轮 Finder 测试窗口；已发送删除远端专属测试目录的命令，未另做远端删除结果回读。

此原型验证了完整传输路径，但其中控制器轮询下载状态、文件标记通知以及整文件读入内存均为实验实现，不是产品设计。它也不是对 Windows App 或 RDM 方法体的复刻。

## 原型位置与复现

临时文件均在忽略的 `tmp/`，可被清理，不应成为正式实现或文档结论的唯一依据。

| 路径 | 用途 |
| --- | --- |
| `tmp/clipboard-inspection/windows-objc.txt`、`rdm-objc.txt` | 本地应用 Objective-C 信息，包含符号分析依据 |
| `tmp/clipboard-presenter/probe.m` | 本地内容、模拟失败和多文件的 presenter 原型 |
| `tmp/clipboard-presenter/run.mjs` | 三种占位大小的 Finder 实测 |
| `tmp/clipboard-presenter/boundaries.mjs` | 模拟失败、中文／emoji 文件夹及空文件验证 |
| `tmp/clipboard-presenter/remote-probe.m` | 等待真实远程内容准备后放行 Finder 的原型 |
| `tmp/clipboard-presenter/remote.mjs` | 原生 RDP 会话、远端样本、Finder 粘贴与哈希校验 |
| `tmp/clipboard-presenter/remote-6476c4bc-7890-4fb9-9764-90e795139502/result.json` | 本轮真实 RDP 成功记录 |

临时测试主机使用 `.local/rdp-clipboard-test.json` 和 `.local/rdp-clipboard-trust.json`，未覆盖 `.local/rdp-test.json`。复测前确认临时主机仍可使用，按现有证书验证规则检查信任，不自动接受新证书或回退到其他 agent 的主机。不要输出配置内容。

原型保留时，可在仓库根目录执行：

```sh
clang -fobjc-arc -framework AppKit tmp/clipboard-presenter/probe.m -o tmp/clipboard-presenter/probe
node tmp/clipboard-presenter/run.mjs
node tmp/clipboard-presenter/boundaries.mjs
clang -fobjc-arc -framework AppKit tmp/clipboard-presenter/remote-probe.m -o tmp/clipboard-presenter/remote-probe
node tmp/clipboard-presenter/remote.mjs
```

这些测试会操作本机系统剪贴板、激活 Finder，并通过辅助功能权限点击粘贴菜单；真实 RDP 测试还会在专属远端临时目录创建和删除样本。不要与其他操作系统剪贴板或同一远端桌面的测试并行运行。脚本依赖 `.local/clipboard-macos-probe/preserve` 保存／恢复剪贴板。

## 尚未证明的边界

**Finder 成功不等于任意文件读取都安全，也不等于所有情况下只在粘贴时下载。** 不参与文件协调的读取者仍可能读到空占位文件；预览、索引、杀毒或第三方剪贴板管理器可能提前请求读取。此前原型的这类问题不能因本次 Finder 成功而忽略。

尚需验证：

- Finder 取消是否能停止远端读取、释放占用，并清理部分内容；不能以取消普通读取进程代替。
- 真实断线、超时、磁盘不足、文件消失、helper 退出时，Finder 是否明确失败且不留下伪成功文件。
- 更大文件、慢速网络和背压；正式实现须分块写盘，不能把整个文件装入内存。
- 真实 RDP 多文件、嵌套文件夹、未知大小、空文件；本轮真实 RDP 只测了单个 16 MiB 文件。
- 重复粘贴、并发读取、远端重新复制、本机剪贴板替换、多连接活动切换与协议锁回收。
- 侧栏／独立窗口交接、关闭展示、断开、停止、停用、卸载和宿主异常退出的清理。
- Finder 同名冲突、覆盖、重命名、取消与现有显式下载冲突策略的关系，避免擅自改变行为。
- Apple Silicon 和其他受支持 macOS 版本；本轮仅验证 Intel 当前系统。

## 恢复开发后的建议顺序

1. 仅在重新启动 Finder 粘贴开发时，重新阅读工作区、`AGENTS.md` 和剪贴板最新实现，确认其改动范围。
2. 优先验证上述失败、取消和非协调读取边界，明确占位文件方案可接受的适用范围。不要根据单次成功直接接入产品。
3. 在本仓库原生层设计 macOS 文件剪贴板适配，复用现有 CLIPRDR 分块读取、锁 ID、发布代次和传输占用；目前没有证据要求增加宿主专用接口。
4. 每批复制使用隔离路径，固定原文件清单和连接身份；新发布不替换在途读取的数据来源。设计回调完成、缓存回收、连接终止及失败唤醒机制，避免阻塞协议事件循环。
5. 实现后执行对应行为测试、类型检查、构建，以及真实 Electron 侧栏、独立窗口和停止验证；补齐中英文用户文档。是否保留显式下载入口另行确定。
6. 功能落地后，将有效实现与测试结论合并进 `DEVELOPMENT.md`、`TESTING.md`，清理本文中的待办及过时原型说明，避免长期维护重复报告。
