<script setup>
import { computed, reactive } from 'vue';
import BaseAvatar from '../common/BaseAvatar.vue';
import { appStore } from '../../stores/appStore.js';
import { presenceStore } from '../../stores/presenceStore.js';
import {
  getSelfDisplayName,
  getStableAvatarColor,
  profileStore,
} from '../../stores/profileStore.js';
import {
  setParticipantVolume,
  getParticipantVolumePercent,
} from '../../app/runtime.js';

const emit = defineEmits(['switch-channel']);

const fallbackChannels = [
  { id: 'day0', name: 'day0', type: 'voice', members: [] },
  { id: 'day1', name: 'day1', type: 'voice', members: [] },
  { id: 'day2', name: 'day2', type: 'voice', members: [] },
];

const channels = computed(() => {
  return presenceStore.channels.length > 0 ? presenceStore.channels : fallbackChannels;
});

const currentChannel = computed(() => appStore.connection.currentChannel || '');
const selfIdentity = computed(() => presenceStore.identity || '');
const selfDisplayName = computed(() => getSelfDisplayName(presenceStore.displayName || appStore.connection.username || ''));

// 只缓存输入框正在编辑的值；真实音量仍由 runtime/userVolumes/localStorage 管理。
const volumeInputs = reactive({});

function getChannelId(channel) {
  return String(channel?.id || channel?.name || '').trim();
}

function getChannelName(channel) {
  return String(channel?.name || channel?.id || '').trim();
}

function getMembers(channel) {
  return Array.isArray(channel?.members) ? channel.members : [];
}

function getSortedMembers(channel) {
  return [...getMembers(channel)].sort((a, b) => {
    const aSelf = isSelf(a) ? 0 : 1;
    const bSelf = isSelf(b) ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    return getMemberName(a).localeCompare(getMemberName(b), 'zh-Hans-CN');
  });
}

function getMemberIdentity(member) {
  if (!member) return '';
  if (typeof member === 'string') return member;
  return String(member.identity || member.name || member.displayName || '').trim();
}

function getMemberKey(member, index) {
  return getMemberIdentity(member) || `${getMemberName(member)}-${index}`;
}

function getRawMemberName(member) {
  if (!member) return '';
  if (typeof member === 'string') return member;
  return String(member.displayName || member.name || member.identity || '').trim();
}

function isSelf(member) {
  const identity = getMemberIdentity(member);
  const displayName = getRawMemberName(member);
  return Boolean(
    (selfIdentity.value && identity === selfIdentity.value) ||
    (presenceStore.displayName && displayName === presenceStore.displayName) ||
    (selfDisplayName.value && displayName === selfDisplayName.value)
  );
}

function getMemberName(member) {
  if (isSelf(member)) return selfDisplayName.value;
  return getRawMemberName(member) || '未命名用户';
}

function getMemberAvatarColor(member) {
  if (isSelf(member)) return profileStore.avatarColor;
  return getStableAvatarColor(getMemberIdentity(member) || getMemberName(member));
}

function getMemberAvatarPreset(member) {
  return isSelf(member) ? profileStore.avatarPreset : member.avatarPreset;
}

function getMemberAvatarUrl(member) {
  return isSelf(member) ? profileStore.avatarUrl : member.avatarUrl;
}

function isMemberSpeaking(member) {
  const identity = getMemberIdentity(member);
  const userId = member?.userId;
  const s = presenceStore.speakingIdentities || {};
  return !!(identity && s[identity]) || !!(userId && s[userId]);
}

function getVolumeCacheKey(member) {
  return getMemberName(member) || getMemberIdentity(member) || 'unknown';
}

function resolveSavedVolumePercent(member) {
  const identity = getMemberIdentity(member);
  const displayName = getMemberName(member);

  const identityPercent = identity ? getParticipantVolumePercent(identity, 'mic') : 100;
  const displayNamePercent = displayName && displayName !== identity
    ? getParticipantVolumePercent(displayName, 'mic')
    : identityPercent;

  // 对方重连后 identity 可能变化；如果 displayName 有保存值，优先恢复 displayName 的音量。
  if (displayNamePercent !== 100) return displayNamePercent;
  return identityPercent;
}

