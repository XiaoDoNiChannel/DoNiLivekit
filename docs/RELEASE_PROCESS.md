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
5. 下载并核对 Release 资产；在测试机验证全新安装与从上一版本更新。
6. 将 `latest.json`、Windows 更新安装包（`.exe`、`.msi` 或 `.nsis.zip`）和对应 `.sig` 同步到 DoNiChannel FastAPI 服务器的 `downloads/`（或国内对象存储）。中心服务器可直接执行：

   ```powershell
   .\scripts\Publish-LanUpdate.ps1 -SourceDirectory "D:\release\v0.2.0"
   ```

   脚本默认检查 `http://10.126.126.67:5000`。它会先发布更新安装包，最后原子替换 `latest.json`。`tauri-action v1` 生成的清单可能使用数字 GitHub asset id，脚本会根据同目录的 `.sig` 自动匹配真实文件并改写为局域网下载地址。
7. 发布 GitHub draft，作为归档和备用下载源。

## 本地构建路线

如果不使用 GitHub Actions，可以沿用 `npx tauri build`。先在当前 PowerShell 会话设置签名密钥路径和密码，再运行封装脚本：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "C:\Users\你的用户名\Documents\DoNiChannel-Secrets\donichannel.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "你的密钥密码"
.\scripts\Build-LanRelease.ps1
```

脚本内部仍然执行 `npx tauri build --bundles nsis`，随后从 Tauri 输出中收集 `.exe`、`.nsis.zip`、`.sig`，并生成 `release-assets/v版本/latest.json`。构建成功后再执行输出末尾显示的 `Publish-LanUpdate.ps1` 命令。

GitHub Release 可访问性不是默认更新链路的前提。局域网服务端部署完成前，客户端接口会安全返回 204。

## 失败处理

- 版本不一致：工作流在构建前失败，修正三处版本后创建新 tag；不要移动已公开的 tag。
- Secrets 缺失：不会生成可靠签名产物，补齐 Secrets 后重新运行失败的 workflow。
- 局域网服务端只有 `latest.json` 没有 bundle：接口返回 204，避免把不可下载更新展示给客户端。
- 签名验证失败：确认公钥与签名私钥配对、上传文件未被修改，不得关闭验证绕过。
- `0.1.0` 不会弹出 `0.1.1` 更新：自动更新命令和提示界面从 `0.1.1` 才开始提供，现有 `0.1.0` 必须手动安装 `0.1.1` 一次。之后可用 `0.1.1 -> 0.1.2` 验证完整自动更新链路。
