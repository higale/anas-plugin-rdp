# Anas RDP v0.1.16

## 简体中文

需要 **Anas 5.2.12 或更新版本**（插件 API 2）。

- macOS 收到远端文件清单后，在右上角短暂显示数量摘要和下载按钮，替代常驻标题栏图标；约 6 秒后消失，悬停或键盘聚焦时暂停，再次复制重新弹出。
- 下载完成后，“在 Finder 中显示”直接选中单个文件或文件夹；多个顶层项目定位到保存目录。
- 修复下载状态提示导致远程桌面区域缩小的问题，侧栏与独立窗口保持一致。
- 记录 Finder 粘贴和取消验证结论；本版仍使用 Anas 显式下载，不提供 Finder 远端文件粘贴或文件拖拽。Windows 文件剪贴板行为不变。

从 Anas「设置 → 插件」覆盖安装 `anas-rdp-0.1.16-universal.zip`。同一包支持 Windows x64、macOS Apple Silicon 和 Intel；校验值见 `SHA256SUMS.txt`。

本版已完成 Intel macOS 真实远端下载、文件完整性、窗口交接、取消、断开清理及 Finder 目标路径调用验证。Windows 和 Apple Silicon 未做本轮远端实机复测。插件仍为预览版，macOS 程序未公证。

## English

Requires **Anas 5.2.12 or later** (plugin API 2).

- On macOS, show a brief top-right notification with the remote file count and a Download button instead of a permanent toolbar icon. It disappears after about 6 seconds, pauses while hovered or focused, and reopens on another copy.
- Show in Finder now selects a single downloaded file or folder directly; multiple top-level items reveal the destination folder.
- Prevent download status from shrinking the remote desktop area, consistently across sidebar and separate windows.
- Document Finder paste and cancellation findings. This release retains explicit Anas downloads; remote-file paste into Finder and file drag-and-drop are not provided. Windows file clipboard behavior is unchanged.

Install `anas-rdp-0.1.16-universal.zip` over the existing plugin from Anas Settings → Plugins. One package supports Windows x64, Apple Silicon Macs and Intel Macs; see `SHA256SUMS.txt` for checksums.

Real remote downloads, content integrity, window handoff, cancellation, disconnect cleanup and Finder target-path routing were checked on Intel macOS. Windows and Apple Silicon remote sessions were not retested in this round. This remains a preview; macOS builds are not notarized.
