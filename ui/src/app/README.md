# app/

`app/` 是前端运行时层。

- `runtime.js`：创建并连接所有 features，向 Vue 组件暴露 action，向 store 同步轻量状态。
- 新功能需要跨多个 feature 协调时，可以在这里做“装配”，但不要把业务细节写在这里。

原则：

```text
components 负责显示
stores 负责状态
features 负责业务动作
app/runtime 负责装配
```
