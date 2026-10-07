# 语言包 / Language packs

## 简体中文

插件与 Anas 使用相同的 i18next JSON 语言包格式。内置 `en.json` 和 `zh-CN.json`；名称、按钮、状态及错误文字均从语言包读取。

1. 解压插件 ZIP，在 `lang/` 中复制 `en.json` 为新语种，例如 `fr.json` 或 `ja.json`，也可直接修改现有语言文件。
2. 修改 `_meta.name` 为该语言的显示名称；可填写 `_meta.author`。翻译文本值，保留 `version: 0`、键名及 `{{host}}` 等占位符。
3. 使用 UTF-8 JSON。只翻译部分条目也可以，缺失或空字符串回退英文。
4. 将完整插件重新压缩为 ZIP，确保根目录直接包含 `PLUGIN.json`、`lang/` 及其他原始文件；也可选择完整解压目录中的 `PLUGIN.json` 安装。
5. 在 Anas 中安装后，插件跟随宿主当前语种。可选语种仅来自宿主语言包；只在插件中新增的语种会被忽略，不显示、不能选择。需要使用新语种时，先在 Anas 数据目录的 `lang/` 中添加对应宿主语言包，重新打开 Anas 后选择它。

用户修改以安装包为准。卸载会删除包内语言文件，重装使用新包内容，不保留或合并旧翻译；请保留自己修改的 ZIP。语言包不保存到 `plugin_data/`。Anas 完整数据备份仍包含已安装插件包。

语言包中 `plugin.name` 和 `plugin.description` 用于宿主插件菜单、设置及默认标题；用户服务器名称不会被翻译。语言切换不重建连接。单插件最多 128 个 JSON 语言文件，每个最多 128 KiB，总计 512 KiB。文件名由英文字母开头，使用字母、数字及短横线；语种按完整代码、同基础代码、英文顺序选择。

## English

The plugin uses the same i18next JSON language-pack format as Anas. `en.json` and `zh-CN.json` are included. Names, buttons, status messages, and errors come from these files.

1. Extract the plugin ZIP. In `lang/`, copy `en.json` to a new language code such as `fr.json` or `ja.json`, or edit an existing language file.
2. Set `_meta.name` to the language's display name; `_meta.author` is optional. Translate values while retaining `version: 0`, keys, and placeholders such as `{{host}}`.
3. Save as UTF-8 JSON. Partial translations are supported: missing or empty strings fall back to English.
4. Repack the complete plugin into a ZIP with `PLUGIN.json`, `lang/`, and all original files at its root. Alternatively, install `PLUGIN.json` from the complete extracted directory.
5. Install in Anas; the plugin follows the host's selected language. Only host language packs create selectable languages. A language supplied only by the plugin is ignored and cannot be selected. To use a new language, first add its host language pack to `lang/` in the Anas data directory, reopen Anas, and select it.

The installation package is authoritative. Uninstalling deletes its language files; reinstalling uses the new package without retaining or merging old translations. Keep your customized ZIP. Translations are not saved in `plugin_data/`. Full Anas data backups still include installed plugin packages.

`plugin.name` and `plugin.description` supply host menus, settings, and default titles. User-entered server names stay unchanged. Switching languages keeps connections running. Each plugin supports up to 128 JSON language files, at most 128 KiB each and 512 KiB total. File names start with a letter and use letters, digits, and hyphens. Selection tries the full code, the same base code, then English.
