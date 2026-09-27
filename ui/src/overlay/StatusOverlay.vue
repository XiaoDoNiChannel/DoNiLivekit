<script setup>
import { computed, ref, watch } from 'vue';
import { Mic, MicOff, Monitor, Music2, LockKeyhole, X, Grip, AudioLines } from 'lucide-vue-next';
const props = defineProps({ status: Object, snapshot: Object, fresh: Boolean, available: Boolean, pending: Boolean, busy: Boolean, error: String });
const emit = defineEmits(['control', 'opacity', 'mic', 'drag', 'resize']);
const opacity = ref(70);
watch(() => props.status.preferences.opacity, value => { opacity.value = Math.round(value * 100); }, { immediate: true });
const active = computed(() => props.fresh && props.snapshot?.connected);
const connection = computed(() => !props.fresh ? '状态更新中断' : props.snapshot?.reconnecting ? '正在重连' : props.snapshot?.connected ? '已连接' : '未连接语音');
</script>
<template>
  <section class="status-overlay" :class="{ interactive: status.interactive, stale: !fresh }" :style="{ '--overlay-opacity': opacity / 100 }" aria-label="游戏状态窗">
    <header class="status-overlay-header" @mousedown.left.prevent="status.interactive && emit('drag')">
      <strong :title="snapshot?.channel">{{ snapshot?.channel || 'DoNiChannel' }}</strong>
      <span class="overlay-connection" :class="{ online: active }">{{ connection }}</span>
      <template v-if="status.interactive">
        <button type="button" class="overlay-icon-button" :disabled="busy || !available || !status.shortcutsReady" :title="`锁定并穿透 · ${status.preferences.editShortcut} 恢复`" aria-label="锁定并穿透" @mousedown.stop @click="emit('control', 'game')"><LockKeyhole :size="13" /></button>
        <button type="button" class="overlay-icon-button" :disabled="busy || !available" title="隐藏状态窗" aria-label="隐藏状态窗" @mousedown.stop @click="emit('control', 'hide')"><X :size="14" /></button>
      </template>
    </header>
    <div class="overlay-media-row">
      <button type="button" class="overlay-mic" :class="{ 'mic-on': active && snapshot.micOn }" :disabled="busy || !status.interactive || !available || !active || pending"
        :title="status.interactive ? '切换麦克风；与主界面同步' : '游戏模式只显示状态'" @click="emit('mic')">
        <Mic v-if="active && snapshot.micOn" :size="15" /><MicOff v-else :size="15" />
        <span>{{ pending ? '正在切换…' : !fresh ? '麦克风状态未知' : !active ? '未在通话' : snapshot.micOn ? '麦克风已开' : '麦克风已关' }}</span>
      </button>
      <span class="overlay-share" :class="{ sharing: active && snapshot.screenOn }" :title="!fresh ? '共享状态未知' : active && snapshot.screenOn ? '屏幕共享中' : '未共享屏幕'"><Monitor :size="14" /><span>{{ !fresh ? '状态未知' : active && snapshot.screenOn ? '共享中' : '未共享' }}</span></span>
      <Music2 v-if="active && snapshot.appAudioOn" class="overlay-app-audio" :size="14" aria-label="应用音频共享中" />
    </div>
    <div class="overlay-speakers" :class="{ speaking: active && snapshot.speakerCount }">
      <AudioLines :size="15" aria-hidden="true" />
      <span v-if="!fresh">等待主界面更新状态</span>
      <span v-else-if="!active">加入语音频道后显示说话人</span>
      <span v-else-if="!snapshot.speakerCount">暂时无人说话</span>
      <template v-else><span :title="snapshot.speakers.join('、')">{{ snapshot.speakers.join('、') }}</span><small v-if="snapshot.speakerCount > 3" class="overlay-speaker-count">等 {{ snapshot.speakerCount }} 人</small></template>
    </div>
    <p v-if="fresh && snapshot?.networkWarning" class="overlay-network" :title="snapshot.networkText">{{ snapshot.networkText }}</p>
    <footer v-if="status.interactive" class="overlay-adjustments">
      <label>背景 <input v-model.number="opacity" type="range" min="10" max="100" step="5" :disabled="busy || !available" aria-label="背景不透明度" @change="emit('opacity', opacity / 100)"><span>{{ opacity }}%</span></label>
      <button type="button" class="overlay-icon-button overlay-resize" :disabled="busy || !available" aria-label="拖动调整大小" title="拖动调整大小" @mousedown.left.prevent="emit('resize')"><Grip :size="15" /></button>
    </footer>
    <footer v-else class="overlay-game-hint">鼠标穿透 · {{ status.preferences.editShortcut }} 调整</footer>
    <p v-if="!available" class="overlay-message">请在桌面客户端打开状态窗</p>
    <p v-if="error" class="overlay-message" role="alert" :title="error">{{ error }}</p>
  </section>
</template>
