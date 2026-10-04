# 发布流程

## 首次配置

使用 Tauri signer 在离线、安全的维护环境生成密钥对。公钥写入 `src-tauri/tauri.conf.json`；私钥和密码只写入 GitHub repository secrets：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

私钥不得写入仓库、Actions 日志、FastAPI 配置、`downloads/` 或聊天工具。为私钥建立独立加密备份；丢失私钥后无法为已安装客户端提供可验证更新。

## 发版步骤

1. 更新 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、根 `package.json`、`ui/package.json` 为同一个 SemVer。
2. 执行 README 中的全部检查并确认 `Cargo.lock` 与 `ui/package-lock.json` 已更新。
3. 创建并推送完全匹配的 tag，例如 `v0.2.0`。
4. `.github/workflows/release.yml` 校验版本和密钥后，调用 `Build-PortableRelease.ps1` 构建并签名 Windows x64 EXE，不生成 NSIS/MSI 安装器。
5. 核对 Draft Release 包含 `DoNiChannel.exe`、`DoNiChannel.exe.sig`、`latest-portable.json`。在有 WebView2 Runtime 的测试机直接运行 EXE，并用两个版本验证更新、退出、文件替换、重启和设置保留。
6. 点击 `Publish release`，使 `releases/latest/download/latest-portable.json` 对客户端生效。不会读取 Draft Release。
7. 群文件只需上传同一次构建的 `DoNiChannel.exe`。手动更新时关闭程序后替换原 EXE。

旧安装版（包括 0.1.4）把 Windows 更新包当安装器运行，无法直接升级为免安装版。首次迁移需手动下载新 EXE，关闭旧程序后从可写目录运行。新版本使用独立的 `latest-portable.json` 和 `windows-x86_64-portable` 平台字段，不向旧 `latest.json` 写入普通 EXE。数据目录和应用标识不变；旧快捷方式仍指向旧 EXE，应重新创建快捷方式。不要同时运行新旧客户端。

## 本地构建路线

如果不使用 GitHub Actions，可以沿用 `npx tauri build`。先在当前 PowerShell 会话设置签名密钥路径和密码，再运行封装脚本：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "C:\Users\你的用户名\Documents\DoNiChannel-Secrets\donichannel.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "你的密钥密码"
.\scripts\Build-PortableRelease.ps1
```

脚本执行 `npx tauri build --no-bundle --target x86_64-pc-windows-msvc`，将二进制重命名为 `DoNiChannel.exe` 后签名，再生成 `latest-portable.json`。将三份文件上传到同版本的 GitHub Release；清单中的 URL 指向该版本标签。旧 `Build-LanRelease.ps1` 入口只转调此脚本，不再发布到中心服务器。

GitHub Release 必须正式发布且用户网络能够访问。Draft、Prerelease 或仅上传群文件都不会成为稳定频道的自动更新源。

## 失败处理

- Git 推送出现 `RPC failed` / `remote end hung up unexpectedly`：响应断线时远端可能已经收到提交，不要直接重新升版本。执行 `.\scripts\Release-Client.ps1 -Resume -Version 0.1.2`（替换为本次版本），脚本核对远端分支/标签，重试未完成的推送；不会重新改版本、提交工作区或覆盖其他提交的标签。再次双击 `RELEASE_CLIENT.cmd` 时，若 HEAD 仍是当前版本的发布提交，默认会提示继续当前版本。
- 版本不一致：工作流在构建前失败，修正四处版本后创建新 tag；不要移动已公开的 tag。
- Secrets 缺失：不会生成可靠签名产物，补齐 Secrets 后重新运行失败的 workflow。
- GitHub Release 仍为 Draft：`releases/latest` 不会返回该版本，检查产物后点击 `Publish release`。
- 签名验证失败：确认公钥与签名私钥配对、上传文件未被修改，不得关闭验证绕过。工作流会在正式构建前运行 `Test-UpdaterSigningKey.ps1`，密钥不匹配时直接终止发布。
- 旧安装版没有提示免安装更新：这是隔离更新频道后的预期行为，需手动下载首个免安装版。
- 目录不可写：将 EXE 移出 Program Files、只读目录或受限共享盘，在自己的文件夹中运行。
- 替换失败：查看程序目录下 `.donichannel-update-*/error.txt`；`previous.exe` 如存在是旧程序备份。关闭所有客户端后可手动恢复，不要先删除备份。
