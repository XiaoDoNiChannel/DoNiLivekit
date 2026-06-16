<script setup>
import { computed } from 'vue';
import { appStore } from '../stores/appStore.js';
import { presenceStore } from '../stores/presenceStore.js';
import { chatStore, getChannelNotification, markChannelRead } from '../stores/chatStore.js';

const DEFAULT_CHANNELS = ['day0', 'day1', 'day2'];

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeMember(member) {
  if (!member) return null;
  if (typeof member === 'string') {
    const name = cleanText(member);
    if (!name) return null;
    return { displayName: name, identity: name, userId: name };
  }

  const displayName = cleanText(member.displayName || member.name || member.identity || member.userId);
  if (!displayName) return null;
  return {
    displayName,
    identity: cleanText(member.identity),
    userId: cleanText(member.userId),
    connectionId: cleanText(member.connectionId),
  };
}

function normalizeChannel(channel) {
  if (!channel) return null;
  if (typeof channel === 'string') {
    const id = cleanText(channel);
    if (!id) return null;
    return { id, name: id, members: [] };
  }

  const id = cleanText(channel.id || channel.name);
  const name = cleanText(channel.name || channel.id);
  if (!id && !name) return null;
  const members = Array.isArray(channel.members)
    ? channel.members.map(normalizeMember).filter(Boolean)
    : [];

  return {
    id: id || name,
    name: name || id,
    members,
  };
}

const currentChannelId = computed(() => cleanText(appStore.connection.currentChannel || chatStore.currentChannelId));

const channelRows = computed(() => {
  // 显式依赖通知时间戳，保证 badge 变化时重新计算。
  const _notificationTick = chatStore.notificationUpdatedAt;
  void _notificationTick;

  const rows = [];
  const seen = new Set();

  const addChannel = (raw) => {
    const channel = normalizeChannel(raw);
    if (!channel || seen.has(channel.id)) return;
    seen.add(channel.id);
    const notice = getChannelNotification(channel.id);
    rows.push({
      ...channel,
      unread: Number(notice.unread || 0),
      mentions: Number(notice.mentions || 0),
    });
  };

  (presenceStore.channels || []).forEach(addChannel);
  (appStore.connection.channels || []).forEach(addChannel);
  DEFAULT_CHANNELS.forEach(addChannel);

  return rows;
});

function switchToChannel(channelId) {
  const cleanId = cleanText(channelId);
  if (!cleanId) return;
  if (typeof window !== 'undefined' && typeof window.switchChannel === 'function') {
    window.switchChannel(cleanId);
  }
  markChannelRead(cleanId);
}
</script>

<template>
  <div id="channel-list" class="discord-channel-list">
    <div
      v-for="channel in channelRows"
      :key="channel.id"
      class="channel-row"
    >
      <button
        type="button"
        class="channel-item"
        :class="{ active: channel.id === currentChannelId }"
        @click="switchToChannel(channel.id)"
      >
        <span class="channel-icon">🔊</span>
        <span class="channel-name">{{ channel.name }}</span>
        <span class="channel-right-area">
          <span v-if="channel.mentions > 0" class="channel-mention-badge">@{{ channel.mentions > 99 ? '99+' : channel.mentions }}</span>
          <span v-else-if="channel.unread > 0" class="channel-unread-dot" :title="`${channel.unread} 条未读`"></span>
          <span class="channel-member-count">{{ channel.members.length }}</span>
        </span>
      </button>

      <div
        v-if="channel.members.length > 0"
        class="channel-participants"
      >
        <div
          v-for="member in channel.members"
          :key="member.identity || member.userId || member.connectionId || member.displayName"
          class="voice-member-item"
        >
          <span class="voice-member-avatar">{{ member.displayName.slice(0, 1).toUpperCase() }}</span>
          <span class="voice-member-name">{{ member.displayName }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.channel-right-area {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
}

.channel-mention-badge {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: #f23f42;
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  font-weight: 800;
  text-align: center;
  box-shadow: 0 0 0 2px #2b2d31;
}

.channel-unread-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #dbdee1;
  opacity: 0.9;
}

.channel-item.active .channel-mention-badge {
  box-shadow: 0 0 0 2px #404249;
}
</style>
