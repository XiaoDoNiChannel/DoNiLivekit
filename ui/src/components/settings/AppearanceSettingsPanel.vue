<script setup>
import { Check, Layers, Rows3 } from 'lucide-vue-next';
import { themes, themeStore, setTheme, setAppearance } from '../../stores/themeStore.js';
</script>
<template>
  <section class="settings-section settings-page-section appearance-settings" aria-label="外观设置">
    <div class="appearance-heading"><div><h2>选择你的界面</h2><p>同一套布局，四种配色与材质。点击立即应用。</p></div><span class="appearance-saved">自动保存</span></div>
    <div class="appearance-theme-grid" role="group" aria-label="界面主题">
      <button v-for="theme in themes" :key="theme.id" type="button" class="appearance-theme-card" :aria-label="`${theme.name}主题`" :aria-pressed="themeStore.activeTheme === theme.id" @click="setTheme(theme.id)">
        <span class="appearance-preview" :data-appearance-theme="theme.id" aria-hidden="true">
          <span class="appearance-preview-rail"><i></i><i></i><i></i></span>
          <span class="appearance-preview-main"><i></i><span><b></b><i></i></span><span><b></b><i></i></span><em></em></span>
          <span class="appearance-preview-dock"><i></i><i></i><i></i><i></i></span>
        </span>
        <span class="appearance-theme-title"><strong>{{ theme.name }}</strong><Check v-if="themeStore.activeTheme === theme.id" :size="16" /><small v-else>{{ theme.material }}</small></span>
        <span class="appearance-theme-desc">{{ theme.desc }}</span>
      </button>
    </div>
    <div v-if="themeStore.activeTheme === 'smoke-glass'" class="appearance-option appearance-material">
      <div class="appearance-option-label"><Layers :size="18" /><div><label for="glass-opacity">磨砂面板不透明度</label><p>调低会透出更多背景色；100% 为实色面板。</p></div><output for="glass-opacity">{{ themeStore.glassOpacity }}%</output></div>
      <input id="glass-opacity" type="range" min="65" max="100" step="1" :value="themeStore.glassOpacity" @input="setAppearance({ glassOpacity: Number($event.target.value) })">
    </div>
    <div class="appearance-option">
      <div class="appearance-option-label"><Rows3 :size="18" /><div><strong>界面间距</strong><p>紧凑模式可在小窗口中容纳更多内容。</p></div></div>
      <div class="appearance-density" role="group" aria-label="界面间距"><button type="button" :aria-pressed="themeStore.density === 'comfortable'" @click="setAppearance({ density: 'comfortable' })">舒适</button><button type="button" :aria-pressed="themeStore.density === 'compact'" @click="setAppearance({ density: 'compact' })">紧凑</button></div>
    </div>
    <p v-if="themeStore.storageError" class="workspace-action-error" role="status">{{ themeStore.storageError }}</p>
  </section>
</template>
