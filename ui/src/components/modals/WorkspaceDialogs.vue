<script setup>
import { nextTick, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { workspaceStore as state } from '../../stores/workspaceStore.js';
import { presenceStore } from '../../stores/presenceStore.js';
const props = defineProps({ run: Function });
const emit = defineEmits(['join']);
const name = ref(''), game = ref(''), note = ref(''), target = ref(''), joinAfter = ref(false), first = ref(null), container = ref(null);
let previousFocus;
watch(() => [state.channelDialog, state.cardDialog], async () => {
  name.value = ''; joinAfter.value = false;
  game.value = state.cardDialog?.game || ''; note.value = state.cardDialog?.note || ''; target.value = state.cardDialog?.targetChannel || '';
  if (state.channelDialog || state.cardDialog) { previousFocus = document.activeElement; await nextTick(); (first.value || container.value)?.focus(); }
  else previousFocus?.focus?.();
});
function close() { if (!state.busy) { state.channelDialog = null; state.cardDialog = null; } }
function keys(event) {
  if (event.key === 'Escape') { event.stopPropagation(); close(); }
  if (event.key !== 'Tab') return;
  const elements = [...container.value.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
  if (!elements.length) { event.preventDefault(); return; }
  const first = elements[0], last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
async function submit() {
  let result;
  if (state.channelDialog) {
    const dialog = state.channelDialog;
    result = await props.run(dialog.mode === 'delete' ? 'channel_delete' : 'channel_create', { name: dialog.mode === 'delete' ? dialog.id : name.value });
    if (result !== null) { const shouldJoin = dialog.mode === 'create' && joinAfter.value; close(); if (shouldJoin) emit('join', result); }
  } else if (state.cardDialog) {
    const card = state.cardDialog;
    result = await props.run(card.id ? 'card_update' : 'card_create', { id: card.id, revision: card.revision, game: game.value, note: note.value, targetChannel: target.value });
    if (result !== null) close();
  }
}
</script>
<template>
  <div v-if="state.channelDialog || state.cardDialog" class="workspace-modal-backdrop" @mousedown.self="close">
    <form ref="container" class="workspace-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title" tabindex="-1" @submit.prevent="submit" @keydown="keys">
      <header><h2 id="workspace-dialog-title">{{ state.channelDialog ? (state.channelDialog.mode === 'delete' ? '删除语音频道' : '创建语音频道') : state.cardDialog.id ? '编辑组队卡' : '发起游戏意向' }}</h2><button type="button" :disabled="state.busy" aria-label="关闭" @click="close"><X :size="19" /></button></header>
      <template v-if="state.channelDialog?.mode === 'delete'"><p>删除「{{ state.channelDialog.displayName || state.channelDialog.id }}」？</p><p class="workspace-modal-hint">仅能删除空闲频道。聊天记录归档保留，关联组队卡会清除目标频道，成员可重新选择。</p></template>
      <template v-else-if="state.channelDialog"><label>频道名称<input ref="first" v-model="name" required maxlength="64" :disabled="state.busy" placeholder="例如：CS2 小队 2"></label><label class="workspace-check"><input v-model="joinAfter" type="checkbox" :disabled="state.busy">创建后加入此语音频道</label></template>
      <template v-else><label>想玩的游戏<input ref="first" v-model="game" required maxlength="40" :disabled="state.busy" placeholder="例如：CS2"></label><label>说句话叫上大家<textarea v-model="note" maxlength="160" rows="3" :disabled="state.busy" placeholder="已经在打了，下把可以一起"></textarea></label><label>出发频道<select v-model="target" :disabled="state.busy"><option value="">暂不指定 · 在大厅集合</option><option v-for="channel in presenceStore.channels" :key="channel.id" :value="channel.id">{{ channel.displayName || channel.name }}</option></select></label><p class="workspace-modal-hint">选择频道不会移动任何成员。想玩的人通过卡片自行加入。</p></template>
      <p v-if="state.error" role="alert" class="workspace-action-error">{{ state.error }}</p>
      <footer><button type="button" :disabled="state.busy" @click="close">取消</button><button type="submit" class="workspace-primary" :disabled="state.busy || !state.supported">{{ state.busy ? '正在处理…' : state.channelDialog?.mode === 'delete' ? '确认删除' : '保存' }}</button></footer>
    </form>
  </div>
</template>
