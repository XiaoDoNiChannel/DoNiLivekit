<script setup>
import { computed, ref, watch } from 'vue';
import { Activity, MessageSquare, Volume2, ArrowLeft, Monitor, Square, X } from 'lucide-vue-next';
import { appStore } from '../../stores/appStore.js';
import { presenceStore } from '../../stores/presenceStore.js';
import { sharingStore } from '../../stores/sharingStore.js';
import { diagnosticsStore, getDiagnosticSummary } from '../../stores/diagnosticsStore.js';
import ShareShelf from './ShareShelf.vue';
import PartyPanel from './PartyPanel.vue';
import { workspaceStore } from '../../stores/workspaceStore.js';
import { workspaceLayout } from '../../features/workspace.js';
const props = defineProps({ activePanel: { type: String, default: '' } });
const emit = defineEmits(['open-panel', 'watch', 'listen', 'dismiss', 'back', 'stop', 'card-edit', 'workspace-action', 'browse', 'join']);
const sidePanel = ref('cards');
const viewChannel = computed(() => workspaceStore.viewChannel || appStore.connection.currentChannel);
const hasRoom = computed(() => appStore.connection.isInLobby && !!viewChannel.value);
const sameVoice = computed(() => appStore.connection.isConnected && viewChannel.value === appStore.connection.currentChannel);
const channelName = computed(() => {
  if (!hasRoom.value) return '局域网大厅';
  const target = viewChannel.value;
  return presenceStore.channels.find(item => item.name === target || item.id === target)?.displayName || target || '局域网大厅';
});
const summary = computed(() => getDiagnosticSummary(diagnosticsStore));
const watching = computed(() => sharingStore.view === 'watch' && sameVoice.value);
const layout = computed(() => workspaceLayout({ watching: watching.value, sameVoice: sameVoice.value, panel: sidePanel.value }));
watch(watching, value => { sidePanel.value = value ? 'chat' : 'cards'; }, { immediate: true });
const screens = computed(() => sharingStore.shares.filter(s => s.kind === 'screen'));
const selected = computed(() => screens.value.find(s => s.id === sharingStore.watchingId));
const relatedAudio = computed(() => sharingStore.shares.filter(s => s.kind === 'appaudio' && s.identity === selected.value?.identity && !s.wanted));
</script>
<template>
  <main id="main-area" class="room-workspace">
    <header id="header" class="workspace-header"><div class="workspace-heading"><Volume2 :size="21" /><div><strong>{{ channelName }}</strong><small>{{ sameVoice ? '语音已连接 · 聊天与共享' : '正在浏览 · 不改变当前语音连接' }}</small></div></div><div class="workspace-header-actions"><button v-if="hasRoom && !watching" :aria-expanded="sidePanel === 'cards'" @click="sidePanel = sidePanel === 'cards' ? '' : 'cards'">组队卡</button><button v-if="sameVoice && sharingStore.watchingId && !watching" @click="emit('watch', sharingStore.watchingId)"><Monitor :size="16" /> 返回观看</button><button class="diagnostic-status-button" :class="summary.tone" :aria-expanded="props.activePanel === 'diagnostics'" @click="emit('open-panel', 'diagnostics')"><Activity :size="15" /><span>{{ summary.text }}</span></button></div></header>
    <div v-if="hasRoom && !sameVoice" class="workspace-browse-banner"><span>{{ appStore.connection.isConnected ? `语音仍连接在 ${presenceStore.channels.find(c => c.id === appStore.connection.currentChannel)?.displayName || appStore.connection.currentChannel}` : '尚未连接此频道语音' }} · 加入后可以观看该频道共享</span><button :disabled="!presenceStore.connected" @click="emit('join', viewChannel)">加入此语音</button></div>
    <ShareShelf v-if="sameVoice" @watch="emit('watch', $event)" @listen="emit('listen', $event)" @dismiss="emit('dismiss', $event)" />
    <section v-if="!hasRoom" class="workspace-welcome" aria-label="大厅欢迎页"><Volume2 :size="36" /><h1>{{ appStore.connection.isInLobby ? '选择一个语音频道' : '欢迎来到 DoNiChannel' }}</h1><p>{{ appStore.connection.isInLobby ? '从左侧选择频道，开始聊天、观看屏幕或收听共享。' : '从左侧进入大厅，与朋友一起聊天和共享。' }}</p></section>
    <p v-if="sharingStore.error" class="sharing-error" role="alert">{{ sharingStore.error }}<button aria-label="关闭错误提示" @click="sharingStore.error = ''"><X :size="14" /></button></p>
    <p v-if="workspaceStore.error && !workspaceStore.channelDialog && !workspaceStore.cardDialog" class="sharing-error" role="alert">{{ workspaceStore.error }}<button aria-label="关闭操作提示" @click="workspaceStore.error = ''"><X :size="14" /></button></p>
    <div v-show="hasRoom" class="workspace-content party-workspace" :class="{ watching, 'with-chat': layout.sideChat, 'with-cards': layout.cards }">
      <section v-show="watching" class="watch-stage" aria-label="共享画面">
        <header class="watch-toolbar"><label><Monitor :size="16" /><select aria-label="选择观看来源" :value="sharingStore.watchingId" @change="emit('watch', $event.target.value)"><option v-if="!selected" value="">选择一个共享画面</option><option v-for="screen in screens" :key="screen.id" :value="screen.id">{{ screen.displayName }} · {{ screen.title }}</option></select></label><div><button :aria-pressed="sidePanel === 'chat'" @click="sidePanel = 'chat'"><MessageSquare :size="16" /> 聊天</button><button :aria-pressed="sidePanel === 'cards'" @click="sidePanel = 'cards'">组队卡</button><button @click="emit('back')"><ArrowLeft :size="16" /> 返回聊天</button><button v-if="selected" @click="emit('stop')"><Square :size="14" /> 停止观看</button></div></header>
        <div class="watch-canvas"><div id="video-container" :class="{ 'has-selection': !!selected }"></div><div v-if="!selected || !selected.subscribed" class="watch-placeholder"><Monitor :size="34" /><strong>{{ selected ? (selected.wanted ? '正在连接画面…' : '画面未连接') : sharingStore.endedName ? `${sharingStore.endedName} 的共享已结束` : '选择要观看的画面' }}</strong><p v-if="!selected">可以从上方列表观看其他成员，或返回聊天。</p><button v-if="selected && !selected.wanted" @click="emit('watch', selected.id)">重新观看</button></div></div>
        <div v-for="audio in relatedAudio" :key="audio.id" class="watch-audio-prompt"><span>{{ audio.displayName }} 还共享了程序音频 · {{ audio.title }}</span><button @click="emit('listen', audio.id)">收听</button></div>
      </section>
      <section v-if="hasRoom" v-show="layout.chat" class="room-chat-slot" :class="{ 'side-chat': layout.sideChat }"><slot name="chat" :active="layout.chat" /></section>
      <PartyPanel v-if="hasRoom" v-show="layout.cards" :channel-id="viewChannel" @edit="emit('card-edit', $event)" @action="(action, values) => emit('workspace-action', action, values)" @browse="emit('browse', $event)" @join="emit('join', $event)" />
    </div>
    <div id="audio-container" hidden></div>
    <details v-show="appStore.media.screenOn" class="own-screen-preview"><summary>我的屏幕预览</summary><div id="local-screen-preview-box"><video id="local-screen-preview" muted autoplay playsinline></video></div></details>
  </main>
</template>
