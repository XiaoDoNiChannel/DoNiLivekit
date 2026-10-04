<script setup>
import { ref, watch } from 'vue';
import { Minus, LogOut, X } from 'lucide-vue-next';
import { windowCloseStore as state } from '../../stores/windowCloseStore.js';

const emit = defineEmits(['choose', 'cancel']);
const dialog = ref(null);

watch(() => state.open, open => {
  if (open) dialog.value?.showModal();
  else dialog.value?.close();
}, { flush: 'post' });
</script>

<template>
  <dialog ref="dialog" class="workspace-modal window-close-dialog" aria-labelledby="window-close-title" aria-describedby="window-close-description" @cancel.prevent="emit('cancel')" @click.self="emit('cancel')">
    <header>
      <h2 id="window-close-title">关闭程序</h2>
      <button type="button" aria-label="取消关闭" :disabled="state.busy" @click="emit('cancel')"><X :size="19" /></button>
    </header>
    <p id="window-close-description">请选择最小化到任务栏，或退出程序。</p>
    <p class="workspace-modal-hint">最小化后，语音和共享会继续运行；退出将结束通话和共享。</p>
    <label class="workspace-check"><input v-model="state.remember" type="checkbox" :disabled="state.busy">记住我的选择，不再询问</label>
    <p class="workspace-modal-hint">可在「设置中心 → 常规 → 关闭主窗口时」更改。</p>
    <p v-if="state.error" role="alert" class="workspace-action-error">{{ state.error }}</p>
    <footer>
      <button type="button" :disabled="state.busy" @click="emit('cancel')">取消</button>
      <button type="button" class="workspace-primary" autofocus :disabled="state.busy" @click="emit('choose', 'minimize')"><Minus :size="16" />最小化</button>
      <button type="button" :disabled="state.busy" @click="emit('choose', 'exit')"><LogOut :size="16" />退出程序</button>
    </footer>
  </dialog>
</template>

<style scoped>
.window-close-dialog { margin: auto; }
.window-close-dialog:not([open]) { display: none; }
.window-close-dialog::backdrop { background: #0008; }
.window-close-dialog footer { flex-wrap: wrap; }
</style>
