# Anas RDP v0.1.3

## 简体中文

需要 **Anas 3.3.4 或更新版本**（插件 API 1）。下载 anas-rdp-0.1.3-universal.zip，从 Anas「设置 → 插件」安装 ZIP，或选择完整解压目录中的 PLUGIN.json。同一个 ZIP 支持 Windows x64、macOS Apple Silicon 和 Intel，无需安装 Rust 或 Node。

- 新增多服务器配置、复制、删除及排序。首页默认在侧边栏显示服务器列表，悬停或键盘聚焦即可启动或编辑；每台服务器可独立选择侧边栏或窗口。
- 可选保存密码，随 Anas 备份跨机器恢复。密码使用内置版本密钥的 AES-GCM，仅避免明文直读；持有配置和插件即可解密。未保存的密码仅用于当前连接。已有单服务器配置自动迁移。
- 首页打开位置在宿主「设置 → 插件」中设置，保存到插件配置；卸载默认保留数据，宿主确认框可勾选删除数据。
- 名称和界面采用 i18next JSON 语言包并跟随宿主。可在 ZIP 的 lang/ 中新增或修改翻译，仅宿主已有语种可用；重装使用新包，不保留旧翻译。
- 修复连接页保存后从旧首页启动产生的配置冲突；真实并发编辑仍保留冲突保护。远程桌面居中、等比缩放，容器使用直角；断开／取消移至页头，端口框隐藏步进箭头。
- 修复 ZIP 条目路径，使 Windows「全部解压」及 Anas 安装器可读取。下载项仍只有通用 ZIP 和 SHA256SUMS.txt；仅原生辅助程序分别构建三平台。

Windows 已验证真实 Anas／RDP 的配置保存、认证、画面、基本输入、证书信任、取消、断开及退出回收。发布须通过三平台构建和通用包检查；macOS 实机 RDP 验证仍由用户完成，辅助程序仅 ad-hoc 签名，未公证。

仍为预览版。中文输入、完整键鼠兼容性和长期稳定性待专项验证；暂不提供剪贴板、音频、文件传输、多显示器或活动会话转移。GitHub 自动提供的 Source code 下载属于源码，不是插件安装包。

## English

Requires **Anas 3.3.4 or later** (plugin API 1). Download anas-rdp-0.1.3-universal.zip and install the ZIP from Anas Settings → Plugins, or select PLUGIN.json inside the complete extracted folder. The same ZIP supports Windows x64, Apple Silicon Macs, and Intel Macs. Rust and Node are not required.

- Add multiple server profiles, copying, deletion, and ordering. The home page defaults to a sidebar server list with Start and Edit on hover or keyboard focus; each server independently opens in a sidebar or window.
- Optionally save passwords and restore them across machines through Anas backups. AES-GCM uses a built-in versioned key to conceal plain text; anyone with the configuration and plugin can decrypt it. Unsaved passwords are used only for the current connection. Existing single-server settings migrate automatically.
- Set the home page location in the host's Settings → Plugins; the preference belongs to plugin configuration. Uninstalling keeps data by default, with an optional host checkbox to delete it.
- Names and UI use i18next JSON language packs and follow the host. Add or edit translations in the ZIP's lang/ directory; only host-supported languages are available. Reinstallation uses the new package without retaining old translations.
- Fix stale home pages reporting profile conflicts after saves in a connection page, while retaining protection against actual concurrent edits. Center and proportionally scale the desktop with square container corners; move Disconnect/Cancel to the header and hide port steppers.
- Fix archive entry paths for Windows Extract All and the Anas installer. Downloads remain one universal ZIP and SHA256SUMS.txt; only native helpers are built separately for the three platforms.

Windows verification covers profile persistence, real Anas/RDP authentication, rendering, basic input, certificate trust, cancellation, disconnection, and process cleanup. Publication requires three-platform builds and universal package checks. Real macOS RDP validation remains with the user; helpers are ad-hoc signed and are not notarized.

This remains a preview. Chinese input, full keyboard/mouse compatibility, and long-term stability need dedicated verification. Clipboard, audio, file transfer, multiple displays, and active session transfer are not provided. GitHub's automatic Source code downloads are not installable plugins.
