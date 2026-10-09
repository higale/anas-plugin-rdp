# 测试说明

## 当前验证范围

2026-10-09，当前实现已在 Windows x64 验证：

- UI 77 项、后台／配置 25 项测试通过；覆盖后台运行、连接生命周期、服务器列表定位与编辑草稿保留、侧栏和窗口按钮一致性。
- 0.1.7 发布准备已通过 Rust 格式检查、workspace 测试及 clippy；Windows x64 ZIP 已完成独立解压、文件摘要和原生进程生命周期验证。
- 类型检查和构建通过；`test:home` 在真实 Electron 中验证编辑选项，以及正在连接时关闭侧边栏桌面／独立窗口：默认停止资源，勾选后保留；两种位置的「服务器列表」入口均定位当前条目，侧栏断开使用图标按钮。
- `test:host` 在真实 RDP 连接上验证往返移动、勾选后关窗和恢复同一会话、外部删除配置后的交接，以及默认未勾选时移动不重连、关闭窗口结束连接。

宿主新增通用 `list` 图标的 DOM 测试、类型检查、lint 与构建通过。宿主全量 `electron-plugins.cjs` 在 Windows 默认 150% 缩放下通过，覆盖插件覆盖安装、抽屉缩放、页面交接和实例复用。尺寸测试按物理像素处理边框取整，并在保存后比较实时几何位置。RDP 的 `test:home` 在默认缩放下通过。

macOS x64 此前验证过页面交接、租约、完整画面和基本输入；本次后台运行选项及服务器列表定位／工具栏调整尚未在 macOS 实机复核。Apple Silicon 原生 arm64 验收仍待完成。本地输入法组合输入尚未支持；远端输入法、完整快捷键、高 DPI、高刷新性能和长时间稳定性仍待专项验证。

本轮真实联调曾出现一次 `PANEL_ACTION_FAILED`，尚未确定原因；加入阶段诊断后连续九次往返通过，移除诊断包装后原始源码三次往返及原生会话测试也通过。修复回退边界后，本次三次往返加删除配置后往返的实机复核也未复现；尚不能将这次偶发失败归因于已修复问题，长期运行验收继续观察。

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

`npm run test:live` 直接检查原生会话与 canvas。`npm run test:host` 使用相邻 `../Anas` 的已构建产物，安装临时插件到隔离数据目录。测试主机从忽略的 `.local/rdp-test.json` 读取，证书只复用事先核对的指纹，不自动信任新证书。测试不输出凭据；运行记录放 `.local/`，不提交。

`npm run test:home` 和 `npm run test:languages` 检查配置界面及语言；`npm run package`、`npm run verify:package` 检查本平台归档及原生程序启动／退出。CI 构建和实际远程交互属于不同验证范围。

修改宿主同时执行其相关行为测试、typecheck、build、`node scripts/electron-plugins.cjs`。涉及启动响应性时运行 `npm run test:e2e -- --startup-only`。
