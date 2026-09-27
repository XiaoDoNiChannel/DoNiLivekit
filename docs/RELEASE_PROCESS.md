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
4. `.github/workflows/release.yml` 在 Windows runner 上校验版本，然后用 `tauri-apps/tauri-action@v1` 构建 NSIS、生成 updater bundle/签名/`latest.json` 并上传到 draft GitHub Release。
5. 核对 Draft Release 至少包含 `latest.json`、Windows 安装包和对应 `.sig`；在测试机验证全新安装。
6. 点击 GitHub 的 `Publish release`。这一步现在是自动更新生效的必要条件；客户端使用 `releases/latest/download/latest.json`，不会读取 Draft Release。
7. 可把安装包另行上传到群文件，作为 GitHub 下载超时的人工备用入口；群文件中的安装包不得替代 GitHub `latest.json` 或绕过签名验证。

从局域网更新源迁移到 GitHub 时，如果旧客户端和新构建仍使用同一签名密钥，可以把包含新 GitHub endpoint 的过渡版本再通过旧中心服务器发布一次。签名密钥已经变化时，旧客户端一定会拒绝自动安装，必须引导用户从群文件手动安装过渡版本；后续版本才会直接查询 GitHub。

## 本地构建路线

如果不使用 GitHub Actions，可以沿用 `npx tauri build`。先在当前 PowerShell 会话设置签名密钥路径和密码，再运行封装脚本：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "C:\Users\你的用户名\Documents\DoNiChannel-Secrets\donichannel.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "你的密钥密码"
.\scripts\Build-LanRelease.ps1
```

脚本内部仍然执行 `npx tauri build --bundles nsis`，随后收集本地安装包与签名。此路线主要用于手动安装或旧客户端迁移；正式自动更新以已发布的 GitHub Release 为准。

GitHub Release 必须正式发布且用户网络能够访问。Draft、Prerelease 或仅上传群文件都不会成为稳定频道的自动更新源。

## 失败处理

- Git 推送出现 `RPC failed` / `remote end hung up unexpectedly`：响应断线时远端可能已经收到提交，不要直接重新升版本。执行 `.\scripts\Release-Client.ps1 -Resume -Version 0.1.2`（替换为本次版本），脚本核对远端分支/标签，重试未完成的推送；不会重新改版本、提交工作区或覆盖其他提交的标签。再次双击 `RELEASE_CLIENT.cmd` 时，若 HEAD 仍是当前版本的发布提交，默认会提示继续当前版本。
- 版本不一致：工作流在构建前失败，修正三处版本后创建新 tag；不要移动已公开的 tag。
- Secrets 缺失：不会生成可靠签名产物，补齐 Secrets 后重新运行失败的 workflow。
- GitHub Release 仍为 Draft：`releases/latest` 不会返回该版本，检查产物后点击 `Publish release`。
- 签名验证失败：确认公钥与签名私钥配对、上传文件未被修改，不得关闭验证绕过。工作流会在正式构建前运行 `Test-UpdaterSigningKey.ps1`，密钥不匹配时直接终止发布。
- `0.1.0` 不会弹出 `0.1.1` 更新：自动更新命令和提示界面从 `0.1.1` 才开始提供，现有 `0.1.0` 必须手动安装 `0.1.1` 一次。之后可用 `0.1.1 -> 0.1.2` 验证完整自动更新链路。
