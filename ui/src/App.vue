<script setup>
import { nextTick, onMounted, ref } from 'vue';
import { X } from 'lucide-vue-next';
import SidebarPanel from './components/sidebar/SidebarPanel.vue';
import MainStage from './components/main/MainStage.vue';
import ControlDock from './components/controls/ControlDock.vue';
import AppAudioModal from './components/modals/AppAudioModal.vue';
import ChatPanel from './components/chat/ChatPanel.vue';
import DiagnosticsPanel from './components/diagnostics/DiagnosticsPanel.vue';
import AudioSettingsModal from './components/settings/AudioSettingsModal.vue';
import UpdateNotice from './components/modals/UpdateNotice.vue';
import WorkspaceDialogs from './components/modals/WorkspaceDialogs.vue';
import { initLegacyDom, joinRoom, createChannel, switchChannel, switchMic, switchMicSource,
  switchAudioOutput, toggleMic, toggleMicMonitor, toggleScreen, handleAppAudioClick, leaveRoom,
  closeAppAudioModal, confirmAppAudioSelection, sendChatMessage, markDiagnosticMoment,
  controlStatusOverlay, saveOverlayPreferences, watchSharedScreen, stopWatchingScreen,
  returnToRoomChat, toggleSharedAudio, dismissShareNotice, setAppAudioGain, setQuickMicSetting,
  workspaceAction, openCardDialog, openChannelDialog, browseChannel,
} from './app/runtime.js';
const isSettingsOpen = ref(false);
const settingsTab = ref('profile');
const panel = ref('');
function openSettings(tab = 'profile') { settingsTab.value = tab; isSettingsOpen.value = true; }
function togglePanel(value) { panel.value = panel.value === value ? '' : value; }
onMounted(async () => { await nextTick(); initLegacyDom(); });
</script>
<template>
  <div class="app-shell single-server-shell room-workspace-shell" :class="{ 'diagnostics-open': panel === 'diagnostics' }">
    <SidebarPanel @join-room="joinRoom" @create-channel="createChannel" @switch-channel="browseChannel" @delete-channel="openChannelDialog" @open-settings="openSettings" />
    <MainStage :active-panel="panel" @open-panel="togglePanel" @watch="watchSharedScreen" @listen="toggleSharedAudio" @dismiss="dismissShareNotice" @back="returnToRoomChat" @stop="stopWatchingScreen" @card-edit="openCardDialog" @workspace-action="workspaceAction" @browse="browseChannel" @join="switchChannel">
      <template #chat="{ active }"><ChatPanel :active="active" @send="text => sendChatMessage(text)" @retry="id => sendChatMessage('', id)" /></template>
    </MainStage>
    <aside v-show="panel === 'diagnostics'" class="workspace-diagnostics" aria-label="通话诊断" @keydown.esc="panel = ''"><header><strong>通话诊断</strong><button aria-label="关闭诊断" @click="panel = ''"><X :size="17" /></button></header><DiagnosticsPanel @mark="markDiagnosticMoment" /></aside>
    <ControlDock @toggle-mic="toggleMic" @toggle-monitor="toggleMicMonitor" @toggle-screen="toggleScreen" @app-audio-click="handleAppAudioClick" @leave="leaveRoom" @open-settings="openSettings" @switch-mic="switchMic" @switch-output="switchAudioOutput" @overlay-control="controlStatusOverlay" @audio-gain="setAppAudioGain" @mic-setting="setQuickMicSetting" />
    <AudioSettingsModal :open="isSettingsOpen" :initial-tab="settingsTab" @close="isSettingsOpen = false" @switch-mic="switchMic" @switch-mic-source="switchMicSource" @switch-output="switchAudioOutput" @overlay-control="controlStatusOverlay" @overlay-preferences="saveOverlayPreferences" />
    <AppAudioModal @close="closeAppAudioModal" @confirm="confirmAppAudioSelection" />
    <UpdateNotice />
    <WorkspaceDialogs :run="workspaceAction" @join="switchChannel" />
  </div>
</template>
