# 音频链路说明

本文档说明项目的本地音频采集、AudioWorklet、LiveKit 发布和常见问题定位方式。

## 音频链路总览

项目有两条本地音频链路：

```text
9001：应用/进程音频共享
9002：Rust 麦克风采集
```

两条链路最终都变成浏览器可发布的 `MediaStreamTrack`，再通过 LiveKit 发布到频道中。

## 9001：应用音频共享

用途：共享某个应用进程或多个进程的系统音频。

链路：

```text
Rust WASAPI Process Loopback
→ 127.0.0.1:9001 WebSocket
→ ui/public/pcm-worker.js
→ AudioWorkletNode
→ MediaStreamDestination
→ MediaStreamTrack
→ LiveKit publishTrack(name='app-audio')
```

相关模块：

```text
src/features/appAudio.js
src/features/audioPipelines.js
src-tauri/src/lib.rs
```

相关 Rust 命令：

```text
get_active_processes
start_capture
start_capture_multi
```

## 9002：Rust 麦克风

用途：绕过浏览器麦克风采集，使用 Rust/Windows WASAPI 接管麦克风，并支持后端侧处理。

链路：

```text
Windows 麦克风设备
→ Rust WASAPI Capture
→ RNNoise / Limiter / VAD / 增益处理
→ 127.0.0.1:9002 WebSocket
→ ui/public/pcm-worker.js
→ AudioWorkletNode
→ MediaStreamDestination
→ MediaStreamTrack
→ LiveKit publishTrack(source=Microphone)
```

9002 的每个 10ms 帧还会先发送一条 `pcm_frame_meta` 文本消息，包含 `seq`、
`capturedAtMicros` 和 `discontinuity`。PCM 二进制格式保持 Float32 不变。

相关模块：

```text
src/features/rustMic.js
src/features/audioPipelines.js
src/features/devices.js
src-tauri/src/lib.rs
```

相关 Rust 命令：

```text
toggle_rust_mic
query_mic_sample_rate
list_capture_devices
set_rust_mic_device_id
set_mic_vad_threshold
set_mic_boost
```

## AudioWorklet 的职责

`ui/public/pcm-worker.js` 是一个环形缓冲播放器。

它只做：

```text
接收 Float32 PCM
写入 ring buffer
在 AudioWorklet process 中按帧输出
轻微积压时在零交叉附近平滑追赶
严重积压时在安静边界做有记录的恢复
```

唯一 Worklet 实现位于 `ui/public/pcm-worker.js`，纯缓冲算法位于
`ui/public/pcm-ring-buffer-core.js`；`ui/pcm-worker.js` 只是旧路径兼容入口。
Worklet 每约 2 秒输出当前/最大缓冲帧、下溢、丢弃、跳过和 discontinuity 指标。

Rust 9002 使用 generation 会话和 24 帧有界队列。队列过载时优先移除最旧静音帧，
否则移除最旧帧并标记 discontinuity，不再静默丢弃最新采集帧。`mic_audio_metrics`
事件包含采集/发送帧数、队列高水位、过载、丢弃和 discontinuity 计数。

VAD 在 RNNoise 后增加约 120ms 前滚和约 320ms hangover，开关门使用逐样本平滑增益。
设置 `DONICHANNEL_VAD_DEBUG=1` 可输出开门/关门状态转换日志。

它不负责：

```text
降噪
变声
增益
VAD
设备选择
LiveKit 发布
```

这些逻辑应该分别放在 Rust 或 feature 模块中。

## 为什么不直接用浏览器麦克风

使用 Rust 麦克风的原因：

```text
1. 可以统一控制 Windows 输入设备
2. 可以在 Rust 侧做降噪、限幅、门限处理
3. 可以和应用音频共享保持一致的本地管线
4. 后续更容易接入底层音频增强能力
```

## 音频数据格式

前端 AudioWorklet 和 WebAudio 使用标准 Float32 PCM：

```text
采样范围：[-1.0, 1.0]
字节格式：little-endian f32
推荐采样率：48000Hz
通道：单声道
```

如果 Rust 侧使用 RNNoise，需要注意量纲转换：

```text
WebAudio: [-1.0, 1.0]
RNNoise: 约 [-32768.0, 32767.0]
```

正确流程：

```text
输入给 RNNoise 前 ×32768
RNNoise 输出后 ÷32768
再做增益、Limiter、RMS、发送
```

不要直接把 RNNoise 的 32768 量级输出发给前端，否则会导致绿线满格和严重失真。

## 资源释放原则

停止音频时必须释放：

```text
WebSocket
AudioWorkletNode
MediaStreamTrack
AudioContext
LiveKit publication
```

切频道时要特别注意顺序：

```text
停止本地发布
断开旧房间
连接新房间
根据之前状态恢复麦克风
```

## 常见日志定位

看到以下日志说明 9002 麦克风链路已连接：

```text
[Rust PCM WS] 已连接 ws://127.0.0.1:9002
[Rust PCM] 管线已初始化
[Rust Mic] 已发布到当前频道
```

看到以下日志说明 9001 应用音频链路已连接：

```text
[PCM WS] 已连接 ws://127.0.0.1:9001
[PCM] 管线已初始化
```

## 后续扩展建议

如果后续要新增音频功能，例如：

```text
AI 降噪开关
增益预设
噪声门参数设置
麦克风测试录音
输入设备延迟测试
```

建议按以下结构新增：

```text
features/rustMic.js        业务动作
features/audioPipelines.js 底层音频管线
stores/appStore.js         UI 状态
components/settings/       设置界面
```

不要把音频新功能直接写进 Vue 组件或 legacy 文件。
