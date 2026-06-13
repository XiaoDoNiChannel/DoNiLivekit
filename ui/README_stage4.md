# Vue3 重构 Stage 4：批量拆分低/中风险前端模块

本阶段基于 Stage 3 设备模块拆分包继续修改。

## 本阶段目标

这次不再只拆一个小函数组，而是一次性把以下功能从 `src/legacy/client.js` 中拆出去：

1. `src/features/appAudio.js`
   - 应用音频共享弹窗
   - 应用进程扫描
   - PID 选择状态
   - Rust 9001 应用音频采集启动
   - 应用音频 LiveKit 发布/取消发布

2. `src/features/screenShare.js`
   - 屏幕共享开启/关闭
   - 系统音频预检查
   - 屏幕共享失败降级提示
   - 本地屏幕预览
   - 屏幕共享码率监控

3. `src/features/chat.js`
   - LiveKit data channel 聊天发送
   - 聊天消息渲染

4. `src/features/remoteAudio.js`
   - 远端音频 GainNode 路由
   - 远端音量百分比设置
   - 远端音量持久化联动
   - 远端音频轨道清理

## 仍然保留在 client.js 的内容

以下功能仍保留在 `src/legacy/client.js`，因为它们和 LiveKit 房间状态、Rust 9002 麦克风、频道切换强耦合：

- `joinRoom()`
- `connectToChannel()`
- `switchChannel()`
- `toggleMic()`
- `startRustMicShare()`
- `initRustMicPipeline()`
- `initLocalPcmPipeline()`
- `TrackSubscribed / TrackUnsubscribed` 等 LiveKit 事件绑定

## 为什么没有继续强拆麦克风核心

Rust 麦克风链路包含：

- Tauri invoke
- 9002 WebSocket
- AudioWorklet
- MediaStreamDestination
- LiveKit publishTrack
- 切频道后重新发布
- 耳返监听

它是目前项目里最高风险链路。既然现在测试已经稳定，本阶段只拆外围功能，避免再次引入“图标开着但别人听不到”或“绿线异常”的问题。

## 替换方式

把本包解压后，将里面内容覆盖到你的：

```text
F:\livekit_pack\ui
```

确保最终有这些文件：

```text
ui/src/features/appAudio.js
ui/src/features/screenShare.js
ui/src/features/chat.js
ui/src/features/remoteAudio.js
ui/src/features/devices.js
ui/src/features/participantVolumes.js
ui/src/shared/tauri.js
ui/src/shared/constants.js
ui/src/shared/text.js
ui/src/legacy/client.js
```

## 运行

```powershell
cd F:\livekit_pack
npx tauri dev
```

## 测试清单

1. 页面是否正常显示。
2. 进入大厅是否正常。
3. 是否自动进入第一个频道。
4. Rust 麦克风是否自动开启。
5. 绿线是否正常跳动。
6. 切 day0/day1 后麦克风是否恢复发布。
7. 应用音频共享是否正常。
8. 应用音频弹窗是否能选择进程。
9. 屏幕共享是否正常。
10. 屏幕共享本地预览是否正常。
11. 聊天发送/接收是否正常。
12. 远端用户音量百分比是否仍然能保存。

## 下一阶段建议

如果 Stage 4 稳定，下一阶段可以拆：

- `roomConnection.js`：joinRoom / connectToChannel / switchChannel
- `rustMic.js`：Rust 9002 麦克风 pipeline

但这两个建议分开做，不要同一轮一起拆。
