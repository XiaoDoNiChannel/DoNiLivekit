<template>
  <!--
    成员列表容器。
    participants.js 会根据 LiveKit local/remote participant 状态动态写入成员卡片、
    音量滑块和 active-speaker 高亮。保留 id，避免破坏现有渲染入口。
  -->
  <div id="participant-list">
    <div style="font-size: 12px; color: #80848e; text-align: center; margin-top: 20px;">
      加入频道后显示在线人员
    </div>
  </div>
</template>