function getVolumeInputValue(member) {
  const cacheKey = getVolumeCacheKey(member);
  if (volumeInputs[cacheKey] === undefined) {
    volumeInputs[cacheKey] = String(resolveSavedVolumePercent(member));
  }
  return volumeInputs[cacheKey];
}

function clampVolumePercent(value) {
  const normalized = String(value ?? '').replace(/[％%]/g, '').trim();
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(Math.round(n), 300));
}

function applyMicVolume(member, value, { commit = true } = {}) {
  const identity = getMemberIdentity(member);
  const displayName = getMemberName(member);
  const cacheKey = getVolumeCacheKey(member);

  if (!identity || isSelf(member)) return;

  if (value === '') {
    volumeInputs[cacheKey] = '';
    return;
  }

  const percent = clampVolumePercent(value);
  if (percent === null) return;

  volumeInputs[cacheKey] = commit ? String(percent) : String(value).replace(/[％%]/g, '').trim();

  // 真实播放链路按 LiveKit identity 调整。
  setParticipantVolume(identity, 'mic', percent);

  // 额外按 displayName 存一份，用于对方重连、identity 变化后恢复上次音量。
  if (displayName && displayName !== identity) {
    setParticipantVolume(displayName, 'mic', percent);
  }
}

function handleMicVolumeInput(member, value) {
  applyMicVolume(member, value, { commit: false });
}

function commitMicVolume(member, value) {
  applyMicVolume(member, value, { commit: true });
}

function handleSwitchChannel(channel) {
  const channelName = getChannelName(channel);
  if (!channelName) return;
  emit('switch-channel', channelName);
}
</script>

<template>
  <div id="channel-list" class="voice-channel-list stage22-voice-list">
    <div
      v-for="channel in channels"
      :key="getChannelId(channel)"
      class="channel-row voice-channel-card"
      :class="{ active: currentChannel === getChannelName(channel) }"
    >
      <button
        type="button"
        class="channel-item voice-channel-button"
        :class="{ active: currentChannel === getChannelName(channel) }"
        @click="handleSwitchChannel(channel)"
      >
        <span class="channel-icon">🔊</span>
        <span class="channel-name">{{ getChannelName(channel) }}</span>
        <span class="channel-count">{{ getMembers(channel).length }}</span>
      </button>

      <div
        class="channel-participants voice-member-list"
        :class="{ empty: getMembers(channel).length === 0 }"
      >
        <template v-if="getMembers(channel).length > 0">
          <div
            v-for="(member, index) in getSortedMembers(channel)"
            :key="getMemberKey(member, index)"
            class="voice-member-row"
            :class="{ self: isSelf(member) }"
          >
            <div class="voice-member-mainline">
              <BaseAvatar
                :name="getMemberName(member)"
                :color="getMemberAvatarColor(member)"
                :preset="getMemberAvatarPreset(member)"
                :avatarUrl="getMemberAvatarUrl(member)"
                :isSpeaking="isMemberSpeaking(member)"
                size="sm"
                online
              />

              <div class="voice-member-identity">
                <div class="voice-member-name-line">
                  <span class="voice-member-name" :title="getMemberName(member)">{{ getMemberName(member) }}</span>
                  <span v-if="isSelf(member)" class="self-tag">我</span>
                </div>
                <div class="voice-member-meta">{{ isSelf(member) ? '本机语音' : '语音成员' }}</div>
              </div>

              <span class="voice-member-mic" title="麦克风在线">🎙</span>
            </div>

            <div v-if="!isSelf(member)" class="voice-member-volume-row">
              <span class="voice-member-volume-icon">🔉</span>
              <input
                class="voice-member-volume-slider"
                type="range"
                min="0"
                max="300"
                step="1"
                :value="getVolumeInputValue(member)"
                @input="handleMicVolumeInput(member, $event.target.value)"
              >
              <div class="voice-member-volume-input-wrap">
                <input
                  class="voice-member-volume-number"
                  type="text"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  :value="getVolumeInputValue(member)"
                  @input="handleMicVolumeInput(member, $event.target.value)"
                  @change="commitMicVolume(member, $event.target.value)"
                  @blur="commitMicVolume(member, $event.target.value)"
                  @keydown.enter.prevent="commitMicVolume(member, $event.target.value)"
                >
                <span class="voice-member-volume-unit">%</span>
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="voice-channel-empty">暂无成员</div>
        </template>
      </div>
    </div>
  </div>
</template>
