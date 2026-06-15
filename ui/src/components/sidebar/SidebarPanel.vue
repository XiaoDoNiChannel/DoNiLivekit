<script setup>
import ChannelList from './ChannelList.vue';
import ParticipantList from './ParticipantList.vue';
import ControlDock from '../controls/ControlDock.vue';

defineEmits([
  'join-room',
  'create-channel',
  'switch-channel',
  'toggle-mic',
  'toggle-monitor',
  'toggle-screen',
  'app-audio-click',
  'leave',
  'open-settings',
]);
</script>

<template>
  <aside id="sidebar" class="channel-sidebar">
    <header class="sidebar-server-header">
      <div class="server-title-block">
        <div class="server-name">DoNiChannel</div>
        <div class="server-subtitle">局域网语音大厅</div>
      </div>
      <button class="server-header-btn" title="设置" @click="$emit('open-settings')">⚙</button>
    </header>

    <div class="sidebar-scroll-area">
      <section id="login-section" class="login-card">
        <div class="section-label">连接信息</div>
        <input id="server-ip" type="text" placeholder="服务器IP:端口，例如 127.0.0.1:5000">
        <input id="username" type="text" placeholder="请输入你的开黑昵称...">
        <button id="btn-connect" class="primary-btn" @click="$emit('join-room')">进入大厅</button>
      </section>

      <section class="voice-channel-section">
        <div class="section-title-row channel-section-title">
          <div class="sidebar-title">语音频道</div>
          <button class="tiny-btn" title="创建频道" @click="$emit('create-channel')">+</button>
        </div>
        <ChannelList @switch-channel="$emit('switch-channel', $event)" />
      </section>

      <details class="sidebar-foldout members-foldout legacy-volume-foldout">
        <summary>
          <span>高级音量面板</span>
          <span class="summary-count" id="user-count">0</span>
        </summary>
        <ParticipantList />
      </details>
    </div>

    <ControlDock
      @toggle-mic="$emit('toggle-mic')"
      @toggle-monitor="$emit('toggle-monitor')"
      @toggle-screen="$emit('toggle-screen')"
      @app-audio-click="$emit('app-audio-click')"
      @leave="$emit('leave')"
      @open-settings="$emit('open-settings')"
    />
  </aside>
</template>
