# 架构说明

本文档说明项目整体架构、前后端职责、模块边界以及后续扩展方向。

## 总体架构

```text
Vue 3 UI
  ↓
features 业务模块
  ↓
Tauri invoke / LiveKit SDK / WebSocket / AudioWorklet
  ↓
Rust WASAPI 本地音频能力 + LiveKit 服务端
```

项目由三部分组成：

```text
1. Vue 前端界面
2. Tauri 桌面壳和本地 API 桥接
3. Rust 音频采集与本地 WebSocket 音频推流
```

## 前端层次

```text
ui/src/
├─ app/          应用运行时装配层
├─ stores/       轻量状态层
├─ features/     业务功能层
├─ components/   Vue 组件层
├─ shared/       通用工具层
└─ legacy/       兼容入口
```

### 组件层

组件负责显示，不负责复杂业务。

例如：

- 频道列表显示
- 成员列表显示
- 控制按钮显示
- 聊天面板显示
- 应用音频弹窗显示

组件应该尽量通过事件把用户操作交给 runtime 或 feature。

### 状态层

store 用来保存 UI 状态，例如：

```text
当前频道
是否已连接
是否开麦
是否屏幕共享
是否打开弹窗
当前选择的设备
```

store 不保存重型运行对象，例如：

```text
LiveKit Room
AudioContext
WebSocket
MediaStreamTrack
AudioWorkletNode
```

### 业务层

feature 模块负责实际业务动作，例如：

```text
roomConnection.js    进大厅、进频道、切频道
rustMic.js           Rust 麦克风发布和停止
audioPipelines.js    9001/9002 音频管线
appAudio.js          应用音频共享
screenShare.js       屏幕共享
livekitEvents.js     LiveKit 事件绑定
participants.js      成员列表和说话状态
remoteAudio.js       远端音频音量控制
devices.js           麦克风和扬声器选择
chat.js              聊天
```

## Tauri 与 Rust 边界

前端通过 Tauri `invoke` 调用 Rust 命令。

主要命令包括：

```text
get_active_processes
start_capture
start_capture_multi
set_mic_vad_threshold
toggle_rust_mic
list_capture_devices
set_rust_mic_device_id
query_mic_sample_rate
set_mic_boost
```

前端不直接操作 Windows WASAPI。所有底层音频采集都在 Rust 中完成。

## 音频链路

项目有两条本地音频链路：

```text
9001：应用/进程音频共享
9002：Rust 麦克风采集
```

两条链路都通过：

```text
Rust WASAPI → WebSocket → AudioWorklet → MediaStreamTrack → LiveKit publishTrack
```

更多细节见 `docs/AUDIO_PIPELINE.md`。

## LiveKit 边界

LiveKit 负责房间连接、音视频轨道发布和订阅。

前端不要在多个地方分散创建 Room。房间连接、切频道和事件绑定应集中在 room/livekit 相关 feature 中。

当前已加入频道的成员集合以 LiveKit `localParticipant + remoteParticipants` 为权威来源；
Presence 只补充头像、昵称和状态。未加入的其他频道继续使用 Presence 成员快照。

## Presence 有序协议与存活检测

`/ws/presence` 使用服务端启动级 `serverEpoch` 和单调递增 `seq`。快照与所有状态
增量都携带这两个字段；客户端遇到跳号会请求新快照，epoch 改变会重建同步状态。
客户端每 12 秒 ping，30 秒未收到 pong 会主动断开并按带随机抖动的指数退避重连。

服务端默认每 5 秒清理一次，45 秒未收到任何入站消息即清除连接。可用环境变量调整：

```text
DONICHANNEL_PRESENCE_CLEANUP_INTERVAL_SECONDS=5
DONICHANNEL_PRESENCE_TTL_SECONDS=45
```

本次未接入 LiveKit webhook：当前仓库没有部署侧 webhook URL/签名配置，强行启用会扩大
改动并产生不可靠的未验签入口。现有 `join_channel` 仍作为其他频道 Presence 数据的兼容
来源。后续部署 webhook 时应只接收 `participant_joined`、`participant_left`、
`participant_connection_aborted`、`room_finished`，并复用同一 epoch/seq 广播路径；同时在
LiveKit 服务端配置回调 URL、API key/secret，并验证签名。

## 后续 Discord-like UI 扩展方向

如果后续要改成更接近 Discord 的 UI，推荐新增：

```text
components/layout/
├─ AppShell.vue
├─ ServerRail.vue
├─ ChannelSidebar.vue
├─ MainContent.vue
├─ MemberSidebar.vue
└─ UserDock.vue
```

同时建议把频道数据模型从简单数组升级为：

```js
{
  id: 'server-1',
  name: '小豆泥电竞',
  categories: [
    {
      id: 'voice',
      name: '语音频道',
      channels: [
        { id: 'day0', name: 'day0', type: 'voice' }
      ]
    }
  ]
}
```

## 架构原则

```text
组件管 UI
features 管业务
stores 管状态
shared 管工具
legacy 只做兼容
```

只要后续开发遵守这个边界，项目就不容易重新变成大文件堆叠结构。
