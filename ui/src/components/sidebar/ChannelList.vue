<template>
  <!--
    频道列表容器。
    内容仍由 roomConnection.js 渲染，原因是频道点击、创建、轮询和切频道恢复麦克风
    目前仍依赖既有 legacy 状态链路。这里先保留稳定的 DOM id。
  -->
  <div id="channel-list"></div>
</template>
