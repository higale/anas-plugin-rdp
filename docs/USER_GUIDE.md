# Anas 远程桌面 / Remote Desktop

## 简体中文

需要 **Anas 3.3.5 或更新版本**（插件 API 1）。

1. 在 Anas「设置 → 插件」选择插件 ZIP，或完整解压目录中的 `PLUGIN.json`。
2. 从顶部插件菜单进入首页，默认在侧边栏显示服务器列表。在 Anas「设置 → 插件」选中 RDP 后，「首页打开位置」自动保存，下次打开生效；顶部入口遵循该设置。点击顶部「＋」新建服务器配置，填写名称、地址、端口、用户名和可选域，在「远程桌面打开位置」选择「侧边栏」或「独立窗口」。保存后返回列表，取消丢弃修改；悬停或键盘聚焦一行可「启动」「编辑」。顶部「−」确认删除选中项，「↑／↓」移动选中项并自动保存顺序；编辑页可复制已保存配置。
3. 如需记住密码，勾选「保存密码」并输入；留空且显示「已保存」时保留原密码。取消勾选后保存即删除密文。未保存的密码在连接页临时输入。
4. 点击列表中的「启动」，按服务器配置打开连接页；已保存密码时直接连接，否则输入密码后点击「连接」。普通打开首页、刷新页面或恢复备份均不自动登录。同一配置在同一位置重复打开会聚焦已有页面；不同位置的页面独立。修改打开方式影响下次打开，不转移会话。
   使用 Anas 页面标题栏的「移至独立窗口」或窗口标题栏的「移至侧边栏」移动当前页面，保留连接及未保存内容。目标已有相同页面时需先关闭其中一份，移动不会覆盖。
5. 证书不受系统信任时，独立核对服务器证书 SHA-256 后再信任并重试。指纹变化会再次提示。
6. 在桌面区域操作键鼠；侧边栏连接页右上方提供「断开」，连接过程中显示「取消」。独立窗口使用宿主标题栏的断开／取消图标，悬停可查看提示。需要返回服务器列表时，从 Anas 顶部插件菜单重新打开首页，已有连接保持运行。

密码采用内置版本密钥和随机 IV 的 AES-GCM 加密，仅避免明文直读；持有配置和插件代码即可解密。无需主密码或系统凭据库，可通过 Anas 数据备份跨机器恢复；备份应视为包含登录凭据。密码不回填表单，连接成功后清空临时输入。卸载默认保留配置，同 ID 重装后可继续使用；若勾选宿主卸载确认框的「删除插件数据」，服务器配置、保存的密码和首页偏好均删除，已有备份仍保留；旧版单服务器配置自动迁入。

最多保存 200 个配置，同时最多 4 条连接。启动及进入编辑会读取最新配置。多页同时编辑同一配置时，陈旧保存仍会提示重新加载，保留当前草稿，防止覆盖另一页的修改。删除配置不中断已建立连接，但无法再用已删除配置重连。损坏文件保留并报错，不自动重置。

已保存的首页位置选择继续保留。首页位置与每台服务器的远程桌面位置互不影响。修改首页位置不会关闭已有页面或迁移连接；保存失败会提示并恢复原选项。首页偏好保存在插件配置中，随 Anas 备份恢复，卸载默认保留。

名称与界面使用 Anas 同样的 i18next JSON 语言包，内置简体中文和英文。用户在 ZIP 的 `lang/` 内复制 `en.json` 为新语种（如 `fr.json`），修改 `_meta.name`、翻译文本并保留键和占位符，重新压缩完整插件后安装；插件只跟随宿主当前语种；宿主没有的语种不显示、不能选择。使用新语种前，须先向 Anas 数据目录的 `lang/` 添加对应宿主语言包，再重新打开 Anas。缺失文字回退英文。也可修改包内现有语种。卸载重装以新包为准，不保留或合并旧翻译，请保存修改后的 ZIP；详见随包 `lang/README.md`。语言、主题、字号在聚焦或约 5 秒内更新，保持连接。每页连接独立；同一 Windows 账户重复登录可能导致服务端断开原会话。

画面在桌面区域内等比缩放并水平、垂直居中，调整窗口后保持居中。当前提供基本键鼠、证书信任和连接回收。剪贴板、声音、文件传输、多显示器尚未提供。中文输入和全部组合键仍需专项验证。

包内包含 Web、WASM、原生程序和第三方声明，无需 Rust 或 Node。通用 ZIP 自动选择 Windows x64、macOS Apple Silicon／Intel 程序；本机构建 ZIP 仅含本机平台。macOS 程序为 ad-hoc 签名，未经 Apple 公证。

