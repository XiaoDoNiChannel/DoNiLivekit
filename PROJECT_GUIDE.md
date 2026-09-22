# 项目开发指南

本文档面向后续参与开发的同学，说明本项目的前端结构、模块职责、音频链路边界和新增功能规范。

## 当前架构定位

本项目当前采用的是：

```text
Vue 组件化 UI
+ feature 业务模块
+ store 状态层
+ Tauri/Rust 本地能力
+ 少量 legacy 兼容入口
```

这不是完全重写后的纯 Vue reactive 项目，而是在保证 Rust 音频、LiveKit、切频道恢复等核心链路稳定的前提下，整理出来的长期可维护结构。

## 目录职责

```text
ui/src/
├─ app/
│  └─ runtime.js
├─ stores/
│  └─ appStore.js
├─ features/
├─ components/
├─ shared/
└─ legacy/
```

### `app/runtime.js`

应用运行时装配层。负责：

- 初始化全局状态
- 初始化各 feature 模块
- 绑定旧 DOM 兼容函数
- 提供给 `App.vue` 调用的业务入口

不要在这里堆大量新业务逻辑。如果一个功能超过几十行，应该拆到 `features/`。

### `stores/appStore.js`

轻量状态层。负责保存 UI 需要读取的状态，例如：

- 当前是否已进入大厅
- 当前频道
- 是否开麦
- 是否屏幕共享
- 当前选择的麦克风/扬声器
- 弹窗打开状态
- 错误提示状态

不要把重对象放进 store，例如：

- LiveKit Room
- AudioContext
- MediaStreamTrack
- WebSocket
- AudioWorkletNode

这些对象生命周期复杂，应该留在 `features/` 中管理。

### `features/`

业务模块层。负责真正执行动作，例如：

- 调用 Tauri `invoke`
- 连接 LiveKit 房间
- 发布/取消发布音视频 track
- 创建 AudioContext
- 管理 WebSocket
- 处理屏幕共享
- 处理应用音频共享

feature 模块应该尽量少直接操作 DOM。理想情况下，feature 更新 store，由 Vue 组件自动渲染 UI。

### `components/`

Vue 组件层。负责展示 UI 和触发事件。

组件里不要直接写复杂业务，例如：

```js
invoke('toggle_rust_mic')
room.localParticipant.publishTrack(...)
document.getElementById(...)
```

组件应该通过 props、emits 或 runtime 暴露的方法触发动作。

### `shared/`

通用工具层。适合放：

- Tauri invoke/listen 封装
- 常量
- 文本转义
- 错误信息格式化
- 通用工具函数

### `legacy/`

兼容入口。当前 `legacy/client.js` 只用于保持历史导入路径或旧 HTML 调用兼容。

后续不要继续往 `legacy/client.js` 中新增业务。

## 新增功能规范

新增功能时，按照以下顺序思考：

### 1. 这个功能是否有状态？

有状态就放到 `stores/appStore.js` 或新增专门 store。

例如：

```text
ui.isSettingsOpen
media.isMicOn
devices.selectedMicId
connection.currentChannel
```

### 2. 这个功能是否有业务动作？

有业务动作就放到 `features/xxx.js`。

例如新增“用户设置”：

```text
features/settings.js
```

里面放：

```js
loadSettings()
saveSettings()
resetSettings()
```

### 3. 这个功能是否有界面？

有界面就放到 `components/`。

例如：

```text
components/modals/SettingsModal.vue
components/settings/AudioSettings.vue
components/settings/AppearanceSettings.vue
```

### 4. 是否需要通用工具？

通用工具放到 `shared/`。

## 错误处理规范

错误信息必须包含模块名和动作名，方便定位问题。

推荐格式：

```text
模块名/函数名：具体错误说明
```

示例：

```js
throw new Error(`rustMic/startRustMicShare：Rust 麦克风发布失败：${message}`);
```

`catch` 中不要只写：

```js
console.error(error);
```

应该写：

```js
console.error('rustMic/startRustMicShare：启动 Rust 麦克风失败', error);
```

## 不要做的事

后续开发中避免：

```text
1. 把新功能直接写进 legacy/client.js
2. 在 Vue 组件里直接操作 AudioContext 或 LiveKit Room
3. 在 feature 模块里大段拼 innerHTML
4. 把 MediaStreamTrack、AudioContext、WebSocket 放进 store
5. 为了改 UI 去重写 9001/9002 音频管线
6. 一次性同时改 UI、音频、房间连接和 Rust 后端
```

## 推荐功能开发流程

每次加功能建议按以下流程：

```text
1. 新建 feature 分支
2. 明确功能属于 UI / feature / store / shared 哪一层
3. 小步提交
4. 每次修改后测试核心链路
5. 合并前检查日志和错误提示
```

核心回归测试清单：

```text
页面启动
进入大厅
自动进入默认语音频道
Rust 麦克风发布
绿线跳动
切换频道后麦克风恢复
麦克风设备切换
扬声器切换
应用音频共享
屏幕共享
聊天发送/接收
离开房间资源释放
```

## Rust、Python 与 Vue 的边界

- Vue 负责交互、LiveKit 房间/轨道和更新状态展示，不自行下载或执行安装包。
- Rust/Tauri 负责 WASAPI、9001/9002、本机状态、日志和签名 updater。
- FastAPI 负责 token、房间/聊天/资料、Presence/Chat WebSocket、SQLite 迁移以及局域网更新分发。
- LiveKit 仍负责实时音视频；禁止把 token、音频帧或大型二进制写入日志。

Rust command 的外部名称和参数是兼容边界。实现代码应放在 `commands/`、`audio/`、`state.rs` 或 `transport/`，`lib.rs` 只做装配。Python 新数据库访问应进入 `server/db/`，新请求体优先使用 `server/models/` 中允许兼容额外字段的 Pydantic 模型。

## Legacy 规则

- `ui/src/legacy/client.js` 和 `ui/pcm-worker.js` 仅保留旧导入/路径兼容，禁止增加业务。
- 唯一 Worklet 实现在 `ui/public/pcm-worker.js`。
- 根目录 `old/` 是本机历史归档，不参与构建、不作为真源、禁止继续扩展；删除前需由维护者确认归档价值。
- 当前组件真源位于 `components/sidebar/`、`components/main/`、`components/modals/` 和 `components/controls/`；未引用的根级重复组件已经清理。

## 数据库变更规则

只允许在 `server/db/migrations.py` 添加单调递增、前向兼容的迁移。迁移不得删除用户表或数据；旧库第一次进入新版本前会生成 `rooms.db.backup-vX-to-vY-时间`。测试必须覆盖临时数据库，禁止把仓库根目录的 `rooms.db` 作为测试目标。
