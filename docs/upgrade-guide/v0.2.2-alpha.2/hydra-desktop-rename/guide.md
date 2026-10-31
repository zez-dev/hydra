---
kind: upgrade-guide
description: "The desktop app, its terminal command, and its own folders are named Hydra, and the desktop app no longer checks for updates."
---
# The desktop app, its command, and its folders are named Hydra

English | [中文](guide.zh.md)

## Change

The desktop app is `Hydra.app` on macOS and `Hydra.exe` on Windows, with the app ID `com.hydra.harness`; it was `DeepSeek Harness` with `com.deepseek.harness`. Its packages are named `hydra-<version>-<os>-<arch>`, and the DMG volume is named `Hydra <version>`.

The app's own folders follow the new name and start empty:

| Contents | Before | Now |
|---|---|---|
| Shell settings, shortcuts, language, browser storage | `~/Library/Application Support/@deepseek-ai/dsh-desktop` or `%APPDATA%\@deepseek-ai\dsh-desktop` | `~/Library/Application Support/Hydra` or `%APPDATA%\Hydra` |
| macOS crash reports | `~/Library/Logs/DeepSeek Harness` | `~/Library/Logs/Hydra` |
| macOS preferences | `~/Library/Preferences/com.deepseek.harness.plist` | `~/Library/Preferences/com.hydra.harness.plist` |

Sessions, settings, and keys stay in `~/.dsh` (or `DSH_HOME`) and are unaffected.

The terminal command is `hydra`, and `dsh` runs the same entry. **Manage hydra Command…** installs `/usr/local/bin/hydra` on macOS and `hydra.cmd` on the Windows per-user PATH; it no longer manages `dsh`. Launcher and profile help print `hydra`.

The desktop app embeds no update feed and no mandatory-update policy, so it shows no **Check for Updates…** command and never contacts DeepSeek's update servers.

## Migration

1. Quit the previous app, install `Hydra.app` or run the Hydra installer, and delete the previous `DeepSeek Harness` app if it was a Hydra build.
2. In Hydra, choose **Manage hydra Command… → Install**, then open a new terminal.
3. If `ls -l /usr/local/bin/dsh` shows a link into the deleted app, remove it and its record with `sudo rm /usr/local/bin/dsh /usr/local/bin/.dsh-desktop-command.json`.
4. Set your language and custom shortcuts again if you had changed them.
5. If DeepSeek's own desktop app is not installed, the old folders in the table belong to the previous build; move them to the Trash.
6. Confirm the migration: `hydra --version` prints the installed version, and **About Hydra** shows the disclaimer.
