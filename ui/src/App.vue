<script setup>
import { nextTick, onMounted, ref } from 'vue';
import SidebarPanel from './components/sidebar/SidebarPanel.vue';
import MainStage from './components/main/MainStage.vue';
import AppAudioModal from './components/modals/AppAudioModal.vue';
import ChatPanel from './components/chat/ChatPanel.vue';
import AudioSettingsModal from './components/settings/AudioSettingsModal.vue';
import UpdateNotice from './components/modals/UpdateNotice.vue';
import {
  initLegacyDom,
  joinRoom,
  createChannel,
  switchChannel,
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
// 业务动作统一进入 app/runtime.js；这里不直接调用 LiveKit、Tauri 或 AudioWorklet。
const isSettingsOpen = ref(false);

function openSettings() {
  isSettingsOpen.value = true;
}

function closeSettings() {
  isSettingsOpen.value = false;
}

onMounted(async () => {
  await nextTick();
  initLegacyDom();
});
</script>

<template>
  <div class="app-shell single-server-shell">
    <SidebarPanel
      @join-room="joinRoom"
      @create-channel="createChannel"
      @switch-channel="switchChannel"
      @toggle-mic="toggleMic"
      @toggle-monitor="toggleMicMonitor"
      @toggle-screen="toggleScreen"
      @app-audio-click="handleAppAudioClick"
      @leave="leaveRoom"
      @open-settings="openSettings"
    />

    <MainStage />

    <ChatPanel
      @send="(text) => sendChatMessage(text)"
      @retry="(clientMessageId) => sendChatMessage('', clientMessageId)"
    />

    <AudioSettingsModal
      :open="isSettingsOpen"
      @close="closeSettings"
      @switch-mic="switchMic"
      @switch-output="switchAudioOutput"
    />

    <AppAudioModal
      @close="closeAppAudioModal"
      @confirm="confirmAppAudioSelection"
    />

    <UpdateNotice />
  </div>
</template>
