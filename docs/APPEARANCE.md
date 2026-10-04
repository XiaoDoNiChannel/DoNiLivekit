# 客户端外观

底部工具栏的「外观」，或设置中心的「外观」页，可即时切换主题。

- 石墨：中性深灰、淡紫强调色，实色面板。
- 烟玻璃：冷灰磨砂侧栏、底栏和弹层，应用内部背景透色；不会透出桌面壁纸。
- 午夜蓝：海军蓝底色、冰蓝强调色，实色面板。
- 银灰：浅灰背景、白色面板、深色文字。

烟玻璃面板不透明度可调至 65–100%；100% 为实色。不支持背景模糊或系统要求减少透明时使用实色回退。所有主题提供舒适／紧凑间距，动画尊重系统减少动态效果偏好。

主题沿用 `donichannel_theme_v1` 保存键。旧 `doni-dark`、`soft-graphite` 映射到石墨，`glass-dark` 映射到烟玻璃，`midnight-purple` 映射到午夜蓝。无有效偏好时默认烟玻璃。透明度、间距保存在 `donichannel_appearance_v1`。切换不会更改用户资料、音频设备或频道连接。

## 实现入口

- `ui/src/shared/themes.js`：主题目录、旧主题迁移、输入规范化。
- `ui/src/stores/themeStore.js`：持久化偏好与文档主题。
- `ui/src/assets/themes.css`：颜色和材质变量、透明回退。
- `ui/src/assets/appearance.css`：现有工作区、工具栏、设置与弹层的统一样式。
- `ui/src/components/settings/AppearanceSettingsPanel.vue`：主题预览和外观设置。
- `ui/src/features/windowAppearance.js`：顺序同步原生窗口明暗，避免连续点击时旧结果覆盖新选择。

主窗口保留原生标题栏、缩放与关闭行为，深色主题请求 Dark，银灰请求 Light。同步通过现有 Tauri 封装调用 `getCurrentWindow().setTheme()`，仅主窗口授予 `core:window:allow-set-theme`。游戏浮窗沿用已有主题快照链路。

## 验证

```powershell
npm test --prefix ui
npm run build --prefix ui
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

视觉与交互检查需先启动 Vite：

```powershell
npm run dev --prefix ui -- --host 127.0.0.1 --port 5179 --strictPort
# PLAYWRIGHT_MODULE 可指定已安装 Playwright 的绝对路径。
node tests/appearance_smoke.cjs
```

检查使用独立浏览器存储、模拟成员和消息，不连接真实语音频道；覆盖四套主题、保存恢复、透明度、间距、多个窗口宽度以及弹层。截图输出到忽略目录 `tmp/appearance-qa/`。浏览器截图不验证 Windows 原生标题栏，也不替代真实通话回归。
