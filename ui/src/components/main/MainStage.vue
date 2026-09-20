<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import BaseAvatar from '../common/BaseAvatar.vue';
import { appStore } from '../../stores/appStore.js';
import { presenceStore, getAuthoritativeChannelMembers } from '../../stores/presenceStore.js';
import { getSelfDisplayName, getStableAvatarColor, profileStore } from '../../stores/profileStore.js';
import { getActiveTheme } from '../../stores/themeStore.js';
import { getLiveKitRoom } from '../../app/runtime.js';

const fallbackChannelName = computed(() => appStore.connection.currentChannel || '未选择频道');

const currentChannel = computed(() => {
  const target = appStore.connection.currentChannel;
  if (!target) return null;
  return presenceStore.channels.find((channel) => channel.name === target || channel.id === target) || null;
});

const currentChannelName = computed(() => currentChannel.value?.name || currentChannel.value?.id || fallbackChannelName.value);
const isConnected = computed(() => !!appStore.connection.isConnected);
const isInLobby = computed(() => !!appStore.connection.isInLobby);
const memberCount = computed(() => getAuthoritativeChannelMembers(appStore.connection.currentChannel).length);
const selfName = computed(() => getSelfDisplayName(appStore.connection.username || presenceStore.displayName || ''));
const activeThemeName = computed(() => getActiveTheme().name);
const hasMediaSurface = ref(false);
const dashboardOpen = ref(true);
let videoObserver = null;
let statsTimer = null;
let lastTrafficSample = null;

const connectionStats = reactive({
  latencyMs: null,
  packetLossPercent: null,
  uploadKbps: null,
  downloadKbps: null,
  qualityLabel: '采集中',
  qualityTone: 'unknown',
  samples: [18, 24, 20, 32, 28, 36, 30, 22],
});

const channelMembers = computed(() => {
  const rows = getAuthoritativeChannelMembers(appStore.connection.currentChannel);
  return [...rows].sort((a, b) => {
    const aSelf = isSelfMember(a) ? 0 : 1;
    const bSelf = isSelfMember(b) ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    return getMemberName(a).localeCompare(getMemberName(b), 'zh-Hans-CN');
  });
});

const visibleMemberCards = computed(() => channelMembers.value.slice(0, 10));

const connectionSummary = computed(() => {
  if (isConnected.value) return '已连接语音频道';
  if (isInLobby.value) return '已进入大厅，选择频道后连接语音';
  return '尚未进入大厅';
});

const mediaStatusCards = computed(() => [
  {
    key: 'mic',
    icon: appStore.media.micOn ? '🎙️' : '🔇',
    label: '麦克风',
    value: appStore.media.micOn ? '已开启' : '未开启',
    active: appStore.media.micOn,
  },
  {
    key: 'screen',
    icon: appStore.media.screenOn ? '🖥️' : '📺',
    label: '屏幕共享',
    value: appStore.media.screenOn ? '正在共享' : '未共享',
    active: appStore.media.screenOn,
  },
  {
    key: 'app-audio',
    icon: appStore.media.appAudioSharing ? '🎵' : '🎶',
    label: '应用音频',
    value: appStore.media.appAudioSharing ? '共享中' : '未共享',
    active: appStore.media.appAudioSharing,
  },
]);

const latencyText = computed(() => {
  return Number.isFinite(connectionStats.latencyMs) ? `${connectionStats.latencyMs} ms` : '采集中';
});

const packetLossText = computed(() => {
  return Number.isFinite(connectionStats.packetLossPercent) ? `${connectionStats.packetLossPercent.toFixed(1)}%` : '采集中';
});

const bitrateText = computed(() => {
  const up = Number.isFinite(connectionStats.uploadKbps) ? Math.round(connectionStats.uploadKbps) : null;
  const down = Number.isFinite(connectionStats.downloadKbps) ? Math.round(connectionStats.downloadKbps) : null;
  if (up === null && down === null) return '采集中';
  return `↑${up ?? 0} / ↓${down ?? 0} kbps`;
});

