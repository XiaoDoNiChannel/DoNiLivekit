# 小豆泥电竞语音客户端

这是一个基于 **Tauri + Vue 3 + LiveKit + Rust WASAPI** 的桌面语音客户端。项目核心目标是提供类似 Discord 的语音频道体验，并支持 Rust 侧的低延迟音频采集、应用音频共享、屏幕共享、聊天和设备选择。

## 技术栈

- 前端：Vue 3、Vite、JavaScript、AudioWorklet
- 桌面壳：Tauri v2
- 后端本地能力：Rust、Windows WASAPI、WebSocket
- 实时音视频：LiveKit
- 本地音频端口：
  - `127.0.0.1:9001`：应用/进程音频共享
  - `127.0.0.1:9002`：Rust 麦克风音频采集

## 项目目录

推荐仓库结构如下：

```text
livekit_pack/
├─ README.md
├─ PROJECT_GUIDE.md
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ AUDIO_PIPELINE.md
│  ├─ FRONTEND_GUIDE.md
│  └─ TROUBLESHOOTING.md
├─ ui/
│  ├─ index.html
│  ├─ package.json
│  ├─ vite.config.js
│  ├─ public/
│  │  └─ pcm-worker.js
│  └─ src/
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ src/
│     ├─ lib.rs
│     └─ main.rs
└─ .editorconfig
```

## 本地开发运行

先安装前端依赖：

```powershell
cd F:\livekit_pack\ui
npm install
```

从项目根目录启动 Tauri：

```powershell
cd F:\livekit_pack
npx tauri dev
```

如果 Tauri 配置中的 `beforeDevCommand` 使用的是 `npm run dev`，请确保命令从项目根目录运行，并且 `tauri.conf.json` 中 `devUrl` 指向：

```json
"devUrl": "http://localhost:5173"
```

## 打包

```powershell
cd F:\livekit_pack
npx tauri build
```

交互式客户端发布可以直接双击根目录的 `RELEASE_CLIENT.cmd`。它会询问版本号和更新说明，并自动完成版本同步、测试以及 GitHub 标签发布或本地签名构建。

生成可直接复制到中心服务器运行的便携 ZIP，可以双击 `BUILD_CENTER_SERVER.cmd`。完整说明见 `docs/INTERACTIVE_RELEASE.md`。

## 核心功能

- 进入大厅并显示频道列表
- 自动加入默认语音频道
- Rust 麦克风采集与 LiveKit 发布
- 麦克风输入音量绿条
- 麦克风设备选择
- 扬声器输出设备选择
- 应用进程音频共享
- 屏幕共享和本地预览
- 远端用户音量百分比保存
- 聊天消息发送与接收
- 切换频道后自动恢复麦克风状态

## 文档入口

- `PROJECT_GUIDE.md`：给开发者看的项目开发规则和模块边界
- `docs/ARCHITECTURE.md`：整体架构说明
- `docs/AUDIO_PIPELINE.md`：9001、9002、AudioWorklet、LiveKit 音频链路说明
- `docs/FRONTEND_GUIDE.md`：前端目录、组件、状态和业务模块说明
- `docs/TROUBLESHOOTING.md`：常见问题排查

## 开发原则

后续新增功能时，请遵守以下原则：

```text
components 只负责 UI
features 只负责业务动作
stores 只负责状态
shared 只放通用工具
legacy 不再新增业务代码
```

不要把新功能直接写进 `legacy/client.js`。如果确实需要兼容旧函数名，只在 `legacy/client.js` 中做导出或入口转发。

## P1 工程化状态

当前代码已按职责拆分：

```text
src-tauri/src/lib.rs       Tauri Builder、插件、状态和 command 注册
src-tauri/src/state.rs     麦克风 generation/cancellation 会话状态
src-tauri/src/commands/    保持原名称与参数的 Tauri command
src-tauri/src/audio/       WASAPI、VAD/RNNoise、PCM、DSP 和有界帧队列
src-tauri/src/transport/   127.0.0.1:9001/9002 传输常量
server/app.py              FastAPI 应用与兼容路由
server/db/                 SQLite 连接、仓储和前向迁移
server/realtime/           Presence/Chat 共用协议与发送基础层
server/api/updates.py      Tauri 动态更新清单与安装包下载
main.py                    `python main.py` 兼容入口
```

LiveKit SDK 由 `ui/package.json` 锁定并随 Vite 打包，不再从公网 CDN 加载。

## 开发与检查

```powershell
python -m pip install -r requirements-dev.txt
npm ci --prefix ui
npm ci

python main.py
npm run dev
```

提交前运行：

```powershell
npm test --prefix ui
npm run build --prefix ui
python -m compileall -q main.py server tests
python -m unittest discover -s tests -p "*_tests.py" -v
cd src-tauri
cargo fmt --all -- --check
cargo check --locked
cargo test --locked
```

## 自动更新与发布

客户端默认使用中心服务器 `10.126.126.67:5000`，在启动、连接成功和每四小时静默检查：

```text
GET {server}/api/update/{target}/{arch}/{current_version}
```

无更新返回 204；有更新时 FastAPI 从 `downloads/latest.json` 读取签名清单，并把下载地址指向同一局域网服务器。可用 `DONICHANNEL_DOWNLOADS_DIR` 指定发布目录，用 `DONICHANNEL_UPDATE_BASE_URL` 预留国内对象存储/CDN 地址。GitHub Releases 仅作为归档和备用来源。

有更新时客户端右下角显示版本、更新说明、下载进度和安装按钮。中心服务器部署新版本可运行：

```powershell
.\scripts\Publish-LanUpdate.ps1 -SourceDirectory "D:\release\v0.2.0"
```

继续使用本地 Tauri 构建时，可用 `.\scripts\Build-LanRelease.ps1` 代替直接执行 `npx tauri build`；它会在正常构建后补齐局域网发布需要的 `latest.json`。

发布由 `.github/workflows/release.yml` 在 `v*.*.*` tag 上触发。创建 tag 前，必须把 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、根 `package.json` 和 `ui/package.json` 的版本同步；CI 会拒绝版本不一致的发布。仓库只保存 updater 公钥，私钥和密码必须配置为 GitHub Secrets：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

完整说明见 `docs/UPDATE_SYSTEM.md` 与 `docs/RELEASE_PROCESS.md`。
