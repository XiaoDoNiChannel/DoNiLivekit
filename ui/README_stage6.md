# Stage 6 核心逻辑模块化说明

本版本基于 Stage 5 稳定版本继续重构。目标是把 `legacy/client.js` 从“大杂烩协调文件”压缩成模块装配层，同时不改变已稳定的音频链路行为。

## 本阶段拆分范围

新增模块：

```text
src/features/roomConnection.js
src/features/rustMic.js
src/features/livekitEvents.js
src/features/participants.js
```

### roomConnection.js

负责：

- 服务器地址解析；
- 频道列表渲染；
- 频道列表轮询；
- 创建频道；
- 进入大厅；
- 连接 LiveKit 频道；
- 切频道时停止本地资源、断开旧频道、连接新频道、恢复麦克风；
- 离开房间时释放资源。

该模块不直接处理 PCM 音频底层，也不处理远端 Track 的 DOM 挂载。

### rustMic.js

负责：

- Rust 9002 麦克风发布到 LiveKit；
- startRustMicShare / stopRustMicShare / toggleMic；
- 麦克风源切换；
- mic_error 监听；
- 麦克风按钮状态和 VAD 面板显示。

该模块不直接处理 WebSocket PCM 数据；底层 PCM 管线仍在 `audioPipelines.js`。

### livekitEvents.js

负责：

- RoomEvent.TrackSubscribed；
- RoomEvent.TrackUnsubscribed；
- 远端视频挂载；
- 远端音频挂载；
- 屏幕分享包装盒、单击聚焦、双击全屏；
- 本地屏蔽远端屏幕共享；
- DataReceived 聊天消息；
- TrackMuted / TrackUnmuted / TrackPublished / TrackUnpublished 等成员刷新事件。

该模块只绑定事件，不创建 Room，也不连接服务器。

### participants.js

负责：

- 成员列表渲染；
- 麦克风/屏幕/应用音频音量滑块；
- active-speaker 状态维护；
- active-speaker 局部 UI 更新。

## client.js 变化

`src/legacy/client.js` 从 Stage 5 的约 1317 行压缩到约 373 行。

它现在主要负责：

- import 模块；
- 保存少量跨模块共享状态；
- 创建 feature 实例；
- 保留兼容旧 onclick 的 window 挂载；
- 初始化 DOM 事件监听。

## 保留不变的重点链路

本阶段没有重写：

- 9001 应用音频 PCM 管线；
- 9002 Rust 麦克风 PCM 管线；
- AudioWorklet 处理器；
- Rust 麦克风 publishTrack 参数；
- 应用音频共享流程；
- 屏幕共享采集参数；
- Tauri 后端配置。

## 自检结果

已执行：

```bash
node --check src/legacy/client.js
node --check src/features/participants.js
node --check src/features/livekitEvents.js
node --check src/features/rustMic.js
node --check src/features/roomConnection.js
node --check src/features/audioPipelines.js
node --check src/features/appAudio.js
node --check src/features/devices.js
node --check src/features/screenShare.js
node --check src/features/chat.js
node --check src/features/remoteAudio.js
node --check src/features/participantVolumes.js
node --check src/shared/tauri.js
node --check src/shared/constants.js
node --check src/shared/text.js
```

已执行 Vite 构建检查：

```bash
npm install
npm run build
```

构建通过。

## 替换后重点测试

请按顺序测试：

1. Tauri 页面是否正常启动；
2. 进入大厅是否正常；
3. 自动进入 day0 是否正常；
4. Rust 麦克风是否自动发布；
5. 绿线是否正常跳动；
6. 切 day0/day1 后麦克风是否恢复；
7. 麦克风设备切换是否正常；
8. 扬声器切换是否正常；
9. 远端音频是否正常播放；
10. 别人的音量百分比是否还能保存；
11. 应用音频共享是否正常；
12. 屏幕共享、单击聚焦、双击全屏、屏蔽屏幕是否正常；
13. 聊天发送/接收是否正常；
14. 离开房间是否能释放资源并刷新。

## 下一阶段建议

如果 Stage 6 稳定，下一步再做最终 Vue 组件化和清理。那一步会开始减少 inline onclick 和 window 挂载，但不会再大幅改 Rust 音频链路。
