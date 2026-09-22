# 常见问题排查

本文档记录本项目常见运行问题和定位方式。

## 1. Tauri 启动后找不到 `ui/ui/package.json`

错误类似：

```text
npm error path F:\livekit_pack\ui\ui\package.json
```

原因：`tauri.conf.json` 中 `beforeDevCommand` 的路径和当前执行目录重复拼接。

如果从项目根目录运行：

```powershell
cd F:\livekit_pack
npx tauri dev
```

通常推荐：

```json
"beforeDevCommand": "npm run dev",
"beforeBuildCommand": "npm run build"
```

如果你的 Tauri 配置要求从根目录执行前端命令，也可以使用 `--prefix ./ui`，但要确保不会被 Tauri 自动切到 `ui` 目录后再执行。

## 2. 页面白屏，控制台提示无法解析 `vue`

错误类似：

```text
Failed to resolve module specifier "vue"
```

原因：Tauri 没有通过 Vite dev server 加载页面，而是加载了静态 HTML。

检查 `src-tauri/tauri.conf.json`：

```json
"devUrl": "http://localhost:5173",
"frontendDist": "../ui/dist"
```

并确认 Vite 已启动。

## 3. 9001 或 9002 端口连接失败

9001：应用音频共享端口。

9002：Rust 麦克风端口。

常见原因：

```text
Rust 后端没有启动
端口被旧进程占用
Tauri 进程没有完全退出
Windows 音频设备失效
前端过早连接 WebSocket
```

处理方式：

```powershell
# 关闭所有旧 Tauri 窗口后重试
cd F:\livekit_pack
npx tauri dev
```

必要时检查端口占用：

```powershell
netstat -ano | findstr 9001
netstat -ano | findstr 9002
```

## 4. 麦克风绿线一直满格且声音失真

常见原因：Rust 侧音频样本量纲错误。

尤其是使用 RNNoise 时，要确认：

```text
输入 RNNoise 前：[-1.0, 1.0] × 32768
RNNoise 输出后：÷ 32768 回到 [-1.0, 1.0]
```

如果直接把 32768 量级数据拿去算 RMS 或发送给前端，会导致：

```text
绿线满格
严重爆音
类似方波失真
```

## 5. 5.0 增益是否一定会爆音

不一定。

如果音频样本仍在 `[-1.0, 1.0]` 范围内，5.0 增益配合 limiter 可以正常工作。

如果样本量纲已经变成 RNNoise 的 32768 量级，再乘 5.0 或直接 clamp，一定会严重失真。

## 6. 切频道后麦克风图标开着但别人听不到

原因通常是旧房间的 publication 没有释放，新房间没有重新 publish。

正确流程应该是：

```text
记录切频道前是否开麦
停止旧 Rust 麦克风发布
断开旧房间
连接新频道
重新创建/发布 Rust 麦克风 track
恢复按钮状态
```

相关模块：

```text
features/roomConnection.js
features/rustMic.js
features/audioPipelines.js
```

## 7. 麦克风下拉框显示的不是实际设备名

Rust 侧需要通过 Windows `IMMDevice.OpenPropertyStore()` 读取设备 FriendlyName。

前端通过：

```text
list_capture_devices
set_rust_mic_device_id
```

完成设备枚举和选择。

如果显示异常，请检查：

```text
Rust 命令是否注册
windows crate feature 是否包含设备属性读取相关功能
前端是否调用 updateMicList
选择后是否调用 set_rust_mic_device_id
```

## 8. 扬声器切换失败

错误可能类似：

```text
AudioContext.setSinkId 切换失败
```

原因可能是浏览器/Tauri WebView 对输出设备切换支持不完整，或设备 ID 不存在。

通常这不影响 Rust 麦克风采集，只影响远端音频或耳返输出设备。

## 9. 应用音频共享没有声音

排查顺序：

```text
1. 是否已进入语音频道
2. 是否选择了正确进程
3. Rust 9001 是否连接成功
4. start_capture/start_capture_multi 是否返回采样率

## 自动更新始终显示 unavailable

静默更新只有在以下条件同时满足时才执行：运行于 Tauri、已经保存服务器地址、FastAPI 可访问。依次检查：

```text
GET http://服务器:5000/api/update/windows/x86_64/当前版本
服务端 downloads/latest.json 是否存在
latest.json 引用的 NSIS updater bundle 是否也位于 downloads/
signature 是否由与 tauri.conf.json 公钥匹配的私钥生成
```

没有更新应返回 204，这是正常行为。网络不可达或旧服务器没有接口时，客户端记录 `autoUpdate/check` 调试日志并继续进入主界面。

局域网 HTTP 仅通过 updater 的 `dangerousInsecureTransportProtocol` 支持；签名校验仍然强制启用。不要通过删除公钥或自行 fetch/执行安装包来“修复”更新。

## 数据库迁移或启动失败

查看 `donichannel.db.migrations` 日志。迁移前备份文件格式为：

```text
rooms.db.backup-v0-to-v3-YYYYMMDD-HHMMSS
```

关闭服务后，可保留故障库并复制备份到新的测试目录验证。不要在服务运行时覆盖 `rooms.db`，也不要删除唯一备份。

## 诊断信息收集

当前无需复杂 UI：一次诊断包应包含 Tauri 日志、FastAPI 控制台日志、浏览器控制台中带模块名前缀的错误、应用版本、Windows 版本、服务器地址（不含 token）以及 9001/9002/5000/7880 端口状态。严禁收集完整 LiveKit token、音频帧、聊天图片二进制或 updater 私钥。日志写入失败不应阻止应用运行。
5. AudioWorklet 是否初始化成功
6. LiveKit 是否 publishTrack(name='app-audio') 成功
7. 远端是否订阅到 app-audio track
```

相关模块：

```text
features/appAudio.js
features/audioPipelines.js
features/livekitEvents.js
```

## 10. 屏幕共享异常

排查顺序：

```text
1. 浏览器/Tauri 是否允许屏幕捕获
2. 本地预览是否出现
3. LiveKit 是否 publish screen track
4. 远端是否收到 TrackSubscribed
5. 是否被本地屏蔽订阅
```

相关模块：

```text
features/screenShare.js
features/livekitEvents.js
```

## 11. Tauri invoke 不可用

如果控制台出现：

```text
Tauri invoke 不可用，请在 Tauri 环境运行
```

说明当前页面可能是在普通浏览器中打开，而不是 Tauri WebView 中运行。

请用：

```powershell
npx tauri dev
```

不要直接用浏览器打开 `index.html`。

## 12. 修改后如何快速确认没有破坏核心链路

每次改动后至少测试：

```text
进入大厅
自动进入 day0
开麦
绿线跳动
切 day0/day1 后麦克风恢复
麦克风设备切换
应用音频共享
屏幕共享
聊天
离开房间
```

如果这些都正常，说明核心链路基本没有被破坏。
