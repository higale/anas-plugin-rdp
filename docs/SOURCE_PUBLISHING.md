# GitHub 源码快照与构建

公开仓库为 `higale/anas-plugin-rdp`，参考 Anas 的源码快照发布方法。开发仓库和 GitHub 保持独立历史；不把开发分支或 `.git` 推向公开仓库。开发仓库本地和远端均不打标签，发布标签仅在 GitHub 公开仓库管理。仅同步已提交并检查过的源码。

本机公开 checkout 路径保存在开发仓库的 Git 本地配置 `anas.githubCheckout`。同步前用 `git config --local --get anas.githubCheckout` 读取，核对该目录的 origin 指向上述 GitHub 仓库后复用，不默认另建相邻目录。该本机路径不写入公开源码。

## 同步步骤

1. 确定发布范围；准备新一轮 GitHub 同步时执行 `npm version patch --no-git-tag-version` 更新两个 package 文件，同轮修复与重试不再次升版。构建清单从 package.json 读取版本。同步双语发布说明，不自行修改 Anas 版本。
2. 完成类型检查、相关行为测试、构建、打包及 `npm run verify:package`。提交并推送开发仓库，确认干净。
3. 用 `git archive` 导出该提交到工作区外；检查归档无凭据、私有地址、个人路径、日志、运行资料或开发 `.git`。
4. 首次创建空 GitHub 仓库并初始化独立 `main`；以后拉取最新公开提交，再用源码快照同步新增、修改和删除，保留目标 `.git`。递归清理前确认绝对路径及目标，不能以开发工作区作为清理目标。
5. 公开 checkout 单独配置 `higale` 与 GitHub noreply 邮箱。检查实际差异，以 `Release <version>` 提交，并用正文概括本次完整功能范围。只推送公开 `main`，不强推或重写历史。
6. 首轮先手动执行工作流验证全部构建；失败时保留版本，修复后追加快照提交。验证通过后，仅在 GitHub 公开仓库创建并推送未存在的 `v<version>` 标签，触发发布；已有发布标签不可移动。
7. 核对已推送的公开提交与导出源码内容一致后，将开发提交号和公开提交号分别记录到开发仓库的本地 Git 配置 `anas.lastSyncedDevCommit`、`anas.lastSyncedPublicCommit`，不创建同步标签。后续同步前读取并核对这两个提交；配置缺失时重新比较源码快照与公开仓库，不猜测同步位置。同步记录不代替构建成功结果。
8. 等待三平台构建、通用 ZIP 合并及三平台通用包验证全部成功。标签工作流创建 GitHub 预览 Release，仅上传通用 ZIP 与 `SHA256SUMS.txt`；手动工作流只保留 Actions 产物。

## CI 与产物

| 原生平台 | runner | 内部组件 ZIP 后缀 |
| --- | --- | --- |
| Windows x64 | windows-2022 | native-win32-x64 |
| macOS Apple Silicon | macos-15 | native-darwin-arm64 |
| macOS Intel | macos-15-intel | native-darwin-x64 |

公共 job 构建一次共享 UI／JavaScript，运行类型检查、界面及配置回归。三个 native job 使用固定 Rust，构建原生会话程序并运行 workspace 测试与 clippy，收集各自许可证；macOS 执行 ad-hoc 签名并验证，未公证。

公共组件与三个原生组件完成后，合并 job 验证源码提交、依赖锁、构建元数据及每个文件摘要一致性。以公共组件为基础加入三个原生程序，合并许可证；原生组件不携带重复 Web 资源。`PLUGIN.json` 声明 Windows/macOS，后台按 Node 运行时的操作系统和架构选择 helper。

生成的 `anas-rdp-<version>-universal.zip` 再分别在 Windows、ARM Mac、Intel Mac 上解压，检查内容、原生权限／签名及 helper 启动回收。只有全部成功才发布。各平台远程认证、画面和输入仍需实机验证，不能用 CI 代替。

Release 仅提供 `anas-rdp-<version>-universal.zip` 与一份 `SHA256SUMS.txt`；各组件 ZIP、独立摘要和逐文件清单只作为 Actions 内部验证产物保留 14 天。GitHub 自动生成的源码下载项不属于插件安装包。

Actions 使用 GitHub 提供的 GITHUB_TOKEN；不上传真实 RDP 配置，不需要 RDP 密码或 Apple 证书。RDP 0.1.7 最低要求 Anas 3.3.8（插件 API 2）；配套发布时先同步宿主，再同步插件。后续发布须重新核对宿主最低版本，可选语种仅来自宿主语言包。插件和宿主分别同步和发布，发布插件不自动发布宿主。
