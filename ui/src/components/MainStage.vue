<template>
  <!--
    主舞台区域。
    远端视频、屏幕共享卡片、本地屏幕预览仍由 livekitEvents.js / screenShare.js
    按原有 id 写入，避免破坏 TrackSubscribed 与本地预览链路。
  -->
  <main id="main-area">
    <div id="header"># 🎮 直播与共享大厅</div>
    <div id="video-container"></div>
    <div id="audio-container"></div>

    <div id="local-screen-preview-box">
      <div id="local-screen-preview-title">本地屏幕预览（静音）</div>
      <video id="local-screen-preview" muted autoplay playsinline></video>
    </div>
  </main>
</template>
