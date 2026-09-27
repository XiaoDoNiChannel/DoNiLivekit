<script setup>
import { computed, ref, watch } from 'vue';
import ProfileSettingsPanel from './ProfileSettingsPanel.vue';
import OverlaySettingsPanel from './OverlaySettingsPanel.vue';
import { themes, themeStore, setTheme } from '../../stores/themeStore.js';
import { appStore } from '../../stores/appStore.js';
import { isTauriClient } from '../../shared/tauri.js';

const props = defineProps({
  initialTab: { type: String, default: 'profile' },
  open: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['close', 'switch-mic', 'switch-mic-source', 'switch-output', 'overlay-control', 'overlay-preferences']);

const activeTab = ref('profile');
watch(() => props.open, open => { if (open) activeTab.value = props.initialTab; });

const settingsTabs = [
  { id: 'profile', icon: '👤', title: '我的资料', desc: '头像、昵称、状态' },
  { id: 'devices', icon: '🎧', title: '音频设备', desc: '麦克风与扬声器' },
  { id: 'mic', icon: '🎙️', title: '麦克风处理', desc: '阈值、增益、降噪' },
  { id: 'overlay', icon: '▣', title: '游戏浮窗', desc: '状态、透明度、快捷键' },
  { id: 'about', icon: 'ℹ️', title: '关于', desc: '版本和使用建议' },
];

const activeTabInfo = computed(() => {
  return settingsTabs.find((tab) => tab.id === activeTab.value) || settingsTabs[0];
});

function closeModal() {
  emit('close');
}

const activeThemeId = computed(() => themeStore.activeTheme);

function chooseTheme(themeId) {
  setTheme(themeId);
}
</script>

<template>
  <!--
    设置中心始终挂载，只通过 hidden 控制显示。
    这样 runtime.initLegacyDom() 能稳定找到 mic-select、audio-output-select 和 VAD 滑块。
    各设置页也使用 v-show，不使用 v-if，避免 DOM id 因标签页切换而丢失。
  -->
  <div
    class="modal audio-settings-modal modern-settings-modal"
    :class="{ hidden: !props.open }"
    @click.self="closeModal"
  >
    <section class="modal-card settings-card settings-center-card">
      <header class="modal-header settings-header settings-center-header">
        <div>
          <div class="modal-title">设置中心</div>
          <div class="settings-subtitle">管理个人资料、音频设备、麦克风处理与界面偏好</div>
        </div>
        <button class="modal-close" title="关闭" @click="closeModal">×</button>
      </header>

      <div class="settings-center-layout">
        <aside class="settings-nav" aria-label="设置分类">
          <button
            v-for="tab in settingsTabs"
            :key="tab.id"
            type="button"
            class="settings-nav-item"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >
            <span class="settings-nav-icon">{{ tab.icon }}</span>
            <span class="settings-nav-copy">
              <span class="settings-nav-title">{{ tab.title }}</span>
              <span class="settings-nav-desc">{{ tab.desc }}</span>
            </span>
          </button>
        </aside>

        <main class="settings-content-panel">
          <div class="settings-page-heading">
            <div class="settings-page-kicker">{{ activeTabInfo.icon }} {{ activeTabInfo.title }}</div>
            <div class="settings-page-desc">{{ activeTabInfo.desc }}</div>
          </div>

          <div class="settings-page-stack">
            <div v-show="activeTab === 'profile'" class="settings-tab-panel profile-tab-panel">
              <ProfileSettingsPanel />
            </div>

            <section v-show="activeTab === 'devices'" class="settings-section settings-page-section">
              <div class="settings-section-title">输入 / 输出设备</div>
              <p class="settings-section-desc">选择当前使用的麦克风、处理模式和扬声器。</p>

              <label v-if="isTauriClient" class="settings-field modern-settings-field">
                <span>麦克风处理模式</span>
                <select
                  :value="appStore.media.micSource"
                  @change="$emit('switch-mic-source', $event.target.value)"
                >
                  <option value="browser">浏览器增强（推荐外放，带回声消除）</option>
                  <option value="rust">Rust 增强（推荐耳机，无回声消除）</option>
                </select>
              </label>

              <label class="settings-field modern-settings-field">
                <span>麦克风</span>
                <select
                  id="mic-select"
                  disabled
                  @change="$emit('switch-mic', $event.target.value)"
                >
                  <option value="">等待权限...</option>
                </select>
              </label>

              <label class="settings-field modern-settings-field">
                <span>扬声器</span>
                <select
                  id="audio-output-select"
                  disabled
                  @change="$emit('switch-output', $event.target.value)"
                >
                  <option value="default">默认扬声器</option>
                </select>
              </label>

              <div class="settings-tip-card">
                <strong>提示</strong>
                <span>别人说话出现回音时，请先选“浏览器增强”，并确认麦克风不是“立体声混音/虚拟回放”设备。</span>
              </div>
            </section>

            <section v-show="activeTab === 'mic'" class="settings-section settings-page-section">
              <div class="settings-section-title">麦克风处理</div>
              <p class="settings-section-desc">
                {{ appStore.media.micSource === 'rust'
                  ? '调整 Rust 静音门限和麦克风增益。增益过高可能导致炸麦。'
                  : '浏览器增强模式由 WebRTC 提供回声消除、降噪和自动增益。' }}
              </p>

              <div v-show="appStore.media.micSource === 'rust'" id="vad-module" class="vad-container settings-vad-block modern-vad-block">
                <div class="vad-header">
                  <span>收音阈值</span>
                  <span id="vad-threshold-text">20%</span>
                </div>

                <div class="vad-track-wrapper">
                  <div id="vad-fill-bar" class="vad-fill-bar"></div>
                  <div id="vad-threshold-marker" class="vad-threshold-marker" style="left: 20%;"></div>
                  <input
                    id="vad-slider-input"
                    type="range"
                    min="0"
                    max="100"
                    value="20"
                    class="vad-slider-input"
                  >
                </div>

                <div class="settings-range-note">低于阈值的环境声会被压低。说话断续时可以适当降低。</div>

                <div class="vad-header vad-boost-header">
                  <span>麦克风增益</span>
                  <span id="vad-boost-text">5.0x</span>
                </div>

                <input
                  id="vad-boost-input"
                  type="range"
                  class="volume-slider"
                  min="10"
                  max="200"
                  value="50"
                >

                <div class="settings-range-note">增益越高声音越大，但也更容易触发限幅和失真。</div>
              </div>

              <div v-show="appStore.media.micSource !== 'rust'" class="settings-tip-card">
                <strong>浏览器增强已启用</strong>
                <span>此模式优先解决外放回声；Rust 的 VAD、RNNoise 和增益滑块不会作用于该链路。</span>
              </div>
            </section>

            <OverlaySettingsPanel v-show="activeTab === 'overlay'" @control="action => emit('overlay-control', action)" @preferences="value => emit('overlay-preferences', value)" />

            <section v-show="activeTab === 'about'" class="settings-section settings-page-section settings-about-section">
              <div class="settings-section-title">关于 DoNiChannel</div>
              <p>DoNiChannel 是面向局域网语音、屏幕共享和应用音频共享的 Tauri 桌面客户端。</p>

              <div class="about-info-list">
                <div><span>前端</span><strong>Vue 3 + Vite</strong></div>
                <div><span>桌面端</span><strong>Tauri + Rust</strong></div>
                <div><span>实时通信</span><strong>LiveKit</strong></div>
                <div><span>后端</span><strong>FastAPI + Presence WebSocket</strong></div>
              </div>

              <div class="settings-tip-card warning">
                <strong>音频建议</strong>
                <span>如果出现回声，优先关闭耳返、避免外放，并确认应用音频没有采集到 DoNiChannel 自己。</span>
              </div>
            </section>
          </div>
        </main>
      </div>
    </section>
  </div>
</template>
