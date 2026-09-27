<script setup>
import { computed, ref } from 'vue';
import { Volume2, Monitor, Mic, Music2, MicOff, ChevronDown, Trash2 } from 'lucide-vue-next';
import { workspaceStore } from '../../stores/workspaceStore.js';
import { sharingStore } from '../../stores/sharingStore.js';
import { toggleSharedAudio, watchSharedScreen } from '../../app/runtime.js';
import BaseAvatar from '../common/BaseAvatar.vue';
import { appStore } from '../../stores/appStore.js';
import {
  presenceStore,
  getVoiceMemberAudioState,
  getAuthoritativeChannelMembers,
} from '../../stores/presenceStore.js';
import { chatStore, getChannelNotification, markChannelRead } from '../../stores/chatStore.js';

const DEFAULT_CHANNELS = ['day0', 'day1', 'day2'];
const emit = defineEmits(['switch-channel', 'delete-channel']);
const expandedMembers = ref({});
function memberShares(member) { return sharingStore.shares.filter(s => [member.identity, member.userId, volumeIdentity(member)].includes(s.identity)); }
function toggleMember(member) { const id = memberKey(member); expandedMembers.value[id] = !expandedMembers.value[id]; }

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
    isLobby: !!channel.isLobby,
    displayName: channel.displayName || name || id,
    members,
  };
}

const currentChannelId = computed(() => cleanText(workspaceStore.viewChannel || appStore.connection.currentChannel || chatStore.currentChannelId));

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
    const members = getAuthoritativeChannelMembers(channel.id);
    rows.push({
      ...channel,
      members,
      unread: Number(notice.unread || 0),
      mentions: Number(notice.mentions || 0),
    });
  };

  if (presenceStore.channels.length) presenceStore.channels.forEach(addChannel);
  else if (!presenceStore.connected) (appStore.connection.channels?.length ? appStore.connection.channels : DEFAULT_CHANNELS).forEach(addChannel);

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
  emit('switch-channel', cleanId);
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
      v-for="(channel, index) in channelRows"
      :key="channel.id"
      class="channel-row voice-channel-card"
      :class="{ active: channel.id === currentChannelId }"
    >
      <div v-if="index === 0 || channel.isLobby !== channelRows[index - 1].isLobby" class="channel-category-label">{{ channel.isLobby ? '主大厅' : '游戏语音' }}</div>
      <div class="channel-select-row">
      <button
        type="button"
        class="channel-item voice-channel-button"
        :class="{ active: channel.id === currentChannelId }"
        @click="switchToChannel(channel.id)"
      >
        <Volume2 class="channel-icon" :size="16" />
        <span class="channel-name">{{ channel.displayName || channel.name }}</span>
        <span class="channel-right-area">
          <span v-if="channel.mentions > 0" class="channel-mention-badge">@{{ channel.mentions > 99 ? '99+' : channel.mentions }}</span>
          <span v-else-if="channel.unread > 0" class="channel-unread-dot" :title="`${channel.unread} 条未读`"></span>
          <span class="channel-member-count channel-count">{{ channel.members.length }}</span>
        </span>
      </button>
      <button v-if="!channel.isLobby && workspaceStore.supported" class="channel-delete-button" :disabled="workspaceStore.busy" :aria-label="`删除频道 ${channel.displayName || channel.name}`" @click="emit('delete-channel', channel)"><Trash2 :size="13" /></button>
      </div>

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
          <button type="button" class="voice-member-mainline" :aria-expanded="!!expandedMembers[memberKey(member)]" :aria-label="`${member.displayName} 的声音控制`" @click="toggleMember(member)">
            <span
              class="voice-member-avatar-shell"
              :class="{ 'mic-open': voiceState(member).micOpen, 'mic-closed': !voiceState(member).micOpen }"
              :title="voiceState(member).micTitle"
            >
              <BaseAvatar
                :name="member.displayName"
                :color="member.avatarColor"
                :preset="member.avatarPreset"
                :avatar-url="member.avatarUrl"
                :is-speaking="isSpeaking(member)"
                size="sm"
              />
              <span
                class="voice-member-mic-dot"
                :class="{ 'mic-open': voiceState(member).micOpen, 'mic-closed': !voiceState(member).micOpen }"
              ></span>
            </span>

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
            ><component :is="voiceState(member).micOpen ? Mic : MicOff" :size="13" /></span>
            <ChevronDown v-if="!isSelfMember(member)" :size="12" />
          </button>

          <div
            v-if="!isSelfMember(member) && expandedMembers[memberKey(member)]"
            class="voice-member-volume-row source-mic"
            title="语音/麦克风音量"
          >
            <Mic class="voice-member-volume-icon" :size="13" />
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
            v-if="memberShares(member).some(s => s.kind === 'appaudio') && !isSelfMember(member) && expandedMembers[memberKey(member)]"
            class="voice-member-volume-row source-appaudio"
            title="应用/进程共享音频音量"
          >
            <Music2 class="voice-member-volume-icon" :size="13" />
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
          <div v-if="!isSelfMember(member)" class="member-share-actions"><button v-for="share in memberShares(member)" :key="share.id" :title="share.title" :aria-pressed="share.wanted" @click="share.kind === 'screen' ? watchSharedScreen(share.id) : toggleSharedAudio(share.id)"><component :is="share.kind === 'screen' ? Monitor : Music2" :size="12" />{{ share.kind === 'screen' ? '观看' : share.wanted ? '停止收听' : '收听程序' }}</button></div>
        </div>
      </div>
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

.voice-member-avatar-shell {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  transition: box-shadow 0.16s ease, transform 0.16s ease;
}

.voice-member-avatar-shell :deep(.base-avatar),
.voice-member-avatar-shell :deep(.base-avatar-img) {
  width: 32px;
  height: 32px;
}

.voice-member-row.active-speaker .voice-member-avatar-shell {
  box-shadow:
    0 0 0 2px rgba(35, 165, 89, 0.95),
    0 0 12px rgba(35, 165, 89, 0.7),
    0 0 22px rgba(35, 165, 89, 0.35);
}

.voice-member-mic-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  border: 2px solid #2b2d31;
  background: #949ba4;
  pointer-events: none;
}

.voice-member-mic-dot.mic-open {
  background: #23a559;
}

.voice-member-mic-dot.mic-closed {
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
