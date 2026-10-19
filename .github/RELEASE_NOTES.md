# Anas RDP v0.1.10

## 简体中文

需要 **Anas 4.0.4 或更新版本**（插件 API 2）。文件下载使用宿主新增的目录选择与文件定位接口，请先升级 Anas，再安装此插件。

- macOS 新增远端剪贴板文件下载：复制远端文件或文件夹后显示下载按钮，选择本地目录后按需分块传输。
- 直接保存到所选目录，保留远端原有目录结构；同名文件或文件夹明确报冲突，不覆盖、不合并。
- 显示传输进度，支持取消和完成后在 Finder 中显示。关闭桌面或在侧栏与窗口间移动时继续后台下载；断开连接或停止插件时结束传输并清理未完成文件。
- 完善下载失败与清理错误提示，并同步中英文界面和使用说明。

下载 `anas-rdp-0.1.10-universal.zip`，从 Anas「设置 → 插件」安装。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

仍为预览版。macOS Intel 已验证早期下载流程；最终“直接保存到所选目录”版本尚未完成真实远端验收。Apple Silicon 未实机验证，Finder 直接粘贴远端文件未实现，macOS 程序未公证。Windows 多连接剪贴板及 Explorer 粘贴／取消仍需实机验证。完整验证范围及依赖告警见[测试说明](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md)。

## English

Requires **Anas 4.0.4 or later** (plugin API 2). File downloads use the host's new directory selection and file reveal APIs. Upgrade Anas before installing this plugin.

- Add remote clipboard file downloads on macOS: copying remote files or folders reveals a download button; choosing a local destination starts on-demand chunked transfers.
- Save directly into the selected directory while preserving the original remote folder structure. Existing files or folders cause an explicit conflict instead of being replaced or merged.
- Show transfer progress, support cancellation and reveal completed downloads in Finder. Downloads continue in the background when closing the desktop or moving between sidebar and window. Disconnecting or stopping the plugin ends transfers and cleans up partial files.
- Improve download and cleanup error reporting, with matching Chinese and English UI and documentation.

Install `anas-rdp-0.1.10-universal.zip` from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs, and Intel Macs; see `SHA256SUMS.txt` for checksums.

This remains a preview. An earlier download flow was tested on an Intel Mac; the final version that saves directly into the chosen directory has not completed live remote acceptance testing. Apple Silicon has not been tested on hardware. Direct remote-file paste into Finder is not implemented, and macOS builds are not notarized. Windows multi-connection clipboard behavior and Explorer paste/cancel still need hardware verification. See [testing notes](https://github.com/higale/anas-plugin-rdp/blob/main/docs/TESTING.md) for full validation scope and dependency advisories.
