# Stage 8：终极前端框架版

这一版基于 Stage 7 稳定包继续整理，目标不是重写业务，而是把前端整理成后续可持续加功能的框架。

## 核心原则

1. 不动 Rust 后端，不改 9001 / 9002 音频链路。
2. 不重写 LiveKit 发布 / 订阅 / 切频道恢复逻辑。
3. 把前端分成四层：app runtime、stores、features、components。
4. 新功能以后优先接入 stores + features + components，不再继续堆到 legacy/client.js。

## 目录结构

```text
src/
├─ app/
│  └─ runtime.js              # 应用运行时装配层，统一连接 feature、store、Vue action
├─ stores/
│  └─ appStore.js             # 轻量状态层，后续新 UI 和新功能优先读取这里
├─ legacy/
│  └─ client.js               # 兼容入口，只 re-export runtime；不要继续堆业务
├─ features/
│  ├─ audioPipelines.js       # 9001/9002 PCM -> AudioWorklet -> MediaStreamTrack
│  ├─ appAudio.js             # 应用音频共享
│  ├─ chat.js                 # 聊天发送/渲染
│  ├─ devices.js              # 麦克风/扬声器设备选择
│  ├─ livekitEvents.js        # LiveKit 远端音视频事件
│  ├─ participants.js         # 成员列表和说话高亮
│  ├─ remoteAudio.js          # 远端音频 GainNode / 音量保存
│  ├─ roomConnection.js       # 大厅、频道、进房间、切频道
│  ├─ rustMic.js              # Rust 麦克风发布/停止/mic_error
│  └─ screenShare.js          # 屏幕共享
├─ components/
│  ├─ sidebar/                # 侧栏、频道、成员、VAD 面板
│  ├─ controls/               # 左下角控制坞
│  ├─ main/                   # 主舞台
│  ├─ chat/                   # 聊天面板
│  └─ modals/                 # 弹窗
├─ shared/
│  ├─ constants.js
│  ├─ tauri.js
│  └─ text.js
├─ App.vue
└─ main.js
```

## Stage 8 做了什么

### 1. 把 legacy/client.js 降级为兼容入口

原来的 coordinator 迁移到：

```text
src/app/runtime.js
```

现在 `legacy/client.js` 只负责：

```js
export * from '../app/runtime.js';
```

保留它是为了兼容旧路径和少量 window.xxx 调用。

### 2. 增加 stores/appStore.js

新增轻量 store：

```text
connection: 当前频道、是否连接、服务器地址、用户名
media: 麦克风、Rust 麦克风、屏幕共享、应用音频、耳返状态
devices: 当前麦克风、扬声器选择
ui: 弹窗、错误、更新时间
```

注意：store 不存 LiveKit Room、AudioContext、MediaStreamTrack 这种重对象。重对象继续由 features 持有。

### 3. 组件目录按领域重新整理

原来所有 Vue 组件都在 components 根目录，现在改为：

```text
components/sidebar/
components/controls/
components/main/
components/chat/
components/modals/
```

这样后续做 Discord-like UI 时，可以继续扩展：

```text
components/layout/ServerRail.vue
components/layout/ChannelSidebar.vue
components/layout/MemberSidebar.vue
components/settings/SettingsModal.vue
```

### 4. runtime 同步轻量状态到 appStore

`runtime.js` 会在关键 action 后同步状态，例如：

```text
joinRoom / switchChannel / toggleMic / toggleScreen / appAudio / output switch
```

后续新组件可以逐步从 `appStore` 读取状态，而不是继续 document.getElementById。

## 后续加功能怎么写

### 新 UI

放到 `src/components/<domain>/`。

### 新业务逻辑

放到 `src/features/<featureName>.js`。

### 新全局状态

放到 `src/stores/appStore.js` 或新建独立 store。

### 新 Tauri 调用

统一通过 `src/shared/tauri.js` 的 `invoke`。

### 不建议继续做的事

不要把新功能继续塞进：

```text
legacy/client.js
```

不要在 Vue 组件里直接写复杂的 LiveKit / Tauri / AudioContext 逻辑。

## 自检

已执行：

```bash
find src -name '*.js' -print0 | xargs -0 -n1 node --check
npm run build
```

结果通过。

## 测试建议

覆盖后测试：

1. 页面启动。
2. 进入大厅。
3. 自动进入 day0。
4. Rust 麦克风发布。
5. 绿线跳动。
6. 切 day0/day1 后麦克风恢复。
7. 麦克风设备切换。
8. 扬声器切换。
9. 应用音频共享。
10. 屏幕共享。
11. 聊天发送/接收。
12. 离开房间释放资源。

