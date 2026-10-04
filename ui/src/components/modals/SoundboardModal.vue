<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { X, Play, Headphones, Square, Plus, Megaphone, Trash2, Keyboard, Volume2 } from 'lucide-vue-next';
import { appStore } from '../../stores/appStore.js';
import { soundboardStore as state } from '../../stores/soundboardStore.js';
import { shortcutFromEvent } from '../../features/soundboardAudio.js';
import '../../assets/soundboard.css';
const props = defineProps({ actions: { type: Object, required: true } });
const dialog = ref(null), picker = ref(null), deleting = ref('');
const canSend = computed(() => state.ready && state.sendReady && appStore.connection.isConnected && appStore.media.micOn && !appStore.ui.switchingChannel);
const playingName = computed(() => state.items.find(c => c.id === state.playing)?.name || '');
const keyLabel = value => value ? value.replaceAll('Digit', '').replaceAll('Key', '').replaceAll('+', ' + ') : '设置快捷键';
function close() { state.open = false; state.recording = ''; deleting.value = ''; }
async function picked(event) { await props.actions.importFiles([...event.target.files]); event.target.value = ''; }
async function capture(event) {
  if (!state.recording) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.repeat) return;
  if (event.key === 'Escape') { state.recording = ''; return; }
  const value = shortcutFromEvent(event);
  if (!value) return;
  await props.actions.setShortcut(state.recording, value);
  state.recording = '';
}
watch(() => state.open, async value => {
  await nextTick();
  if (value && !dialog.value?.open) dialog.value?.showModal();
  else if (!value && dialog.value?.open) dialog.value.close();
});
onMounted(() => document.addEventListener('keydown', capture, true));
onBeforeUnmount(() => { document.removeEventListener('keydown', capture, true); state.recording = ''; });
</script>
<template>
  <dialog ref="dialog" class="soundboard-dialog" aria-labelledby="soundboard-title" @cancel.prevent="close" @close="close" @click="event => { if (event.target === dialog) close(); }">
    <header class="sb-header"><div><span class="sb-eyebrow">声音，也能一键到位</span><h2 id="soundboard-title"><Megaphone :size="23" /> 一键喊话</h2><p>先试听，再分享给当前频道的朋友。</p></div><button class="sb-icon" aria-label="关闭一键喊话" @click="close"><X :size="20" /></button></header>
    <div class="sb-body">
      <section class="sb-volume" aria-label="喊话音量">
        <label for="sb-master"><Volume2 :size="18" /> 发送音量 <output>{{ state.volume }}%</output></label>
        <input id="sb-master" type="range" min="0" max="100" :value="state.volume" @input="actions.preferences({ volume: $event.target.value })" />
        <p>默认 60% · 自动压低过响素材。试听与发送使用相同音量处理。</p>
        <label class="sb-check"><input type="checkbox" :checked="state.monitor" @change="actions.preferences({ monitor: $event.target.checked })" /> 播放到频道时，自己也听到</label>
      </section>
      <div class="sb-toolbar"><strong>我的音频 <span>{{ state.items.length }} / 64</span></strong><button :disabled="!state.ready || state.busy || state.items.length >= 64" @click="picker.click()"><Plus :size="16" /> {{ state.busy ? '处理中…' : '导入音频' }}</button><input ref="picker" hidden type="file" accept=".mp3,.wav,.ogg" multiple @change="picked" /></div>
      <p class="sb-note">MP3 / WAV / OGG，单段不超过 30 秒、5 MB。快捷键在游戏中也可使用。</p>
      <p v-if="!appStore.connection.isConnected" class="sb-tip">尚未加入语音频道，现在可以本地试听。</p>
      <p v-else-if="!appStore.media.micOn" class="sb-tip">麦克风已静音：仅可试听，开麦后才能向频道播放。</p>
      <p v-else-if="!state.sendReady" class="sb-tip">正在准备音效通道… <button @click="actions.prepare().catch(error => state.error = String(error))">重试</button></p>
      <p v-if="state.error" class="sb-error" role="alert">{{ state.error }}</p>
      <div class="sb-clips">
        <article v-for="clip in state.items" :key="clip.id" class="sb-clip" :class="{ 'is-playing': state.playing === clip.id }">
          <div class="sb-clip-heading"><div class="sb-number"><Megaphone v-if="state.playing === clip.id" :size="17" /><span v-else>♪</span></div><div class="sb-name"><input :aria-label="`音频名称：${clip.name}`" maxlength="80" :value="clip.name" @change="actions.edit(clip.id, { name: $event.target.value })" /><small>{{ clip.duration ? clip.duration.toFixed(1) + ' 秒' : '短音频' }}<template v-if="clip.attenuation < 0.99"> · 已自动降响</template></small></div><button class="sb-icon" :disabled="state.busy" :aria-label="`删除 ${clip.name}`" @click="deleting = deleting === clip.id ? '' : clip.id"><Trash2 :size="15" /></button></div>
          <div class="sb-clip-actions"><button :disabled="!state.ready || state.busy || !!clip.error" @click="actions.play(clip.id, true)"><Headphones :size="15" /> 试听</button><button class="sb-play" :disabled="!canSend || state.busy || !!clip.error" @click="actions.play(clip.id)"><Play :size="15" /> 频道播放</button></div>
          <label class="sb-clip-volume"><span>单段音量</span><input type="range" min="0" max="100" :aria-label="`${clip.name}的单段音量`" :value="clip.volume" @input="actions.edit(clip.id, { volume: $event.target.value })" /><output>{{ clip.volume }}%</output></label>
          <div class="sb-shortcut"><button :disabled="state.busy" :class="{ recording: state.recording === clip.id }" @click="state.recording = clip.id"><Keyboard :size="14" /> {{ state.recording === clip.id ? '请按组合键 / F 键…' : keyLabel(clip.shortcut) }}</button><button v-if="clip.shortcut" class="sb-icon" :aria-label="`清除 ${clip.name}的快捷键`" @click="actions.setShortcut(clip.id, '')"><X :size="13" /></button></div>
          <p v-if="state.shortcutErrors[clip.id] || clip.error" class="sb-error" role="status">{{ state.shortcutErrors[clip.id] || clip.error }}</p>
          <div v-if="deleting === clip.id" class="sb-confirm"><span>从音频库删除？</span><button @click="actions.remove(clip.id); deleting = ''">删除</button><button @click="deleting = ''">取消</button></div>
        </article>
      </div>
      <p v-if="state.ready && !state.items.length" class="sb-tip">音频库还是空的，导入一段喜欢的声音吧。</p>
      <details class="sb-receive"><summary>收听设置 <span>只影响你听到的声音</span></summary><label class="sb-check"><input type="checkbox" :checked="state.receive" @change="actions.preferences({ receive: $event.target.checked })" /> 接收其他人的一键喊话</label><label class="sb-clip-volume"><span>接收音量</span><input aria-label="一键喊话接收音量" type="range" min="0" max="100" :value="state.receiveVolume" @input="actions.preferences({ receiveVolume: $event.target.value })" /><output>{{ state.receiveVolume }}%</output></label><label v-for="peer in state.peers" :key="peer.identity" class="sb-check"><input type="checkbox" :checked="!state.blocked.includes(peer.identity)" @change="actions.block(peer.identity, !$event.target.checked)" /> 收听 {{ peer.name }}</label><p v-if="!state.peers.length" class="sb-note">频道成员启用一键喊话后，可在这里单独屏蔽。</p></details>
    </div>
    <footer class="sb-footer"><div role="status"><strong>{{ state.playing ? (state.mode === 'preview' ? '仅本地试听' : '正在向频道播放') : '随时准备，为这一刻配音' }}</strong><small>{{ playingName || '每次只播放一段，切频道或静音会立即停止。' }}</small></div><div class="sb-stop"><button @click="actions.stop()"><Square :size="15" /> 停止播放</button><button class="sb-stop-key" @click="state.recording = '_stop'">{{ state.recording === '_stop' ? '请按停止快捷键…' : keyLabel(state.stopShortcut) }}</button><small v-if="state.shortcutErrors._stop" class="sb-error">{{ state.shortcutErrors._stop }}</small></div></footer>
  </dialog>
</template>
