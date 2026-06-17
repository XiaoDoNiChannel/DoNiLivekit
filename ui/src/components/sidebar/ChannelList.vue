<script setup>
import { computed } from 'vue';
import { appStore } from '../../stores/appStore.js';
import {
  presenceStore,
  getVoiceMemberAudioState,
} from '../../stores/presenceStore.js';
import { chatStore, getChannelNotification, markChannelRead } from '../../stores/chatStore.js';

const DEFAULT_CHANNELS = ['day0', 'day1', 'day2'];

function cleanText(value) {
  return String(value || '').trim();
}

function clampVolumePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(Math.round(n), 300));
}

function normalizeMember(member) {
  if (!member) return null;
  if (typeof member === 'string') {
    const name = cleanText(member);
    if (!name) return null;
    return { displayName: name, identity: name, userId: name, connectionId: '' };
  }

  const displayName = cleanText(member.displayName || member.name || member.identity || member.userId);
  if (!displayName) return null;
  return {
    displayName,
    identity: cleanText(member.identity),
    userId: cleanText(member.userId),
    connectionId: cleanText(member.connectionId),
    avatarColor: member.avatarColor,
    avatarPreset: member.avatarPreset,
    avatarUrl: member.avatarUrl,
    statusText: member.statusText || '在线',
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
  // 显式依赖这些时间戳，保证 badge / 语音状态变化时重新计算。
  const _notificationTick = chatStore.notificationUpdatedAt;
  const _presenceTick = presenceStore.lastUpdatedAt;
  void _notificationTick;
  void _presenceTick;

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

function memberKey(member) {
  return member.identity || member.userId || member.connectionId || member.displayName;
}

function isSelfMember(member) {
  const keys = new Set([
    presenceStore.identity,
    presenceStore.userId,
    presenceStore.connectionId,
    presenceStore.displayName,
  ].map(cleanText).filter(Boolean));

  return [member.identity, member.userId, member.connectionId, member.displayName]
    .map(cleanText)
    .filter(Boolean)
    .some((value) => keys.has(value));
}

function isSpeaking(member) {
  return [member.identity, member.userId, member.connectionId, member.displayName]
    .map(cleanText)
    .filter(Boolean)
    .some((key) => presenceStore.speakingIdentities?.[key]);
}

function voiceState(member) {
  return getVoiceMemberAudioState(member);
}

function volumeIdentity(member) {
  const state = voiceState(member);
  return cleanText(state.volumeIdentity || state.identity || member.identity || member.userId || member.displayName);
}

function getVolumePercent(member, source) {
  const state = voiceState(member);
  if (source === 'mic') return clampVolumePercent(state.micVolumePercent);
  if (source === 'appaudio') return clampVolumePercent(state.appAudioVolumePercent);
  return 100;
}

function switchToChannel(channelId) {
  const cleanId = cleanText(channelId);
  if (!cleanId) return;
  if (typeof window !== 'undefined' && typeof window.switchChannel === 'function') {
    window.switchChannel(cleanId);
  }
  markChannelRead(cleanId);
}

function mentionMember(member) {
  if (!member || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('doni:insert-mention', {
    detail: {
      userId: member.userId || member.identity,
      identity: member.identity || member.userId,
      connectionId: member.connectionId || '',
      displayName: member.displayName,
      avatarColor: member.avatarColor,
      avatarPreset: member.avatarPreset,
      avatarUrl: member.avatarUrl,
      source: 'channel_member',
    },
  }));
}

function setMemberVolume(member, source, event) {
  const identity = volumeIdentity(member);
  if (!identity || typeof window === 'undefined' || typeof window.setParticipantVolume !== 'function') return;

  const rawValue = event?.target?.value ?? 100;
  const value = clampVolumePercent(rawValue);
  window.setParticipantVolume(identity, source, value);
}
</script>

<template>
  <div id="channel-list" class="discord-channel-list stage23-voice-list">
    <div
      v-for="channel in channelRows"
      :key="channel.id"
      class="channel-row voice-channel-card"
      :class="{ active: channel.id === currentChannelId }"
    >
      <button
        type="button"
        class="channel-item voice-channel-button"
        :class="{ active: channel.id === currentChannelId }"
        @click="switchToChannel(channel.id)"
      >
        <span class="channel-icon">🔊</span>
        <span class="channel-name">{{ channel.name }}</span>
        <span class="channel-right-area">
          <span v-if="channel.mentions > 0" class="channel-mention-badge">@{{ channel.mentions > 99 ? '99+' : channel.mentions }}</span>
          <span v-else-if="channel.unread > 0" class="channel-unread-dot" :title="`${channel.unread} 条未读`"></span>
          <span class="channel-member-count channel-count">{{ channel.members.length }}</span>
        </span>
      </button>

      <div
        v-if="channel.members.length > 0"
        class="channel-participants voice-member-list"
      >
        <div
          v-for="member in channel.members"
          :key="memberKey(member)"
          class="voice-member-row"
          :class="{
            self: isSelfMember(member),
            'active-speaker': isSpeaking(member),
            'mic-open': voiceState(member).micOpen,
            'mic-closed': !voiceState(member).micOpen,
          }"
          title="右键 @ 这个成员"
          @contextmenu.prevent.stop="mentionMember(member)"
        >
          <div class="voice-member-mainline">
            <span
              class="voice-member-avatar"
              :class="{ 'mic-open': voiceState(member).micOpen, 'mic-closed': !voiceState(member).micOpen }"
              :style="member.avatarColor ? { background: member.avatarColor } : null"
              :title="voiceState(member).micTitle"
            >{{ member.displayName.slice(0, 1).toUpperCase() }}</span>

            <span class="voice-member-identity">
              <span class="voice-member-name-line">
                <span class="voice-member-name" :title="member.displayName">{{ member.displayName }}</span>
                <span v-if="isSelfMember(member)" class="self-tag">我</span>
              </span>
              <span class="voice-member-meta" :class="{ 'mic-open': voiceState(member).micOpen, 'mic-closed': !voiceState(member).micOpen }">
                {{ voiceState(member).micLabel }}
              </span>
            </span>

            <span
              class="voice-member-mic"
              :class="{ 'mic-open': voiceState(member).micOpen, 'mic-closed': !voiceState(member).micOpen }"
              :title="voiceState(member).micTitle"
            >{{ voiceState(member).micIcon }}</span>
          </div>

          <div
            v-if="!isSelfMember(member)"
            class="voice-member-volume-row source-mic"
            title="语音/麦克风音量"
          >
            <span class="voice-member-volume-icon">🎤</span>
            <input
              type="range"
              class="volume-slider voice-member-volume-slider"
              min="0"
              max="300"
              step="1"
              :value="getVolumePercent(member, 'mic')"
              aria-label="语音/麦克风音量"
              @input="setMemberVolume(member, 'mic', $event)"
            >
            <span class="voice-member-volume-input-wrap">
              <input
                type="text"
                inputmode="numeric"
                class="voice-member-volume-number"
                :value="getVolumePercent(member, 'mic')"
                aria-label="语音/麦克风音量百分比"
                @focus="$event.target.select()"
                @input="setMemberVolume(member, 'mic', $event)"
              >
              <span class="voice-member-volume-unit">%</span>
            </span>
          </div>

          <div
            v-if="voiceState(member).hasAppAudio && !isSelfMember(member)"
            class="voice-member-volume-row source-appaudio"
            title="应用/进程共享音频音量"
          >
            <span class="voice-member-volume-icon">🖥️</span>
            <input
              type="range"
              class="volume-slider voice-member-volume-slider"
              min="0"
              max="300"
              step="1"
              :value="getVolumePercent(member, 'appaudio')"
              aria-label="应用共享音量"
              @input="setMemberVolume(member, 'appaudio', $event)"
            >
            <span class="voice-member-volume-input-wrap">
              <input
                type="text"
                inputmode="numeric"
                class="voice-member-volume-number"
                :value="getVolumePercent(member, 'appaudio')"
                aria-label="应用共享音量百分比"
                @focus="$event.target.select()"
                @input="setMemberVolume(member, 'appaudio', $event)"
              >
              <span class="voice-member-volume-unit">%</span>
            </span>
          </div>
        </div>
      </div>

      <div v-else class="voice-channel-empty">暂无成员</div>
    </div>
  </div>
</template>

<style scoped>
.voice-member-row {
  cursor: context-menu;
}

.voice-member-row.active-speaker {
  box-shadow: inset 0 0 0 1px rgba(35, 165, 89, 0.5), 0 0 14px rgba(35, 165, 89, 0.18);
}

.voice-member-avatar {
  position: relative;
}

.voice-member-avatar::after {
  content: '';
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  border: 2px solid #2b2d31;
  background: #949ba4;
}

.voice-member-avatar.mic-open::after {
  background: #23a559;
}

.voice-member-avatar.mic-closed::after {
  background: #f23f42;
}

.voice-member-mic.mic-open,
.voice-member-meta.mic-open {
  color: #23a559;
}

.voice-member-mic.mic-closed,
.voice-member-meta.mic-closed {
  color: #f23f42;
}

.voice-member-volume-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 42px;
  align-items: center;
  gap: 7px;
  margin-top: 6px;
  padding-left: 34px;
  color: #949ba4;
  font-size: 11px;
  cursor: default;
}


.voice-member-volume-icon {
  font-size: 12px;
  text-align: center;
}

.source-mic .voice-member-volume-icon {
  color: #b5bac1;
}

.source-appaudio .voice-member-volume-icon {
  color: #f0b232;
}

.voice-member-volume-slider {
  min-width: 0;
}

.voice-member-volume-input-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 1px;
}

.voice-member-volume-number {
  width: 28px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: #111214;
  color: #f2f3f5;
  font-size: 11px;
  font-weight: 700;
  text-align: right;
  outline: none;
}

.voice-member-volume-unit {
  width: 8px;
  color: #b5bac1;
  font-size: 10px;
}

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
