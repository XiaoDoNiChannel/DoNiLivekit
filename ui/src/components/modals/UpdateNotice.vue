<script setup>
import { computed, ref, watch } from 'vue';
import { Download, RefreshCw, X } from 'lucide-vue-next';
import { checkForUpdates, installAvailableUpdate } from '../../app/runtime.js';
import { updateStore } from '../../stores/updateStore.js';

const DISMISSED_UPDATE_KEY = 'donichannel_dismissed_update_session';
const dismissedVersion = ref(sessionStorage.getItem(DISMISSED_UPDATE_KEY) || '');
const actionError = ref('');

const busy = computed(() => ['downloading', 'installing'].includes(updateStore.status));
const visible = computed(() => {
  if (busy.value || updateStore.status === 'install-failed') return true;
  return updateStore.available
    && !!updateStore.version
    && dismissedVersion.value !== updateStore.version;
});
const progressLabel = computed(() => {
  if (updateStore.status === 'installing') return '正在安装，应用将自动重启…';
  if (updateStore.progressPercent != null) {
    return `正在下载 ${Math.round(updateStore.progressPercent)}%`;
  }
  return '正在下载安装包…';
});
const progressStyle = computed(() => ({
  width: `${Math.max(2, Number(updateStore.progressPercent || 0))}%`,
}));

watch(() => updateStore.version, (version) => {
  if (version && version !== dismissedVersion.value) actionError.value = '';
});

function dismiss() {
  if (busy.value || !updateStore.version) return;
  dismissedVersion.value = updateStore.version;
  sessionStorage.setItem(DISMISSED_UPDATE_KEY, updateStore.version);
}

async function install() {
  actionError.value = '';
  try {
    await installAvailableUpdate();
  } catch (error) {
    actionError.value = String(error?.message || error || '安装更新失败');
  }
}

async function retryCheck() {
  actionError.value = '';
  await checkForUpdates();
}
</script>

<template>
  <Transition name="update-notice">
    <section
      v-if="visible"
      class="update-notice"
      role="dialog"
      aria-live="polite"
      aria-label="软件更新"
    >
      <header class="update-notice-header">
        <div>
          <span class="update-notice-kicker">DONICHANNEL UPDATE</span>
          <h2>发现新版本 {{ updateStore.version }}</h2>
        </div>
        <button
          v-if="!busy"
          class="update-notice-close"
          type="button"
          title="本次启动稍后提醒"
          @click="dismiss"
        >
          <X :size="17" />
        </button>
      </header>

      <p class="update-notice-version">
        当前版本 {{ updateStore.currentVersion || '未知' }} · 更新来自中心服务器
      </p>

      <pre v-if="updateStore.notes" class="update-notice-notes">{{ updateStore.notes }}</pre>
      <p v-else class="update-notice-notes empty">此版本未提供更新说明。</p>

      <div v-if="busy" class="update-progress-wrap">
        <div class="update-progress-track">
          <span :style="progressStyle"></span>
        </div>
        <span>{{ progressLabel }}</span>
      </div>

      <p v-if="actionError || updateStore.status === 'install-failed'" class="update-notice-error">
        {{ actionError || updateStore.error || '安装更新失败，请重试。' }}
      </p>

      <footer class="update-notice-actions">
        <button v-if="!busy" class="update-secondary-button" type="button" @click="dismiss">
          稍后
        </button>
        <button
          v-if="updateStore.status === 'install-failed'"
          class="update-secondary-button"
          type="button"
          @click="retryCheck"
        >
          <RefreshCw :size="15" />
          重新检查
        </button>
        <button class="update-primary-button" type="button" :disabled="busy" @click="install">
          <Download v-if="!busy" :size="16" />
          {{ busy ? '更新处理中' : '下载并安装' }}
        </button>
      </footer>
    </section>
  </Transition>
</template>

<style scoped>
.update-notice {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 500;
  width: min(420px, calc(100vw - 44px));
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--dc-accent, #5865f2) 42%, #3b3d44);
  border-radius: 18px;
  background: color-mix(in srgb, var(--dc-bg-panel-solid, #2b2d31) 94%, transparent);
  color: var(--dc-text-normal, #dbdee1);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(18px);
}

.update-notice-header,
.update-notice-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.update-notice-kicker {
  display: block;
  margin-bottom: 5px;
  color: var(--dc-accent, #8b9cff);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.update-notice h2 {
  color: var(--dc-text-main, #f2f3f5);
  font-size: 17px;
}

.update-notice-close {
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.update-notice-version {
  margin-top: 8px;
  color: var(--dc-text-muted, #b5bac1);
  font-size: 12px;
}

.update-notice-notes {
  max-height: 128px;
  margin-top: 14px;
  padding: 11px 12px;
  overflow: auto;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.18);
  color: var(--dc-text-normal, #dbdee1);
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.update-notice-notes.empty {
  color: var(--dc-text-muted, #b5bac1);
}

.update-progress-wrap {
  margin-top: 14px;
  color: var(--dc-text-muted, #b5bac1);
  font-size: 12px;
}

.update-progress-track {
  height: 7px;
  margin-bottom: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
}

.update-progress-track span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--dc-accent, #5865f2), #23a559);
  transition: width 0.18s ease;
}

.update-notice-error {
  margin-top: 12px;
  color: #ff8c8f;
  font-size: 12px;
  line-height: 1.45;
}

.update-notice-actions {
  justify-content: flex-end;
  margin-top: 16px;
}

.update-notice-actions button {
  min-height: 36px;
  padding: 0 13px;
  border: 0;
  border-radius: 10px;
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font-weight: 700;
}

.update-notice-actions button:disabled {
  cursor: wait;
  opacity: 0.66;
}

.update-secondary-button {
  background: rgba(255, 255, 255, 0.08);
}

.update-primary-button {
  background: var(--dc-accent, #5865f2);
}

.update-notice-enter-active,
.update-notice-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.update-notice-enter-from,
.update-notice-leave-to {
  opacity: 0;
  transform: translateY(14px) scale(0.98);
}
</style>
