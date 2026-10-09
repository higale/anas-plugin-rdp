# Anas RDP 插件

[English](README.en.md)

在 Anas 侧边栏或独立窗口使用 Windows 远程桌面。固定版本的 IronRDP 原生引擎在插件后台持有连接和画面，页面只负责 canvas 展示与键鼠输入，无需另行部署网关。

RDP 0.1.7 需要 **Anas 3.3.8 或更新版本**（插件 API 2）。请先升级宿主，再安装插件；旧版宿主不支持新的页面交接和指定实例移动接口。

移动页面会重建展示界面，保留原连接和未保存输入；编辑页的「后台运行」默认关闭，关闭桌面即断开连接；勾选后关闭桌面保留连接，列表可「恢复桌面」或右键断开。右键可选择侧边栏或独立窗口启动／恢复；成功打开或移动后记住位置，后台桌面恢复也使用该位置。连接页与编辑页互斥；后台运行时禁止编辑和删除。点击「断开」、停止插件后台或退出宿主都会结束连接。

## 使用

在 Anas「设置 → 插件」安装 ZIP，或选择完整目录中的 `PLUGIN.json`。从顶部插件菜单添加服务器、选择打开位置，双击条目或点击「启动」连接。编辑配置与连接页面分开，保存不启动连接，连接不隐式保存配置。安装、密码保护、证书和语言配置见随包[用户说明](docs/USER_GUIDE.md)。

最多保存 200 个服务器配置、同时保持 4 条连接。提供基本键鼠输入；本地输入法组合输入尚未支持，远端输入法、复杂快捷键、高 DPI 和长时间运行仍需专项验证。暂不提供剪贴板、声音、文件传输或多显示器。

已在 Windows x64 的真实 Anas 中验证页面往返移动、后台连接恢复，以及默认关闭桌面断开、勾选后台运行后保留连接。macOS x64 此前验证过页面交接架构，本次后台运行选项及服务器列表定位尚未在 macOS 复核；Apple Silicon 原生 arm64 实机验收仍待完成。

## 开发

需要 Node.js 24 与 Rust 1.94.1。IronRDP 固定提交见 `upstream.lock.json`，依赖锁见 `native/Cargo.lock`。

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:ui
```

`dist/` 为本平台可安装目录；日常不生成 ZIP。分发时运行 `npm run package` 和 `npm run verify:package`。CI 分别构建公共 UI、三平台原生程序并合并通用 ZIP，保留依赖许可证。

[技术方案](docs/DEVELOPMENT.md) · [测试说明](docs/TESTING.md) · [发布流程](docs/SOURCE_PUBLISHING.md) · [待办](TODO.md)
