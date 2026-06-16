<script setup>
import { computed } from 'vue';
import { getUserInitials } from '../../stores/profileStore.js';

const props = defineProps({
  name: {
    type: String,
    default: '',
  },
  color: {
    type: String,
    default: '#5865f2',
  },
  preset: {
    type: String,
    default: '',
  },
  // base64 图片头像；传入时优先级高于 color+preset
  avatarUrl: {
    type: String,
    default: null,
  },
  size: {
    type: String,
    default: 'md',
  },
  online: {
    type: Boolean,
    default: false,
  },
  muted: {
    type: Boolean,
    default: false,
  },
  isSpeaking: {
    type: Boolean,
    default: false,
  },
});

const text = computed(() => props.preset || getUserInitials(props.name));

import { getApiBase } from '../../shared/apiClient.js';
const fullAvatarUrl = computed(() => {
  if (!props.avatarUrl) return null;
  if (props.avatarUrl.startsWith('http://') || props.avatarUrl.startsWith('https://') || props.avatarUrl.startsWith('data:')) {
    return props.avatarUrl;
  }
  return getApiBase() + props.avatarUrl;
});
</script>

<template>
  <span
    class="base-avatar"
    :class="[`size-${size}`, { online, muted, speaking: isSpeaking }]"
    :style="fullAvatarUrl ? {} : { '--avatar-color': color }"
    :title="name"
  >
    <!-- 图片头像 -->
    <img
      v-if="fullAvatarUrl"
      :src="fullAvatarUrl"
      :alt="name"
      class="base-avatar-img"
    >
    <!-- 文字/emoji 头像 -->
    <span v-else class="base-avatar-text">{{ text }}</span>
    <span v-if="online" class="base-avatar-status"></span>
  </span>
</template>

<style scoped>
.base-avatar.speaking {
  box-shadow: 0 0 0 2px #23a559, 0 0 10px rgba(35, 165, 89, 0.45);
  transition: box-shadow 0.15s ease;
}
</style>
