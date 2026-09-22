# 交互式发布与中心服务器便携包

## 客户端一键发布

在仓库根目录双击 `RELEASE_CLIENT.cmd`，或在 PowerShell 运行：

```powershell
.\scripts\Release-Client.ps1
```

脚本会依次询问：

1. 新版本号，直接回车会自动把补丁版本加一，例如 `0.1.0 -> 0.1.1`。
2. 更新说明，每行一条，输入空行结束。
3. 发布模式：GitHub Actions 标准发布或本机签名构建。

两种模式都会自动同步以下文件的版本号，并运行前端、Python、Rust 检查：

- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `package.json`
- `ui/package.json`
- `RELEASE_NOTES.md`

GitHub 模式会在最后列出待提交文件。只有准确输入 `RELEASE` 才会执行 `git add -A`、提交、推送当前分支、创建并推送版本标签。标签会触发 `.github/workflows/release.yml`。

本地模式会询问 updater 私钥路径和密码，调用 `Build-LanRelease.ps1`，生成：

```text
release-assets/v版本/
├─ latest.json
├─ *.nsis.zip
├─ *.nsis.zip.sig
└─ *.exe
```

## 中心服务器便携包

在开发电脑的仓库根目录双击 `BUILD_CENTER_SERVER.cmd`，或运行：

```powershell
.\scripts\Build-CenterServer.ps1
```

脚本会构建 Vue 静态资源和 PyInstaller 独立后端，并将 LiveKit、启停脚本一起压缩到：

```text
server-release/DoNiChannel-Server-v版本.zip
```

服务器版本独立记录在 `server/VERSION`，不要求与客户端版本一致。客户端发布脚本只修改客户端版本；中心服务器打包脚本只修改服务器版本。

中心服务器不需要安装 Python、Node.js 或 Rust。把 ZIP 复制到 `10.126.126.67`，解压后：

1. 首次运行 `OPEN_FIREWALL.cmd`。
2. 运行 `START_SERVER.cmd`。
3. 停止时运行 `STOP_SERVER.cmd`。
4. 发布客户端更新时运行 `PUBLISH_CLIENT_UPDATE.cmd`。

`START_SERVER.cmd` 会分别打开 LiveKit 和 Python 后端的可见控制台。控制台输出同时写入
`logs/livekit.log` 和 `logs/backend.log`。默认单个日志最大 10 MB，每个服务最多保留 5 份。
如需调整，修改 `START_SERVER.cmd` 顶部的 `DONICHANNEL_LOG_MAX_MB` 和
`DONICHANNEL_LOG_FILE_COUNT`。
关闭服务请始终使用 `STOP_SERVER.cmd`。

升级中心服务器时，先停止旧服务，覆盖程序文件，但必须保留：

```text
rooms.db
uploads/
downloads/
```

`logs/` 可以按需要保留或归档。
