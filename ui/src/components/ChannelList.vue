<script setup>
import { computed } from 'vue';
import { appStore } from '../stores/appStore.js';
import { presenceStore, getVoiceStateByMember } from '../stores/presenceStore.js';
import { chatStore, getChannelNotification, markChannelRead } from '../stores/chatStore.js';

const DEFAULT_CHANNELS = ['day0', 'day1', 'day2'];

const DEFAULT_VOICE_STATE = {
  micState: 'none',
  micIcon: '🚫',
  micLabel: '未开麦',
  micTitle: '未检测到麦克风音轨',
  hasMic: false,
  hasScreenAudio: false,
  hasAppAudio: false,
  volumes: {
    mic: 100,
    screen: 100,
    appaudio: 100,
  },
};

function cleanText(value) {
  return String(value || '').trim();
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

function getMemberVoiceState(member) {
  const state = getVoiceStateByMember(member);
  if (!state) return { ...DEFAULT_VOICE_STATE };
  return {
    ...DEFAULT_VOICE_STATE,
    ...state,
    volumes: {
      ...DEFAULT_VOICE_STATE.volumes,
      ...(state.volumes || {}),
    },
  };
}

function decorateMember(member) {
  const normalized = normalizeMember(member);
  if (!normalized) return null;
  return {
    ...normalized,
    voiceState: getMemberVoiceState(normalized),
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
    ? channel.members.map(decorateMember).filter(Boolean)
    : [];

  return {
    id: id || name,
    name: name || id,
    members,
  };
}

const currentChannelId = computed(() => cleanText(appStore.connection.currentChannel || chatStore.currentChannelId));

const channelRows = computed(() => {
  // 显式依赖通知/语音状态时间戳，保证 badge / mic / appaudio 音量变化时重新计算。
  const _notificationTick = chatStore.notificationUpdatedAt;
  const _voiceTick = presenceStore.voiceStateUpdatedAt;
  void _notificationTick;
  void _voiceTick;

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

function isSelfMember(member) {
  if (!member) return false;
  const keys = [
    member.identity,
    member.userId,
    member.connectionId,
    member.displayName,
  ].map(cleanText).filter(Boolean);

  return [
    presenceStore.identity,
    presenceStore.userId,
    presenceStore.connectionId,
    presenceStore.displayName,
  ].map(cleanText).filter(Boolean).some((key) => keys.includes(key));
}

function isMemberSpeaking(member) {
  if (!member) return false;
  const keys = [
    member.identity,
    member.userId,
    member.connectionId,
    member.displayName,
  ].map(cleanText).filter(Boolean);

  return keys.some((key) => !!presenceStore.speakingIdentities[key]);
}

function getMemberInitial(member) {
  return cleanText(member?.displayName || member?.identity || member?.userId).slice(0, 1).toUpperCase() || '?';
}

function getMemberVolume(member, source = 'appaudio') {
  return Number(member?.voiceState?.volumes?.[source] ?? DEFAULT_VOICE_STATE.volumes[source] ?? 100);
}

function shouldShowAppAudioVolume(member) {
  return !!member?.voiceState?.hasAppAudio && !isSelfMember(member);
}

function setMemberVolume(member, source, event) {
  const value = Number(event?.target?.value ?? 100);
  const identity = cleanText(member?.identity || member?.userId || member?.displayName);
  if (!identity || typeof window === 'undefined' || typeof window.setParticipantVolume !== 'function') return;
  window.setParticipantVolume(identity, source, value);
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
          class="voice-channel-member"
          :class="[
            `mic-${member.voiceState.micState}`,
            {
              speaking: isMemberSpeaking(member),
              self: isSelfMember(member),
              'has-appaudio': shouldShowAppAudioVolume(member),
            },
          ]"
          title="右键 @ 这个成员"
          @contextmenu.prevent.stop="mentionMember(member)"
        >
          <div class="voice-channel-member-main">
            <span class="voice-channel-member-avatar-wrap">
              <span class="voice-member-avatar">{{ getMemberInitial(member) }}</span>
              <span
                class="voice-channel-mic-dot"
                :class="`mic-${member.voiceState.micState}`"
                :title="member.voiceState.micTitle"
              ></span>
            </span>

            <span class="voice-member-name" :title="member.displayName">
              {{ member.displayName }}
              <span v-if="isSelfMember(member)" class="voice-member-self-tag">我</span>
            </span>

            <span
              class="voice-channel-mic-icon"
              :class="`mic-${member.voiceState.micState}`"
              :title="member.voiceState.micTitle"
            >
              {{ member.voiceState.micIcon }}
            </span>
          </div>

          <div
            v-if="shouldShowAppAudioVolume(member)"
            class="voice-channel-appaudio-row"
            title="音频共享音量"
            @click.stop
            @mousedown.stop
            @contextmenu.stop
          >
            <span class="voice-channel-volume-icon">🖥️</span>
            <span class="voice-channel-volume-label">共享音量</span>
            <input
              type="range"
              class="voice-channel-volume-slider"
              min="0"
              max="300"
              step="1"
              :value="getMemberVolume(member, 'appaudio')"
              aria-label="音频共享音量"
              @input="setMemberVolume(member, 'appaudio', $event)"
            />
            <span class="voice-channel-volume-number">{{ getMemberVolume(member, 'appaudio') }}%</span>
          </div>
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

.voice-channel-member {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 3px 6px 4px 2px;
  border-radius: 6px;
  cursor: context-menu;
  transition: background 0.15s ease, color 0.15s ease;
}

.voice-channel-member:hover,
.voice-channel-member.speaking {
  background: rgba(64, 66, 73, 0.9);
}

.voice-channel-member.speaking .voice-member-avatar {
  box-shadow: 0 0 0 2px #23a559, 0 0 12px rgba(35, 165, 89, 0.55);
}

.voice-channel-member-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.voice-channel-member-avatar-wrap {
  position: relative;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
}

.voice-member-avatar {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: #5865f2;
  color: #fff;
  font-size: 11px;
  font-weight: 800;
  line-height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.voice-channel-mic-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  border: 2px solid #2b2d31;
  background: #80848e;
}

.voice-channel-mic-dot.mic-open {
  background: #23a559;
}

.voice-channel-mic-dot.mic-muted {
  background: #f23f42;
}

.voice-channel-mic-dot.mic-none {
  background: #80848e;
}

.voice-member-name {
  flex: 1;
  min-width: 0;
  color: #b5bac1;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.voice-channel-member:hover .voice-member-name,
.voice-channel-member.speaking .voice-member-name {
  color: #f2f3f5;
}

.voice-member-self-tag {
  margin-left: 4px;
  color: #949ba4;
  font-size: 10px;
}

.voice-channel-mic-icon {
  flex: 0 0 auto;
  width: 18px;
  text-align: center;
  font-size: 13px;
  opacity: 0.9;
}

.voice-channel-mic-icon.mic-open {
  color: #23a559;
}

.voice-channel-mic-icon.mic-muted {
  color: #f23f42;
}

.voice-channel-mic-icon.mic-none {
  filter: grayscale(1);
  opacity: 0.65;
}

.voice-channel-appaudio-row {
  display: grid;
  grid-template-columns: 18px 54px minmax(0, 1fr) 38px;
  align-items: center;
  gap: 5px;
  padding-left: 27px;
  color: #949ba4;
  font-size: 11px;
  cursor: default;
}

.voice-channel-volume-icon {
  font-size: 12px;
}

.voice-channel-volume-label {
  white-space: nowrap;
}

.voice-channel-volume-slider {
  width: 100%;
  height: 5px;
  -webkit-appearance: none;
  appearance: none;
  background: #4f545c;
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}

.voice-channel-volume-slider:hover {
  background: #80848e;
}

.voice-channel-volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 999px;
  background: #dbdee1;
  border: 2px solid #313338;
  cursor: pointer;
}

.voice-channel-volume-number {
  text-align: right;
  color: #b5bac1;
  font-variant-numeric: tabular-nums;
}
</style>
