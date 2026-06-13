# Stage 7：Vue 组件化收尾版

本阶段基于已经稳定的 Stage 6 继续，没有修改 Rust 后端，也没有改动 9001/9002 PCM 音频链路。

## 本阶段目标

最早的重构初衷是：

1. 让 Vue3 接管页面结构；
2. 把原先过大的 client.js 拆成更容易维护的模块；
3. 保持 Rust 麦克风、应用音频、屏幕共享、切频道恢复等核心链路稳定；
4. 以后改功能时可以清楚知道该改哪个文件。

Stage 7 做的是最后一步页面结构整理：把 App.vue 的大模板拆成多个组件，同时继续保留原有 DOM id 和模块入口，不做高风险业务重写。

## 新增组件

新增目录：

```text
src/components/
├─ SidebarPanel.vue        左侧整体侧栏
├─ ChannelList.vue         频道列表占位容器，内容仍由 roomConnection.js 渲染
├─ ParticipantList.vue     成员列表占位容器，内容仍由 participants.js 渲染
├─ VadPanel.vue            Rust 麦克风阈值/增益 UI
├─ ControlDock.vue         左下角控制坞、麦克风/扬声器/屏幕/应用音频按钮
├─ MainStage.vue           主视频舞台、本地屏幕预览容器
├─ AppAudioModal.vue       应用音频进程选择弹窗
└─ ChatPanel.vue           聊天面板
```

## 重要边界

这次没有做以下事情：

- 没有改 `src-tauri/src/lib.rs` 或 `main.rs`；
- 没有改 Tauri 指令名；
- 没有改 `startRustMicShare()` / `stopRustMicShare()` 的发布逻辑；
- 没有改 9001 / 9002 WebSocket；
- 没有改 `audioPipelines.js` 的 AudioWorklet 管线；
- 没有把所有 legacy DOM 操作强行改成 Vue reactive。

原因：项目中还有大量 LiveKit 回调、AudioContext、Tauri invoke、动态 Track 渲染和旧 DOM id 依赖。现在最安全的结构是：Vue 组件负责页面骨架，features 模块负责业务，client.js 负责模块装配。

## 当前主要结构

```text
src/
├─ App.vue                 只负责挂载组件和转发事件
├─ components/             Vue 页面组件
├─ features/               业务模块
│  ├─ appAudio.js
│  ├─ audioPipelines.js
│  ├─ chat.js
│  ├─ devices.js
│  ├─ livekitEvents.js
│  ├─ participantVolumes.js
│  ├─ participants.js
│  ├─ remoteAudio.js
│  ├─ roomConnection.js
│  ├─ rustMic.js
│  └─ screenShare.js
├─ legacy/
│  └─ client.js            模块装配层，仍保留少量 window 挂载兼容动态 onclick
├─ shared/
│  ├─ constants.js
│  ├─ tauri.js
│  └─ text.js
└─ assets/
   └─ index.css
```

## 自检结果

已执行：

```bash
node --check src/legacy/client.js
node --check src/features/*.js
node --check src/shared/*.js
node --check src/main.js
npm run build
```

检查通过，Vite production build 通过。

## 替换说明

把压缩包内容覆盖到：

```text
F:\livekit_pack\ui
```

注意：压缩包里的 `tauri.conf.json` 只是参考配置。如果你本地 `src-tauri/tauri.conf.json` 已经稳定，不建议覆盖。

如果需要参考，本包中的 build 配置使用：

```json
"beforeDevCommand": "npm run dev",
"beforeBuildCommand": "npm run build",
"devUrl": "http://localhost:5173",
"frontendDist": "../ui/dist"
```

这是为了避免 `--prefix ./ui` 在某些 Tauri 执行目录下变成 `ui/ui/package.json`。

## 必测项目

1. 页面启动；
2. 进入大厅；
3. 自动进入 day0；
4. Rust 麦克风自动发布；
5. 绿线正常跳动；
6. 切 day0/day1 后麦克风恢复；
7. 麦克风设备切换；
8. 扬声器切换；
9. 应用音频共享；
10. 屏幕共享、本地预览、聚焦、全屏；
11. 聊天发送与接收；
12. 离开房间后资源释放。