function getMemberIdentity(member) {
  if (!member) return '';
  if (typeof member === 'string') return member;
  return String(member.identity || member.name || member.displayName || '').trim();
}

function getMemberName(member) {
  if (!member) return '未命名用户';
  if (typeof member === 'string') return member;
  return String(member.displayName || member.name || member.identity || '未命名用户').trim();
}

function isSelfMember(member) {
  const identity = getMemberIdentity(member);
  const name = getMemberName(member);
  return Boolean(
    (presenceStore.identity && identity === presenceStore.identity) ||
    (presenceStore.displayName && name === presenceStore.displayName) ||
    (selfName.value && name === selfName.value)
  );
}

function getMemberAvatarColor(member) {
  if (isSelfMember(member)) return profileStore.avatarColor;
  return getStableAvatarColor(getMemberIdentity(member) || getMemberName(member));
}

function getMemberAvatarPreset(member) {
  return isSelfMember(member) ? profileStore.avatarPreset : '';
}

function isLikelyMediaNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  if (node.id === 'audio-container') return false;
  return node.matches?.('video, .video-wrapper, .screen-restore-card, canvas') || node.querySelector?.('video, canvas');
}

function updateMediaSurfaceState() {
  const container = document.getElementById('video-container');
  const hasSurface = Array.from(container?.children || []).some(isLikelyMediaNode);

  if (hasSurface !== hasMediaSurface.value) {
    hasMediaSurface.value = hasSurface;

    // 有屏幕共享/视频时默认收起状态面板，避免遮挡画面；用户可点右上角按钮重新打开。
    dashboardOpen.value = !hasSurface;
  }
}

function toggleDashboard() {
  dashboardOpen.value = !dashboardOpen.value;
}

function findPeerConnections(room) {
  const candidates = [
    room?.engine?.pcManager?.publisher?.pc,
    room?.engine?.pcManager?.subscriber?.pc,
    room?.engine?.pcManager?.publisher,
    room?.engine?.pcManager?.subscriber,
    room?.engine?.publisher?.pc,
    room?.engine?.subscriber?.pc,
    room?.engine?.publisher,
    room?.engine?.subscriber,
  ];

  return candidates.filter((item, index, rows) => {
    return item && typeof item.getStats === 'function' && rows.indexOf(item) === index;
  });
}

function classifyConnection(latencyMs, lossPercent) {
  if (!Number.isFinite(latencyMs) && !Number.isFinite(lossPercent)) {
    return { label: isConnected.value ? '采集中' : '未连接', tone: isConnected.value ? 'unknown' : 'offline' };
  }

  const latency = Number.isFinite(latencyMs) ? latencyMs : 0;
  const loss = Number.isFinite(lossPercent) ? lossPercent : 0;

  if (latency <= 80 && loss <= 1) return { label: '优秀', tone: 'good' };
  if (latency <= 160 && loss <= 3) return { label: '良好', tone: 'ok' };
  return { label: '拥塞', tone: 'bad' };
}

function pushQualitySample(latencyMs, lossPercent) {
  const latencyScore = Number.isFinite(latencyMs) ? Math.min(100, Math.max(8, latencyMs / 2)) : 24;
  const lossScore = Number.isFinite(lossPercent) ? Math.min(100, lossPercent * 12) : 0;
  const value = Math.max(8, Math.min(100, latencyScore + lossScore));
  connectionStats.samples = [...connectionStats.samples.slice(-23), Math.round(value)];
}

