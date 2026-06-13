# Vue3 前端重构 Stage 3：设备选择模块拆分

本阶段基于 Stage 2 低风险重构包继续修改。

## 本阶段新增

新增文件：

```text
src/features/devices.js
```

它负责：

- 麦克风列表渲染 `updateMicList()`
- Rust/Tauri 麦克风设备切换 `switchMic()`
- 扬声器列表渲染 `updateAudioOutputList()`
- 输出设备切换 `switchAudioOutput()`
- Windows Endpoint ID 简化显示 `getCleanMicDeviceLabel()`

## 本阶段没有动

没有拆这些高风险链路：

- `initRustMicPipeline()`
- `startRustMicShare()`
- `stopRustMicShare()`
- `initLocalPcmPipeline()`
- `connectToChannel()`
- `switchChannel()`
- 9001/9002 WebSocket 管线
- AudioWorklet

## 替换方法

把本包里的文件复制到 `F:\livekit_pack\ui` 对应位置。

如果你的 `src-tauri/tauri.conf.json` 已经能启动 Vue/Vite，则不需要覆盖 tauri 配置。

## 测试顺序

```text
1. npx tauri dev 能正常打开界面
2. 麦克风下拉框显示真实名称
3. 切换麦克风后 Rust 能录对应设备
4. 开麦状态下切换麦克风会自动重启并重新发布
5. 扬声器下拉框可用
6. 切 day0/day1 后麦克风仍正常
7. 应用音频和屏幕共享仍正常
```
