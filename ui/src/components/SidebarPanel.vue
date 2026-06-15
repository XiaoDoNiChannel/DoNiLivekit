<script setup>
import ChannelList from './ChannelList.vue';
import ParticipantList from './ParticipantList.vue';
import VadPanel from './VadPanel.vue';
import ControlDock from './ControlDock.vue';

defineEmits([
  'join-room',
  'create-channel',
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
  <aside id="sidebar">
    <div class="sidebar-title">📡 频道登录</div>
    <div id="login-section" class="input-group">
      <input id="server-ip" type="text" placeholder="服务器IP:端口，例如 127.0.0.1:5000">
      <input id="username" type="text" placeholder="请输入你的开黑昵称...">
      <button id="btn-connect" class="primary-btn" @click="$emit('join-room')">进入大厅</button>
    </div>

    <div class="section-title-row">
      <div class="sidebar-title" style="margin: 0;">🔊 语音分组</div>
      <button class="tiny-btn" title="创建频道" @click="$emit('create-channel')">+</button>
    </div>
    <ChannelList />

    <div class="sidebar-title" style="margin-top: 10px;">👥 在线成员 (<span id="user-count">0</span>)</div>
    <ParticipantList />

    <VadPanel />

    <ControlDock
      @switch-mic="$emit('switch-mic', $event)"
      @switch-output="$emit('switch-output', $event)"
      @toggle-mic="$emit('toggle-mic')"
      @toggle-monitor="$emit('toggle-monitor')"
      @toggle-screen="$emit('toggle-screen')"
      @app-audio-click="$emit('app-audio-click')"
      @leave="$emit('leave')"
    />
  </aside>
</template>