async function collectConnectionStats() {
  const room = getLiveKitRoom?.();
  if (!room || !isConnected.value) {
    connectionStats.latencyMs = null;
    connectionStats.packetLossPercent = null;
    connectionStats.uploadKbps = null;
    connectionStats.downloadKbps = null;
    connectionStats.qualityLabel = '未连接';
    connectionStats.qualityTone = 'offline';
    lastTrafficSample = null;
    return;
  }

  const pcs = findPeerConnections(room);
  if (pcs.length === 0) {
    connectionStats.qualityLabel = '采集中';
    connectionStats.qualityTone = 'unknown';
    return;
  }

  let rttSeconds = null;
  let packetsLost = 0;
  let packetsTotal = 0;
  let bytesSent = 0;
  let bytesReceived = 0;

  for (const pc of pcs) {
    try {
      const report = await pc.getStats();
      report.forEach((stat) => {
        if (stat.type === 'candidate-pair' && (stat.selected || stat.nominated) && stat.state === 'succeeded') {
          if (Number.isFinite(stat.currentRoundTripTime)) rttSeconds = stat.currentRoundTripTime;
        }

        if (stat.type === 'remote-inbound-rtp' && Number.isFinite(stat.roundTripTime)) {
          rttSeconds = stat.roundTripTime;
        }

        if (stat.type === 'inbound-rtp' && !stat.isRemote) {
          if (Number.isFinite(stat.packetsLost)) packetsLost += Math.max(0, stat.packetsLost);
          if (Number.isFinite(stat.packetsReceived)) packetsTotal += Math.max(0, stat.packetsReceived + Math.max(0, stat.packetsLost || 0));
          if (Number.isFinite(stat.bytesReceived)) bytesReceived += stat.bytesReceived;
        }

        if (stat.type === 'outbound-rtp' && !stat.isRemote) {
          if (Number.isFinite(stat.bytesSent)) bytesSent += stat.bytesSent;
        }
      });
    } catch (_) {
      // getStats 在断线重连瞬间可能失败，下一轮会恢复。
    }
  }

  const now = performance.now();
  if (lastTrafficSample) {
    const seconds = Math.max(0.5, (now - lastTrafficSample.time) / 1000);
    connectionStats.uploadKbps = Math.max(0, ((bytesSent - lastTrafficSample.bytesSent) * 8) / seconds / 1000);
    connectionStats.downloadKbps = Math.max(0, ((bytesReceived - lastTrafficSample.bytesReceived) * 8) / seconds / 1000);
  }
  lastTrafficSample = { time: now, bytesSent, bytesReceived };

  const latencyMs = Number.isFinite(rttSeconds) ? Math.round(rttSeconds * 1000) : null;
  const lossPercent = packetsTotal > 0 ? (packetsLost / packetsTotal) * 100 : null;
  const quality = classifyConnection(latencyMs, lossPercent);

  connectionStats.latencyMs = latencyMs;
  connectionStats.packetLossPercent = lossPercent;
  connectionStats.qualityLabel = quality.label;
  connectionStats.qualityTone = quality.tone;
  pushQualitySample(latencyMs, lossPercent);
}

onMounted(() => {
  updateMediaSurfaceState();
  const container = document.getElementById('video-container');
  if (container) {
    videoObserver = new MutationObserver(updateMediaSurfaceState);
    videoObserver.observe(container, { childList: true, subtree: true });
  }

  collectConnectionStats();
  statsTimer = window.setInterval(collectConnectionStats, 2000);
});

onBeforeUnmount(() => {
  if (videoObserver) videoObserver.disconnect();
  if (statsTimer) window.clearInterval(statsTimer);
});
</script>

<template>
  <main id="main-area" class="main-stage modern-main-stage">
    <header id="header" class="main-header modern-main-header">
      <div class="main-header-title modern-main-title">
        <span class="main-header-icon">#</span>
        <span class="main-header-text">{{ currentChannelName }} 语音频道</span>
      </div>
      <div class="main-header-actions modern-main-actions">
        <span class="main-header-pill" :class="{ connected: isConnected }">{{ connectionSummary }}</span>
        <span class="main-header-pill quality-pill" :class="connectionStats.qualityTone">{{ connectionStats.qualityLabel }}</span>
      </div>
    </header>

    <div id="video-container" class="stage-video-container modern-video-container"></div>



    <div id="audio-container"></div>

    <div id="local-screen-preview-box">
      <div id="local-screen-preview-title">本地屏幕预览（静音）</div>
      <video id="local-screen-preview" muted autoplay playsinline></video>
    </div>
  </main>
</template>
