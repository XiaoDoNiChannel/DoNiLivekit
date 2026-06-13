# stores/

`stores/` 是后续继续 Vue 化和 Discord-like UI 的状态层。

当前 `appStore.js` 是轻量状态桥：老业务链路仍稳定运行，新组件可以逐步读取 store。

不要在 store 中保存：

```text
LiveKit Room
AudioContext
MediaStreamTrack
WebSocket
AudioWorkletNode
```

这些重对象应该继续由 `features/` 持有。
