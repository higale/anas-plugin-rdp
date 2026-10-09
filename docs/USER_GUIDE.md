# Anas 远程桌面 / Remote Desktop

## 简体中文

RDP 0.1.7 需要 **Anas 3.3.8 或更新版本**（插件 API 2）。先升级 Anas，再安装插件；旧版宿主不支持。

1. 在 Anas「设置 → 插件」选择插件 ZIP，或完整解压目录中的 `PLUGIN.json`。
2. 从顶部插件菜单进入首页，默认在侧边栏显示服务器列表。在 Anas「设置 → 插件」选中 RDP 后，「首页打开位置」自动保存，下次打开生效；顶部入口遵循该设置。点击顶部「＋」新建服务器配置，填写名称、地址、端口、用户名和可选域，在「远程桌面打开位置」选择「侧边栏」或「独立窗口」。保存后返回列表，取消丢弃修改；单击条目选中，双击启动服务器；悬停或键盘聚焦一行也可「启动」「编辑」，不可编辑时隐藏「编辑」按钮。顶部「−」确认删除选中项，「↑／↓」移动选中项并自动保存顺序；右键条目可选择「侧边栏启动」「独立窗口启动」（运行中则为对应位置恢复桌面），以及编辑、复制、上移、下移或删除；编辑页仅保留保存和取消。
3. 如需记住密码，勾选「保存密码」并输入；留空且显示「已保存」时保留原密码。取消勾选后保存即删除密文。未保存的密码在连接页输入；该页也可勾选「保存密码（加密，可随备份恢复）」，点击连接时保存到原条目。不勾选则仅用于本次连接，不删除已有密码；条目已删除或保存失败会提示错误，不会重建条目。
4. 双击条目或点击「启动」，按服务器配置打开连接页；已保存密码时直接连接，否则输入密码后点击「连接」。普通打开首页、刷新页面或恢复备份均不自动登录。同一配置重复打开会聚焦已有页面。编辑和连接使用独立界面：保存只修改配置，连接和重新连接读取最新配置，不隐式保存。连接页与编辑页互斥：即使已断开，连接页仍在时也不能编辑；先关闭连接页并断开后台连接，再编辑。编辑期间须先保存或取消，才能打开连接页。成功打开或移动桌面会自动更新「远程桌面打开位置」，下次启动及后台桌面恢复均使用最后位置；也可在编辑页修改。连接页的密码默认仅用于本次连接，只有勾选保存时写入；断开后显示重新连接入口，不返回编辑表单。待连接表单居中显示，窄窗口和大字号下可滚动；连接后恢复完整桌面区域。
   使用 Anas 标签右键菜单的「移至独立窗口」或窗口标题栏的「移至侧边栏」切换位置。目标页面会重新创建并恢复未保存内容，接入同一条后台连接，不重新认证。编辑页的「后台运行」默认不勾选，旧配置缺少此项时也视为关闭。未勾选时，关闭侧边栏桌面标签或独立桌面窗口即断开该连接；关闭首页不影响桌面。勾选后关闭桌面保留连接，列表显示「连接中／已连接」；点击「恢复桌面」或双击条目接入原会话，右键「断开连接」可结束后台连接，不需要先打开桌面；点击「断开」、停止后台或退出宿主才结束连接。连接已结束时，仅仍有桌面页的条目显示「已断开」；桌面页关闭后不显示状态。
5. 证书不受系统信任时，独立核对服务器证书 SHA-256 后再信任并重试。指纹变化会再次提示。
6. 在桌面区域操作键鼠；侧边栏连接页与独立窗口标题栏统一使用「服务器列表」和断开／取消图标按钮，悬停可查看提示。点击「服务器列表」打开首页并选中、滚动定位当前服务器，已有连接保持运行；列表页有未保存编辑或待确认删除时，先完成或取消操作，再定位。也可从 Anas 顶部插件菜单重新打开首页。

密码采用内置版本密钥和随机 IV 的 AES-GCM 加密，仅避免明文直读；持有配置和插件代码即可解密。无需主密码或系统凭据库，可通过 Anas 数据备份跨机器恢复；备份应视为包含登录凭据。密码不回填表单，连接成功后清空临时输入。卸载默认保留配置，同 ID 重装后可继续使用；若勾选宿主卸载确认框的「删除插件数据」，服务器配置、保存的密码和首页偏好均删除，已有备份仍保留；旧版单服务器配置自动迁入。

