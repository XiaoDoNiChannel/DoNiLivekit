<script setup>
import { ref, watch } from 'vue';
import { overlayStore as state } from '../../stores/overlayStore.js';
const emit = defineEmits(['control', 'preferences']);
const opacity = ref(70), toggleShortcut = ref(''), editShortcut = ref('');
watch(() => state.status.preferences.opacity, value => { opacity.value = Math.round(value * 100); }, { immediate: true });
watch(() => state.status.preferences.toggleShortcut, value => { toggleShortcut.value = value; }, { immediate: true });
watch(() => state.status.preferences.editShortcut, value => { editShortcut.value = value; }, { immediate: true });
</script>
<template>
  <section class="settings-section settings-page-section overlay-settings">
    <div class="settings-section-title">游戏状态窗</div>
    <p class="settings-section-desc">游戏中查看开麦、共享和当前说话人。窗口化与无边框全屏优先支持；独占全屏需要按游戏验证。</p>
    <div class="overlay-preview" :style="{ '--overlay-opacity': opacity / 100 }" aria-label="状态窗外观示例">
      <div><strong>语音频道</strong><span>外观示例</span></div>
      <p>麦克风已关闭 <span>屏幕共享中</span></p>
      <p class="overlay-preview-speaker"><i></i> 正在说话：队友</p>
    </div>
    <p class="overlay-setting-status" role="status">{{ !state.available ? '请在桌面客户端中使用悬浮窗。' : !state.ready ? '正在读取浮窗设置…' : !state.status.visible ? '状态窗已隐藏' : state.status.interactive ? '调整模式 · 可拖动与操作' : '游戏模式 · 鼠标穿透' }}</p>
    <div class="overlay-setting-actions">
      <button type="button" :disabled="!state.ready || state.busy" @click="emit('control', state.status.visible ? 'hide' : 'show')">{{ state.status.visible ? '隐藏状态窗' : '打开状态窗' }}</button>
      <button type="button" :disabled="!state.ready || state.busy || !state.status.visible || !state.status.shortcutsReady" @click="emit('control', state.status.interactive ? 'game' : 'show')">{{ state.status.interactive ? '锁定并穿透' : '进入调整模式' }}</button>
      <button type="button" :disabled="!state.ready || state.busy" @click="emit('control', 'reset')">找回浮窗 / 重置位置</button>
    </div>
    <label class="overlay-opacity-label">背景不透明度 <strong>{{ opacity }}%</strong>
      <input v-model.number="opacity" type="range" min="10" max="100" step="5" :disabled="!state.ready || state.busy" @change="emit('preferences', { opacity: opacity / 100 })">
    </label>
    <p class="settings-section-desc">数值越低背景越透明，文字保持清晰。位置和大小会自动保存；关闭状态窗不影响通话。</p>
    <div class="overlay-shortcuts">
      <label>显示 / 隐藏<input v-model="toggleShortcut" :disabled="!state.ready || state.busy" maxlength="80" spellcheck="false" placeholder="Ctrl+Alt+Shift+O"></label>
      <label>调整 / 穿透<input v-model="editShortcut" :disabled="!state.ready || state.busy" maxlength="80" spellcheck="false" placeholder="Ctrl+Alt+O"></label>
      <button type="button" :disabled="!state.ready || state.busy" @click="emit('preferences', { toggleShortcut, editShortcut })">保存快捷键</button>
    </div>
    <p class="settings-section-desc">穿透时可用快捷键恢复操作，也可回到这里找回浮窗。首次打开进入调整模式，每次启动应用默认隐藏。</p>
    <p v-if="state.status.shortcutError" class="overlay-setting-error" role="status">{{ state.status.shortcutError }}{{ state.status.shortcutsReady ? '；仍使用之前的快捷键。' : '；穿透模式暂不可用，请重新设置快捷键。' }}</p>
    <p v-if="state.error" class="overlay-setting-error" role="alert">{{ state.error }}</p>
  </section>
</template>
