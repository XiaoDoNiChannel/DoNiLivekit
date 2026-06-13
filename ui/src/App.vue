<script setup>
import { nextTick, onMounted } from 'vue';
import SidebarPanel from './components/sidebar/SidebarPanel.vue';
import MainStage from './components/main/MainStage.vue';
import AppAudioModal from './components/modals/AppAudioModal.vue';
import ChatPanel from './components/chat/ChatPanel.vue';
import {
  initLegacyDom,
  joinRoom,
  createChannel,
  switchMic,
  switchAudioOutput,
  toggleMic,
  toggleMicMonitor,
  toggleScreen,
  handleAppAudioClick,
  leaveRoom,
  closeAppAudioModal,
  confirmAppAudioSelection,
  sendChatMessage,
} from './app/runtime.js';

// App.vue 只负责页面骨架和事件转发。
// 运行时统一放在 app/runtime.js；业务模块放在 features/；状态模型放在 stores/。
// 这里不直接写 LiveKit / Tauri / AudioWorklet 逻辑，方便后续继续升级 Discord-like UI。
onMounted(async () => {
  await nextTick();
  initLegacyDom();
});
</script>

<template>
  <SidebarPanel
    @join-room="joinRoom"
    @create-channel="createChannel"
    @switch-mic="switchMic"
    @switch-output="switchAudioOutput"
    @toggle-mic="toggleMic"
    @toggle-monitor="toggleMicMonitor"
    @toggle-screen="toggleScreen"
    @app-audio-click="handleAppAudioClick"
    @leave="leaveRoom"
  />

  <MainStage />

  <AppAudioModal
    @close="closeAppAudioModal"
    @confirm="confirmAppAudioSelection"
  />

  <ChatPanel @send="sendChatMessage" />
</template>