最多保存 200 个配置，同时最多 4 条连接。启动及进入编辑会读取最新配置。配置在编辑期间被外部修改时，会拒绝覆盖并保留当前草稿；点击冲突提示旁的「重新加载」可读取最新配置，并放弃未保存的修改。运行中的配置禁止编辑、删除，断开后才可删除；编辑还需要关闭对应连接页。外部删除的配置如仍有后台连接，列表保留恢复与断开入口，但不能用已删除配置重连。损坏文件保留并报错，不自动重置。

已保存的首页位置选择继续保留。首页位置与每台服务器的远程桌面位置互不影响。修改首页位置不会关闭已有页面或迁移连接；保存失败会提示并恢复原选项。首页偏好保存在插件配置中，随 Anas 备份恢复，卸载默认保留。

名称与界面使用 Anas 同样的 i18next JSON 语言包，内置简体中文和英文。用户在 ZIP 的 `lang/` 内复制 `en.json` 为新语种（如 `fr.json`），修改 `_meta.name`、翻译文本并保留键和占位符，重新压缩完整插件后安装；插件只跟随宿主当前语种；宿主没有的语种不显示、不能选择。使用新语种前，须先向 Anas 数据目录的 `lang/` 添加对应宿主语言包，再重新打开 Anas。缺失文字回退英文。也可修改包内现有语种。卸载重装以新包为准，不保留或合并旧翻译，请保存修改后的 ZIP；详见随包 `lang/README.md`。语言、主题、字号在聚焦或约 5 秒内更新，保持连接。不同配置的连接独立；同一 Windows 账户重复登录可能导致服务端断开原会话。

画面在桌面区域内等比缩放并水平、垂直居中，调整窗口后保持居中。当前提供基本键鼠、证书信任和连接回收。剪贴板、声音、文件传输、多显示器尚未提供。本地输入法组合输入尚未支持；远端输入法和全部组合键仍需专项验证。

包内包含 canvas 界面、原生会话程序和第三方声明，无需 Rust 或 Node。通用 ZIP 自动选择 Windows x64、macOS Apple Silicon／Intel 程序；本机构建 ZIP 仅含本机平台。macOS 程序为 ad-hoc 签名，未经 Apple 公证。

独立连接窗口的标题栏显示连接状态和断开／取消图标，页面内不再重复显示连接栏；移回侧边栏恢复原布局，连接保持不变。

## English

RDP 0.1.7 requires **Anas 3.3.8 or later** (plugin API 2). Upgrade Anas before installing the plugin; older hosts are unsupported.

1. In Anas Settings → Plugins, select the ZIP or `PLUGIN.json` in the complete extracted folder.
2. Open the home page from the top plugin menu; it defaults to a server list in the sidebar. In Anas Settings → Plugins, select RDP; “Home page opens in” saves automatically and applies to the top menu on the next opening. Use the top + button to create a server profile with a name, address, port, username, optional domain, and Sidebar or Window under “Remote desktop opens in”. Save returns to the list; Cancel discards edits. Single-click a row to select it; double-click to start the server. Hover or focus a row to reveal Start and Edit; Edit is hidden when unavailable. The top − button confirms deletion; ↑ and ↓ move the selected server and save its order. Right-click a row to start in the sidebar or a window (or resume there when running), edit, copy, move up/down, or delete. The edit form only provides Save and Cancel.
3. Check Remember password and enter a password to store it. An empty field marked Saved keeps the existing password. Uncheck and save to remove its ciphertext. Enter unsaved passwords in the connection page. You can also check “Remember password (encrypted, included in backups)” there to save it to the original profile when connecting. Leaving it unchecked uses the password for this attempt without deleting an existing saved password. Deleted profiles and failed saves show an error; no profile is recreated.
4. Double-click a row or select Start to open the configured location and connect with the saved password, or enter a password and select Connect. Opening the home page, reloading a page, or restoring a backup never signs in automatically. Reopening the same profile focuses its existing page. Editing and connecting use separate screens: Save only updates the profile; Connect and Reconnect read the latest profile without implicitly saving it. Connection pages and editing are mutually exclusive: close the connection page, even when disconnected, and stop any background connection before editing. Save or cancel editing before opening a connection page. Successful openings and moves remember “Remote desktop opens in”; later starts and background desktop recovery use that position. It can also be changed in the editor. Passwords are temporary unless Remember is checked. Disconnection shows Reconnect without revealing the edit form. The connection form uses a centered card with scrolling for small windows or large fonts; connected desktops fill the available area.
   Use **Move to window** in the Anas tab context menu or **Move to side panel** in the window title bar to change location. The destination page is recreated, restores unsaved input, and attaches to the same backend connection without authenticating again. Run in background is unchecked by default, including for existing profiles without this setting. When unchecked, closing the desktop tab or window disconnects that server; closing the home page does not affect desktops. When checked, closing the desktop retains the connection. The server list shows Connecting or Connected; Resume desktop or double-click attaches to that session, and the context-menu Disconnect action stops it without opening the desktop. Disconnect, stopping the backend, or quitting the host ends the connection. Once the connection ends, Disconnected appears only while its desktop page remains open; closing that page clears the status.
