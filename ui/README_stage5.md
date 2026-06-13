# Stage 5：音频底层管线模块拆分

本阶段基于 Stage 4 稳定版本继续重构，目标是减少 `src/legacy/client.js` 的体积，同时不改变已经稳定的 LiveKit 发布和切频道逻辑。

## 本阶段拆出的模块

新增：

```text
src/features/audioPipelines.js
```

该模块只负责底层 PCM 管线：

```text
Rust 9001 应用音频 WebSocket
→ AudioWorklet pcm-worker.js
→ MediaStreamTrack
→ appAudio.js 发布 app-audio

Rust 9002 麦克风 WebSocket
→ AudioWorklet pcm-worker.js
→ MediaStreamTrack
→ client.js 发布 microphone
```

同时，Rust 麦克风耳返监听开关也移动到了该模块内。

## 本阶段刻意没有改的部分

以下逻辑仍然留在 `legacy/client.js`，因为它们与 LiveKit 房间状态和切频道恢复强耦合：

```text
startRustMicShare()
stopRustMicShare()
toggleMic()
joinRoom()
connectToChannel()
switchChannel()
LiveKit RoomEvent 绑定
```

这不是遗漏，而是为了避免一次性移动房间状态、麦克风发布状态、切频道恢复状态导致新问题。

## 自检结果

已执行：

```bash
node --check src/legacy/client.js
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
node --check src/main.js
```

语法检查通过。

## 替换后建议测试

```text
1. 页面是否正常启动
2. 进入大厅是否正常
3. 自动进入 day0 是否正常
4. Rust 麦克风是否正常发布
5. 绿线是否正常跳动
6. 耳返监听按钮是否正常
7. 切频道后麦克风是否自动恢复
8. 应用音频共享是否正常
9. 应用音频停止后是否能释放 9001 管线
10. 扬声器切换是否仍影响远端音频和耳返
```
