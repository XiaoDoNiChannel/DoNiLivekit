# 自动更新系统

## 目标与信任边界

DoNiChannel 直接使用 GitHub Releases 作为稳定版更新源。更新清单和安装包均通过 HTTPS 获取，安装包仍必须通过 Tauri updater 公钥验证；GitHub 托管不能替代签名身份校验。

## 客户端流程

1. Vue 初始化完成后异步调用 Tauri `check_for_update`，不等待它完成，因此不阻塞主界面，也不依赖用户填写的业务服务器地址。
2. Rust 从 `tauri.conf.json` 读取固定的 GitHub 更新清单：

   ```text
   https://github.com/XiaoDoNiChannel/DoNiLivekit/releases/latest/download/latest.json
   ```

3. 启动、成功连接以及客户端持续运行期间每四小时检查一次。检查结果进入 `updateStore`；GitHub 网络不可达或超时时状态为 `unavailable`，不阻塞主界面。
4. 有更新时右下角显示版本、更新说明、GitHub 来源和安装按钮，同时提示 GitHub 下载超时可改用群文件。
5. 用户确认后调用 `install_update`；Rust 再次检查，并由 Tauri updater 下载、上报进度、验证签名和安装。Vue 不接触安装包 URL。

`0.1.1` 是第一版包含上述自动更新链路的客户端。已经安装的 `0.1.0` 不具备检查命令和更新提示，必须手动安装 `0.1.1` 一次；从下一版本开始才能通过客户端内自动更新。

## GitHub 发布流程

`.github/workflows/release.yml` 在版本 tag 推送后使用 `tauri-action`：

- 构建 Windows NSIS 安装包；
- 使用 `TAURI_SIGNING_PRIVATE_KEY` 和对应密码生成 `.sig`；
- 生成 `latest.json`；
- 把上述文件上传到 Draft Release。

维护者核对产物后必须点击 `Publish release`。只有正式发布的稳定 Release 才会被 `releases/latest` 选中。群文件仅提供人工下载备份，不参与自动更新检查。

`tauri-action v1` 的安装包 URL 可能使用 GitHub API asset 地址。Tauri updater 下载二进制时会发送 `Accept: application/octet-stream`，GitHub 随后重定向到真正的 Release 文件。

## 旧局域网更新源迁移

旧客户端仍会请求 FastAPI 的 `/api/update/...`，无法自行知道更新源已经改为 GitHub。如果签名密钥没有变化，第一个包含 GitHub endpoint 的过渡版本可通过旧发布脚本部署一次：

```powershell
.\scripts\Publish-LanUpdate.ps1 -SourceDirectory "D:\release\v0.2.0"
```

如果签名密钥已经变化，旧客户端会在下载后拒绝安装，不能通过换下载服务器解决。此时必须让用户从群文件手动安装过渡版本。过渡版本安装完成后，后续更新不再使用中心服务器的 `downloads/`。FastAPI 更新接口和发布脚本暂时保留，仅用于使用同一密钥的迁移或回滚诊断。

## 配置

`src-tauri/tauri.conf.json` 的 updater 配置包含：

- updater 公钥；
- GitHub `releases/latest/download/latest.json` HTTPS endpoint；
- `createUpdaterArtifacts: true`，使 release 构建生成签名更新产物。

更换签名密钥意味着旧客户端无法验证新密钥签名的包。理想的密钥轮换应先发布一个仍由旧私钥签名、但内置新公钥的过渡版本；旧私钥已经丢失时，只能要求用户手动安装一次采用新公钥的版本。

## 清单示例

```json
{
  "version": "0.2.0",
  "notes": "P1 engineering release",
  "pub_date": "2026-09-20T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "...",
      "url": "https://github.com/.../DoNiChannel_0.2.0_x64-setup.nsis.zip"
    }
  }
}
```

不要把 `.sig` 文本、私钥或群文件中的安装包当成可跳过验证的依据。自动下载和手动分发都必须来自同一次受控构建。