5. Independently verify the certificate SHA-256 before accepting an untrusted certificate and retrying. Changes require confirmation again.
6. Use keyboard and mouse inside the desktop. The sidebar connection header and separate window titlebar use matching Server list and Disconnect/Cancel icon buttons with hover labels. Server list opens the home page, selects the current server, and scrolls it into view without disconnecting. If the list has an unsaved edit or a pending deletion confirmation, finish or cancel it before the selection is applied. You can also reopen the home page from the Anas top plugin menu.

Passwords use AES-GCM with a built-in versioned key and random IV, only concealing plain text: anyone with the configuration and plugin code can decrypt them. No master password or OS vault is needed. Anas backups restore them across machines; treat backups as containing login credentials. Passwords are not filled back into forms; temporary input clears after connection. Uninstalling retains profiles by default for reinstallation under the same ID. Selecting Delete plugin data in the host’s uninstall confirmation also removes profiles, saved passwords and home preferences; existing backups are kept. Older single-server settings migrate automatically.

Up to 200 profiles and four concurrent connections are supported. Start and Edit read the latest profile. If a profile changes externally during editing, stale saves are rejected while preserving the draft. Select Reload beside the conflict message to load the latest profile and discard unsaved edits. Running connections block profile editing and deletion. After disconnecting, deletion is allowed; editing also requires closing the connection page. If a profile was removed externally, its running session remains listed with Resume desktop and Disconnect, but cannot reconnect after it ends. Damaged files are preserved and reported rather than reset.

Existing home location preferences are retained. The home page location and each server’s remote desktop location are independent. Changing the home location does not close existing pages or transfer connections. A failed save displays an error and restores the previous choice. The home preference belongs to plugin configuration, is included in Anas backups, and survives uninstalling unless the host’s Delete plugin data option is selected.

Names and UI use the same i18next JSON format as Anas, with English and Simplified Chinese included. In the ZIP’s `lang/`, copy `en.json` to a new code such as `fr.json`, change `_meta.name`, and translate values while retaining keys and placeholders. Repack the complete plugin and install it. The plugin follows the host’s selected language; plugin-only languages are not shown or selectable. To use a new language, first add its host language pack to `lang/` in the Anas data directory and reopen Anas. Missing text falls back to English. Existing languages can also be edited in the package. Reinstallation uses only the new package without retaining or merging old translations; keep your customized ZIP. See the bundled `lang/README.md`. Language, theme, and font size update on focus or within approximately five seconds without reconnecting. Each profile has its own connection; Windows may disconnect an earlier session when the same account signs in again.

The desktop scales proportionally and stays horizontally and vertically centered as the window changes size. Basic keyboard/mouse input, certificate trust, and cleanup are provided. Clipboard, audio, file transfer, and multiple displays are not provided. Local IME composition is not yet supported; remote IMEs and full shortcut coverage require dedicated verification.

Packages include canvas UI, native session helpers, and notices; no Rust or Node is needed. Universal ZIPs select Windows x64 or Apple Silicon/Intel macOS helpers automatically; local builds contain only the local platform. macOS helpers are ad-hoc signed and not notarized.

Connection windows show status and a Disconnect/Cancel icon in the host titlebar. Moving back to the sidebar restores the connection header without reconnecting.
