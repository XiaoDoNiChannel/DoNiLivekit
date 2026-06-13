# components/

组件按 UI 领域分组，方便后续改成 Discord-like 布局。

```text
sidebar/   频道、成员、登录、VAD 面板
controls/  左下角用户控制坞
main/      主舞台、视频/屏幕共享区域
chat/      聊天区
modals/    弹窗
```

新 UI 组件优先放在对应领域目录下，不要混回 features 或 legacy。
