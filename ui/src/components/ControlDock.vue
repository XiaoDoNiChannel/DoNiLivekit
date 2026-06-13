<script setup>
defineEmits([
  'switch-mic',
  'switch-output',
  'toggle-mic',
  'toggle-monitor',
  'toggle-screen',
  'app-audio-click',
  'leave',
]);
</script>

<template>
  <!--
    左下角个人控制坞。
    这一阶段只把 DOM 拆成组件，仍保留原 id，方便设备模块、rustMic 模块、roomConnection 模块
    继续通过稳定入口更新按钮状态。
  -->
  <div id="user-control-panel">
    <div
      class="device-selectors"
      style="display: flex; flex-direction: column; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); margin-bottom: 10px;"
    >
      <select
        id="mic-select"
        disabled
        style="width: 100%; background: #1e1f22; color: #dbdee1; border: 1px solid #3b3d44; padding: 6px; border-radius: 6px; font-size: 12px; outline: none; cursor: pointer;"
        @change="$emit('switch-mic', $event.target.value)"
      >
        <option value="">等待权限...</option>
      </select>

      <select
        id="audio-output-select"
        disabled
        style="width: 100%; background: #1e1f22; color: #dbdee1; border: 1px solid #3b3d44; padding: 6px; border-radius: 6px; font-size: 12px; outline: none; cursor: pointer;"
        @change="$emit('switch-output', $event.target.value)"
      >
        <option value="default">默认扬声器</option>
      </select>
    </div>

    <div class="user-profile">
      <div class="avatar">🎮</div>
      <div class="info">
        <div id="ui-username" class="name">未连接大厅</div>
        <div id="ui-status" class="status">等待加入房间</div>
      </div>
    </div>

    <div class="action-grid">
      <button id="btn-mic" class="grid-btn" disabled data-tooltip="开启麦克风" @click="$emit('toggle-mic')">🎤</button>
      <button id="btn-mic-monitor" class="grid-btn" style="display: none;" data-tooltip="监听耳返" @click="$emit('toggle-monitor')">🎧</button>

      <div class="screen-btn-wrapper">
        <button id="btn-screen" class="grid-btn" disabled @click="$emit('toggle-screen')">💻</button>
        <div class="screen-settings-popup">
          <div class="popup-title">💻 共享画质设置</div>
          <select id="screen-res" disabled>
            <option value="1280x720">720P (流畅)</option>
            <option value="1920x1080" selected>1080P (高清)</option>
            <option value="2560x1440">2K (超清)</option>
          </select>
          <div style="display: flex; gap: 8px;">
            <select id="screen-fps" disabled style="flex: 1;">
              <option value="30" selected>30 FPS</option>
              <option value="60">60 FPS</option>
            </select>
            <select id="screen-bitrate" disabled style="flex: 1;">
              <option value="2500">2.5 Mbps</option>
              <option value="5000" selected>5.0 Mbps</option>
              <option value="8000">8.0 Mbps</option>
              <option value="15000">15.0 Mbps</option>
              <option value="20000">20.0 Mbps</option>
              <option value="25000">25.0 Mbps</option>
              <option value="30000">30.0 Mbps</option>
            </select>
          </div>
        </div>
      </div>

      <button id="btn-app-audio" class="grid-btn" disabled data-tooltip="共享应用音频" @click="$emit('app-audio-click')">🎵</button>
      <button id="btn-leave" class="grid-btn danger-btn" style="display: none;" data-tooltip="断开连接" @click="$emit('leave')">🚪</button>
    </div>
  </div>
</template>