独立连接窗口的标题栏显示连接状态和断开／取消图标，页面内不再重复显示连接栏；移回侧边栏恢复原布局，连接保持不变。

## English

Requires **Anas 3.3.5 or later** (plugin API 1).

1. In Anas Settings → Plugins, select the ZIP or `PLUGIN.json` in the complete extracted folder.
2. Open the home page from the top plugin menu; it defaults to a server list in the sidebar. In Anas Settings → Plugins, select RDP; “Home page opens in” saves automatically and applies to the top menu on the next opening. Use the top + button to create a server profile with a name, address, port, username, optional domain, and Sidebar or Window under “Remote desktop opens in”. Save returns to the list; Cancel discards edits. Hover or focus a row to reveal Start and Edit. The top − button confirms deletion; ↑ and ↓ move the selected server and save its order. Saved profiles can be copied from the edit form.
3. Check Remember password and enter a password to store it. An empty field marked Saved keeps the existing password. Uncheck and save to remove its ciphertext. Enter unsaved passwords temporarily in the connection page.
4. Select Start in the list to open the configured location and connect with the saved password, or enter a password and select Connect. Opening the home page, reloading a page, or restoring a backup never signs in automatically. Reopening the same profile in the same location focuses its existing page; different locations are independent. Changing placement affects the next opening and does not transfer sessions.
   Use **Move to window** in the Anas panel header or **Move to side panel** in the window title bar to move the same page, connection, and unsaved input. If the destination already contains the same instance, close one first; moving never replaces it.
5. Independently verify the certificate SHA-256 before accepting an untrusted certificate and retrying. Changes require confirmation again.
6. Use keyboard and mouse inside the desktop. The sidebar connection page shows Disconnect at the top right, or Cancel while connecting. In a separate window, use the Disconnect/Cancel icon in the host titlebar; hover to see its tooltip. Reopen the home page from the Anas top plugin menu to return to the server list while keeping the session connected.

Passwords use AES-GCM with a built-in versioned key and random IV, only concealing plain text: anyone with the configuration and plugin code can decrypt them. No master password or OS vault is needed. Anas backups restore them across machines; treat backups as containing login credentials. Passwords are not filled back into forms; temporary input clears after connection. Uninstalling retains profiles by default for reinstallation under the same ID. Selecting Delete plugin data in the host’s uninstall confirmation also removes profiles, saved passwords and home preferences; existing backups are kept. Older single-server settings migrate automatically.

Up to 200 profiles and four concurrent connections are supported. Start and Edit read the latest profile. If multiple pages edit the same profile at once, stale saves still require reloading and preserve the current draft rather than overwriting another page’s changes. Deleting a profile leaves established connections running but prevents reconnection with that profile. Damaged files are preserved and reported rather than reset.

Existing home location preferences are retained. The home page location and each server’s remote desktop location are independent. Changing the home location does not close existing pages or transfer connections. A failed save displays an error and restores the previous choice. The home preference belongs to plugin configuration, is included in Anas backups, and survives uninstalling unless the host’s Delete plugin data option is selected.

Names and UI use the same i18next JSON format as Anas, with English and Simplified Chinese included. In the ZIP’s `lang/`, copy `en.json` to a new code such as `fr.json`, change `_meta.name`, and translate values while retaining keys and placeholders. Repack the complete plugin and install it. The plugin follows the host’s selected language; plugin-only languages are not shown or selectable. To use a new language, first add its host language pack to `lang/` in the Anas data directory and reopen Anas. Missing text falls back to English. Existing languages can also be edited in the package. Reinstallation uses only the new package without retaining or merging old translations; keep your customized ZIP. See the bundled `lang/README.md`. Language, theme, and font size update on focus or within approximately five seconds without reconnecting. Each page owns its connection; Windows may disconnect an earlier session when the same account signs in again.

The desktop scales proportionally and stays horizontally and vertically centered as the window changes size. Basic keyboard/mouse input, certificate trust, and cleanup are provided. Clipboard, audio, file transfer, and multiple displays are not provided. Chinese input and full shortcut coverage require dedicated verification.

Packages include Web components, WASM, native helpers, and notices; no Rust or Node is needed. Universal ZIPs select Windows x64 or Apple Silicon/Intel macOS helpers automatically; local builds contain only the local platform. macOS helpers are ad-hoc signed and not notarized.

Connection windows show status and a Disconnect/Cancel icon in the host titlebar. Moving back to the sidebar restores the connection header without reconnecting.
