---
kind: upgrade-guide
description: "桌面应用、其终端命令和其自有目录改名为 Hydra，桌面应用不再检查更新。"
---
# 桌面应用、其命令和目录改名为 Hydra

[English](guide.md) | 中文

## 变更

桌面应用在 macOS 上是 `Hydra.app`，在 Windows 上是 `Hydra.exe`，应用 ID 为 `com.hydra.harness`；此前为 `DeepSeek Harness` 和 `com.deepseek.harness`。安装包命名为 `hydra-<version>-<os>-<arch>`，DMG 卷名为 `Hydra <version>`。

应用自有的目录随新名称变化，并从空目录开始：

| 内容 | 此前 | 现在 |
|---|---|---|
| 壳设置、快捷键、语言、浏览器存储 | `~/Library/Application Support/@deepseek-ai/dsh-desktop` 或 `%APPDATA%\@deepseek-ai\dsh-desktop` | `~/Library/Application Support/Hydra` 或 `%APPDATA%\Hydra` |
| macOS 崩溃报告 | `~/Library/Logs/DeepSeek Harness` | `~/Library/Logs/Hydra` |
| macOS 偏好设置 | `~/Library/Preferences/com.deepseek.harness.plist` | `~/Library/Preferences/com.hydra.harness.plist` |

会话、设置和密钥仍保存在 `~/.dsh`（或 `DSH_HOME`）中，不受影响。

终端命令是 `hydra`，`dsh` 运行同一入口。**管理 hydra 命令…** 在 macOS 上安装 `/usr/local/bin/hydra`，在 Windows 上把 `hydra.cmd` 注册到当前用户的 PATH；它不再管理 `dsh`。启动器和 profile 的帮助输出显示 `hydra`。

桌面应用不内嵌更新源和强制更新策略，因此不显示**检查更新…**命令，也从不连接 DeepSeek 的更新服务器。

## 迁移

1. 退出旧应用，安装 `Hydra.app` 或运行 Hydra 安装器；如果旧的 `DeepSeek Harness` 应用是 Hydra 构建，将其删除。
2. 在 Hydra 中选择**管理 hydra 命令… → 安装**，然后打开新终端。
3. 如果 `ls -l /usr/local/bin/dsh` 显示链接指向已删除的应用，用 `sudo rm /usr/local/bin/dsh /usr/local/bin/.dsh-desktop-command.json` 删除该链接及其记录。
4. 如果此前改过语言或自定义快捷键，重新设置。
5. 如果没有安装 DeepSeek 自己的桌面应用，表中的旧目录属于旧构建；将其移到废纸篓。
6. 确认迁移完成：`hydra --version` 打印已安装的版本，**关于 Hydra** 显示免责声明。
