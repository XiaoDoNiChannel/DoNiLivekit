<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import BaseAvatar from '../common/BaseAvatar.vue';
import { chatStore, shouldGroupWithPrev, toggleReaction, isMessageMentioningSelf, markChannelRead, getTotalMentionCount } from '../../stores/chatStore.js';
import { profileStore } from '../../stores/profileStore.js';
import { presenceStore } from '../../stores/presenceStore.js';
import { renderMessageContent, QUICK_REACTIONS, EMOJI_LIST } from '../../shared/messageRenderer.js';
import { appStore } from '../../stores/appStore.js';
import { silentSyncReaction, uploadChatImage } from '../../shared/apiClient.js';

const emit = defineEmits(['send']);
// ─── 输入框状态 ────────────────────────────────────────────────────────────────
const inputText = ref('');
const textareaEl = ref(null);
const messagesEl = ref(null);
const imageInputEl = ref(null);
const isUploadingImage = ref(false);
const previewImageUrl = ref('');
const pendingImages = ref([]);
const baseDocumentTitle = typeof document !== 'undefined' ? document.title : 'DoNiChannel';
let titleFlashTimer = null;
let titleFlashOn = false;

// ─── @ 提及输入状态 ───────────────────────────────────────────────────────────
const mentionQuery = ref(null);
const mentionActiveIndex = ref(0);
let mentionRange = null;
const selectedMentionMap = new Map();

// ─── Emoji 选择器 ──────────────────────────────────────────────────────────────
const showEmojiPicker = ref(false);
const emojiSearch = ref('');
const filteredEmoji = computed(() => {
  const q = emojiSearch.value.toLowerCase();
  if (!q) return EMOJI_LIST.slice(0, 80);
  return EMOJI_LIST.filter((e) => e.name.includes(q) || e.char.includes(q)).slice(0, 80);
});

// ─── 消息 hover 菜单 ───────────────────────────────────────────────────────────
const hoveredMsgId = ref(null);
const reactionPickerMsgId = ref(null);
const contextMenuMsgId = ref(null);
let hideHoverTimer = null;

function onMsgMouseenter(id) {
  clearTimeout(hideHoverTimer);
  hoveredMsgId.value = id;
}
function onMsgMouseleave() {
  hideHoverTimer = setTimeout(() => {
    if (reactionPickerMsgId.value === null) hoveredMsgId.value = null;
  }, 300);
}
function openReactionPicker(msgId) {
  reactionPickerMsgId.value = reactionPickerMsgId.value === msgId ? null : msgId;
  contextMenuMsgId.value = null;
  hoveredMsgId.value = msgId;
}
function closeReactionPicker() {
  reactionPickerMsgId.value = null;
  hoveredMsgId.value = null;
}

// 右键消息时直接打开表情回应菜单，不再显示 Pin 菜单。
function openMessageContextMenu(msgId) {
  reactionPickerMsgId.value = msgId;
  contextMenuMsgId.value = null;
  hoveredMsgId.value = msgId;
}

function closeMessageContextMenu() {
  contextMenuMsgId.value = null;
}

// 点击空白处关闭 reaction picker & emoji picker
function onDocumentClick(e) {
  if (!e.target.closest('.reaction-picker')) {
    reactionPickerMsgId.value = null;
  }
  if (!e.target.closest('.emoji-picker') && !e.target.closest('.emoji-toggle-btn')) {
    showEmojiPicker.value = false;
  }
  if (!e.target.closest('.mention-picker') && e.target !== textareaEl.value) {
    closeMentionPicker();
  }
  if (!e.target.closest('.msg-context-menu')) {
    contextMenuMsgId.value = null;
  }
}
function onDocumentKeydown(e) {
  if (e.key === 'Escape') {
    previewImageUrl.value = '';
    reactionPickerMsgId.value = null;
    contextMenuMsgId.value = null;
    showEmojiPicker.value = false;
    closeMentionPicker();
  }
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener('doni:insert-mention', handleExternalMentionInsert);
  window.addEventListener('focus', handleWindowFocus);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  if (typeof window !== 'undefined') {
    window.__doniMentionDebug = () => ({
      text: textareaEl.value?.value || inputText.value,
      selectionStart: textareaEl.value?.selectionStart ?? null,
      mentionQuery: mentionQuery.value,
      mentionRange,
      users: mentionUsers.value.map((user) => ({ id: user.id, userId: user.userId, identity: user.identity, displayName: user.displayName, isSelf: user.isSelf, source: user.source })),
      renderUsers: mentionRenderUsers.value.map((user) => ({ id: user.id, userId: user.userId, identity: user.identity, displayName: user.displayName, source: user.source })),
      filtered: filteredMentionCandidates.value.map((user) => ({ id: user.id, displayName: user.displayName, source: user.source })),
      menuCandidates: mentionMenuCandidates.value.map((user) => ({ id: user.id, displayName: user.displayName, source: user.source })),
      show: showMentionMenu.value,
    });
  }
  nextTick(() => {
    resizeComposer();
    scrollToBottom(true);
    markVisibleChannelRead();
  });
});
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener('doni:insert-mention', handleExternalMentionInsert);
  window.removeEventListener('focus', handleWindowFocus);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  stopTitleFlash();
  if (typeof window !== 'undefined' && window.__doniMentionDebug) delete window.__doniMentionDebug;
  clearPendingImages();
});

// ─── 消息列表（带分组标记） ────────────────────────────────────────────────────
const messages = computed(() => chatStore.messages);

const groupedMessages = computed(() => {
  return messages.value.map((msg, idx) => {
    const prev = idx > 0 ? messages.value[idx - 1] : null;
    return {
      ...msg,
      isGrouped: shouldGroupWithPrev(prev, msg),
    };
  });
});

// ─── 自动滚动 ─────────────────────────────────────────────────────────────────
const isAtBottom = ref(true);
const unreadNewMessages = ref(0);
let unreadChannelId = '';

function checkScrollPos() {
  const el = messagesEl.value;
  if (!el) return;
  isAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (isAtBottom.value) {
    unreadNewMessages.value = 0;
    markVisibleChannelRead();
  }
}

function scrollToBottom(force = false) {
  const el = messagesEl.value;
  if (!el) return;
  if (force || isAtBottom.value) {
    unreadNewMessages.value = 0;
    nextTick(() => {
      el.scrollTop = el.scrollHeight;
      isAtBottom.value = true;
      markVisibleChannelRead();
    });
  }
}

function jumpToLatestMessage() {
  unreadNewMessages.value = 0;
  scrollToBottom(true);
}

watch(() => messages.value.length, (newLen, oldLen) => {
  const current = chatStore.currentChannelId || appStore.connection.currentChannel || '';
  if (current !== unreadChannelId) {
    unreadChannelId = current;
    unreadNewMessages.value = 0;
  } else if (newLen > oldLen && !isAtBottom.value) {
    const appended = messages.value.slice(oldLen);
    const incomingCount = appended.filter((msg) => !msg.isSelf).length;
    if (incomingCount > 0) unreadNewMessages.value += incomingCount;
  }

  scrollToBottom();
  if (isAtBottom.value) nextTick(markVisibleChannelRead);
});
watch(() => chatStore.currentChannelId, () => {
  unreadChannelId = chatStore.currentChannelId || '';
  unreadNewMessages.value = 0;
  nextTick(() => {
    scrollToBottom(true);
    markVisibleChannelRead();
  });
});
watch(() => chatStore.notificationUpdatedAt, () => updateTitleFlash());

// ─── 当前频道名 ───────────────────────────────────────────────────────────────
const channelName = computed(() => appStore.connection.currentChannel || '聊天');
const isConnected = computed(() => appStore.connection.isConnected);

// ─── @ 提醒与已读状态 ─────────────────────────────────────────────────────────
function isMentionedMessage(msg) {
  return !!msg && !msg.isSelf && isMessageMentioningSelf(msg);
}

function markVisibleChannelRead() {
  const current = chatStore.currentChannelId || appStore.connection.currentChannel;
  if (!current) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  markChannelRead(current);
  updateTitleFlash();
}

function stopTitleFlash() {
  if (titleFlashTimer) {
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
  }
  titleFlashOn = false;
  if (typeof document !== 'undefined' && document.title !== baseDocumentTitle) {
    document.title = baseDocumentTitle;
  }
}

function updateTitleFlash() {
  if (typeof document === 'undefined') return;
  const mentionCount = getTotalMentionCount();
  const shouldFlash = mentionCount > 0 && (document.hidden || !document.hasFocus?.());

  if (!shouldFlash) {
    if (mentionCount <= 0 || !document.hidden) stopTitleFlash();
    return;
  }

  if (titleFlashTimer) return;
  titleFlashTimer = setInterval(() => {
    titleFlashOn = !titleFlashOn;
    document.title = titleFlashOn ? `有人 @ 你 · ${baseDocumentTitle}` : baseDocumentTitle;
  }, 1200);
}

function handleWindowFocus() {
  markVisibleChannelRead();
}

function handleVisibilityChange() {
  if (!document.hidden) {
    markVisibleChannelRead();
  } else {
    updateTitleFlash();
  }
}

// ─── @ 提及候选与标准化 ────────────────────────────────────────────────────────
function cleanMentionText(value) {
  return String(value || '').trim();
}

function cleanMentionDisplayName(value, fallback = '') {
  return cleanMentionText(value || fallback).replace(/[<>\n\r]/g, '').slice(0, 40);
}

function makeMentionId(candidate) {
  return cleanMentionText(candidate?.userId || candidate?.identity || candidate?.connectionId || candidate?.id || candidate?.displayName);
}

function isGeneratedIdentityText(value) {
  const text = cleanMentionText(value);
  if (!text) return false;
  return /^(u|conn|pa|rm)_[a-z0-9_\-]{8,}$/i.test(text) || /^[a-f0-9]{24,}$/i.test(text);
}

function getCandidateStrongKeys(candidate = {}) {
  return [
    candidate.id,
    candidate.userId,
    candidate.senderUserId,
    candidate.senderId,
    candidate.identity,
    candidate.senderIdentity,
    candidate.connectionId,
  ].map(cleanMentionText).filter(Boolean);
}

function findPresenceProfile(raw = {}) {
  const keys = new Set(getCandidateStrongKeys(raw));
  if (keys.size === 0) return null;

  for (const [key, participant] of Object.entries(presenceStore.participants || {})) {
    if (!participant) continue;
    const participantKeys = new Set([key, ...getCandidateStrongKeys(participant)]);
    for (const candidateKey of keys) {
      if (participantKeys.has(candidateKey)) return participant;
    }
  }

  return null;
}

function pickReadableMentionName(raw = {}, profile = null, fallback = '') {
  const candidates = [
    raw.displayName,
    raw.senderName,
    raw.name,
    profile?.displayName,
    fallback,
  ].map(cleanMentionText).filter(Boolean);

  const readable = candidates.find((value) => !isGeneratedIdentityText(value));
  if (readable) return cleanMentionDisplayName(readable);

  const id = cleanMentionText(raw.userId || raw.senderUserId || raw.senderId || raw.identity || raw.senderIdentity || raw.id || profile?.userId || profile?.identity || fallback);
  if (!id) return '';
  return cleanMentionDisplayName(`用户 ${id.slice(0, 8)}`);
}

function addMentionCandidate(list, raw = {}, extra = {}) {
  if (!raw) return;
  const profile = findPresenceProfile(raw);
  const id = cleanMentionText(
    raw.userId || raw.senderUserId || raw.senderId || profile?.userId || raw.identity || raw.senderIdentity || profile?.identity || raw.connectionId || raw.id
  );
  const displayName = pickReadableMentionName(raw, profile, extra.displayName || id);
  if (!displayName || !id) return;

  const candidate = {
    id,
    userId: cleanMentionText(raw.userId || raw.senderUserId || raw.senderId || profile?.userId || id),
    identity: cleanMentionText(raw.identity || raw.senderIdentity || profile?.identity || raw.senderId || raw.userId || id),
    connectionId: cleanMentionText(raw.connectionId || profile?.connectionId || ''),
    displayName,
    avatarColor: raw.avatarColor || raw.senderColor || profile?.avatarColor || '#5865f2',
    avatarPreset: raw.avatarPreset || raw.senderPreset || profile?.avatarPreset || '',
    avatarUrl: raw.avatarUrl ?? raw.senderAvatarUrl ?? profile?.avatarUrl ?? null,
    isSelf: !!extra.isSelf,
    source: extra.source || 'presence',
  };

  const keys = new Set(getCandidateStrongKeys(candidate));
  let index = -1;
  if (keys.size > 0) {
    index = list.findIndex((item) => getCandidateStrongKeys(item).some((key) => keys.has(key)));
  }
  if (index < 0) {
    index = list.findIndex((item) => cleanMentionText(item.displayName) === cleanMentionText(candidate.displayName));
  }

  if (index >= 0) {
    const prev = list[index];
    const nextDisplayName = isGeneratedIdentityText(candidate.displayName) && prev.displayName
      ? prev.displayName
      : candidate.displayName;
    list[index] = {
      ...prev,
      ...candidate,
      displayName: nextDisplayName,
      isSelf: prev.isSelf || candidate.isSelf,
      source: prev.source === 'self' ? 'self' : candidate.source,
    };
  } else {
    list.push(candidate);
  }
}

function getCurrentPresenceChannel(currentChannel) {
  return (presenceStore.channels || []).find((channel) => {
    const id = cleanMentionText(channel.id || channel.name);
    const name = cleanMentionText(channel.name || channel.id);
    return id === currentChannel || name === currentChannel;
  });
}

function addLiveKitMentionCandidates(list, currentChannel) {
  if (typeof window === 'undefined' || typeof window.getLiveKitRoom !== 'function') return;
  const room = window.getLiveKitRoom();
  if (!room) return;
  const roomName = cleanMentionText(room.name || room.roomName || '');
  if (currentChannel && roomName && roomName !== currentChannel) return;

  const localParticipant = room.localParticipant;
  if (localParticipant) {
    addMentionCandidate(list, {
      userId: localParticipant.identity,
      identity: localParticipant.identity,
      displayName: localParticipant.name || localParticipant.identity,
    }, { source: 'livekit', isSelf: localParticipant.identity === profileStore.userId });
  }

  room.remoteParticipants?.forEach?.((participant) => {
    addMentionCandidate(list, {
      userId: participant.identity,
      identity: participant.identity,
      displayName: participant.name || participant.identity,
    }, { source: 'livekit' });
  });
}

// @ 菜单只显示“当前频道里可见的人”：当前用户 + Presence 当前频道成员 + LiveKit 当前房间成员。
// 不再把 presenceStore.participants 全量在线用户和历史聊天发送者混入菜单，避免出现不在频道的测试账号。
const mentionUsers = computed(() => {
  const list = [];
  const currentChannel = cleanMentionText(chatStore.currentChannelId || appStore.connection.currentChannel || channelName.value);

  addMentionCandidate(list, {
    userId: profileStore.userId,
    identity: presenceStore.identity || profileStore.userId,
    connectionId: presenceStore.connectionId,
    displayName: profileStore.displayName || localStorage.getItem('lk_username') || '我',
    avatarColor: profileStore.avatarColor,
    avatarPreset: profileStore.avatarPreset,
    avatarUrl: profileStore.avatarUrl,
  }, { isSelf: true, source: 'self' });

  const currentPresenceChannel = getCurrentPresenceChannel(currentChannel);
  (currentPresenceChannel?.members || []).forEach((member) => {
    addMentionCandidate(list, member, { source: 'channel' });
  });

  addLiveKitMentionCandidates(list, currentChannel);

  const sourceRank = { self: 0, channel: 1, livekit: 2, presence_profile: 3, history: 4 };
  return list.sort((a, b) => {
    const selfRank = Number(b.isSelf) - Number(a.isSelf);
    if (selfRank !== 0) return selfRank;
    const rank = (sourceRank[a.source] ?? 9) - (sourceRank[b.source] ?? 9);
    if (rank !== 0) return rank;
    return a.displayName.localeCompare(b.displayName, 'zh-Hans-CN');
  });
});

// 渲染历史消息时可以使用更宽的 userId→displayName 映射，但这个列表不参与 @ 菜单。
const mentionRenderUsers = computed(() => {
  const list = [];
  mentionUsers.value.forEach((user) => addMentionCandidate(list, user, { source: user.source, isSelf: user.isSelf }));

  Object.values(presenceStore.participants || {}).forEach((participant) => {
    addMentionCandidate(list, participant, { source: 'presence_profile' });
  });

  (chatStore.messages || []).forEach((msg) => {
    addMentionCandidate(list, msg, { source: 'history', isSelf: !!msg.isSelf });
  });

  Object.values(chatStore._cache || {}).forEach((messagesInChannel) => {
    (messagesInChannel || []).forEach((msg) => addMentionCandidate(list, msg, { source: 'history', isSelf: !!msg.isSelf }));
  });

  return list;
});

const mentionNames = computed(() => {
  return Array.from(new Set(mentionRenderUsers.value.map((user) => user.displayName).filter(Boolean)));
});

function mentionMatchesQuery(candidate, query) {
  const q = cleanMentionText(query).toLowerCase();
  if (!q) return true;
  return [candidate.displayName, candidate.userId, candidate.identity]
    .map((value) => cleanMentionText(value).toLowerCase())
    .some((value) => value.includes(q));
}

const filteredMentionCandidates = computed(() => {
  if (mentionQuery.value === null) return [];
  return mentionUsers.value
    .filter((candidate) => mentionMatchesQuery(candidate, mentionQuery.value))
    .slice(0, 8);
});

const mentionMenuCandidates = computed(() => {
  if (mentionQuery.value === null) return [];
  if (filteredMentionCandidates.value.length > 0) return filteredMentionCandidates.value;

  // 兜底只回退到当前频道候选，避免把历史用户/不在频道的测试账号显示出来。
  return mentionUsers.value.slice(0, 8);
});

const showMentionMenu = computed(() => mentionQuery.value !== null);

function closeMentionPicker() {
  mentionQuery.value = null;
  mentionActiveIndex.value = 0;
  mentionRange = null;
}

function getMentionTriggerAtCursor(valueOverride = null, selectionStartOverride = null) {
  const el = textareaEl.value;
  const text = valueOverride !== null && valueOverride !== undefined
    ? String(valueOverride)
    : inputText.value;
  const pos = Number.isFinite(selectionStartOverride)
    ? selectionStartOverride
    : (el?.selectionStart ?? text.length);
  const before = text.slice(0, pos);
  const match = before.match(/(^|[\s([{（])@([^\s@<>\n\r]*)$/u);
  if (!match) return null;

  const prefix = match[1] || '';
  const query = match[2] || '';
  const start = before.length - query.length - 1;
  if (start > 0 && prefix === '') return null;

  return { start, end: pos, query };
}

function updateMentionState(eventOrOptions = null) {
  let valueOverride = null;
  let selectionStartOverride = null;

  if (eventOrOptions?.target) {
    valueOverride = eventOrOptions.target.value;
    selectionStartOverride = eventOrOptions.target.selectionStart;
    // 某些环境下自定义 @input 回调会早于 v-model 更新；这里主动同步，避免第一次输入 @ 时读到旧值。
    inputText.value = valueOverride;
  } else if (eventOrOptions && typeof eventOrOptions === 'object') {
    if ('value' in eventOrOptions) valueOverride = eventOrOptions.value;
    if ('selectionStart' in eventOrOptions) selectionStartOverride = eventOrOptions.selectionStart;
  }

  const trigger = getMentionTriggerAtCursor(valueOverride, selectionStartOverride);
  if (!trigger) {
    closeMentionPicker();
    return;
  }

  mentionRange = trigger;
  mentionQuery.value = trigger.query;
  if (mentionActiveIndex.value >= mentionMenuCandidates.value.length) {
    mentionActiveIndex.value = 0;
  }
}

function insertMentionCandidate(candidate) {
  if (!candidate) return;
  const el = textareaEl.value;
  const range = mentionRange || getMentionTriggerAtCursor();
  if (!el || !range) return;

  const displayName = cleanMentionDisplayName(candidate.displayName, candidate.id);
  if (!displayName) return;

  const before = inputText.value.slice(0, range.start);
  const after = inputText.value.slice(range.end);
  const spacer = after.startsWith(' ') || after.length === 0 ? '' : ' ';
  const mentionText = `@${displayName}${spacer}`;
  inputText.value = before + mentionText + after;

  const mentionId = makeMentionId(candidate);
  if (mentionId) selectedMentionMap.set(displayName, mentionId);

  const caret = before.length + mentionText.length;
  closeMentionPicker();
  nextTick(() => {
    resizeComposer(el);
    el.focus();
    el.setSelectionRange(caret, caret);
  });
}

function insertMentionText(candidateLike, source = 'external') {
  if (!candidateLike) return;

  const normalized = [];
  addMentionCandidate(normalized, candidateLike, { source });
  const candidate = normalized[0] || candidateLike;
  const displayName = cleanMentionDisplayName(candidate.displayName || candidate.name || candidate.senderName, candidate.id || candidate.userId || candidate.identity);
  const mentionId = makeMentionId(candidate);
  if (!displayName || !mentionId) return;

  const el = textareaEl.value;
  const start = el?.selectionStart ?? inputText.value.length;
  const end = el?.selectionEnd ?? inputText.value.length;
  const before = inputText.value.slice(0, start);
  const after = inputText.value.slice(end);
  const lead = before.length > 0 && !/[\s([{（]$/.test(before) ? ' ' : '';
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : ' ';
  const mentionText = `${lead}@${displayName}${trail}`;

  inputText.value = before + mentionText + after;
  selectedMentionMap.set(displayName, mentionId);
  closeMentionPicker();

  const caret = before.length + mentionText.length;
  nextTick(() => {
    resizeComposer(el || textareaEl.value);
    textareaEl.value?.focus?.();
    textareaEl.value?.setSelectionRange?.(caret, caret);
  });
}

function insertMentionFromMessage(msg) {
  if (!msg) return;
  insertMentionText({
    userId: msg.senderUserId || msg.senderId,
    identity: msg.senderIdentity || msg.senderId,
    displayName: msg.senderName,
    avatarColor: msg.senderColor,
    avatarPreset: msg.senderPreset,
    avatarUrl: msg.senderAvatarUrl,
  }, 'message');
}

function handleExternalMentionInsert(event) {
  insertMentionText(event?.detail || {}, 'external');
}


function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMentionsForSending(rawText) {
  let text = String(rawText || '');
  const candidates = [...mentionUsers.value];

  for (const [displayName, id] of selectedMentionMap.entries()) {
    addMentionCandidate(candidates, { displayName, userId: id, identity: id }, { source: 'selected' });
  }

  const unique = [];
  candidates.forEach((candidate) => addMentionCandidate(unique, candidate, { isSelf: candidate.isSelf, source: candidate.source }));

  unique
    .filter((candidate) => makeMentionId(candidate) && candidate.displayName)
    .sort((a, b) => b.displayName.length - a.displayName.length)
    .forEach((candidate) => {
      const displayName = cleanMentionDisplayName(candidate.displayName);
      const id = makeMentionId(candidate);
      if (!displayName || !id) return;
      const pattern = new RegExp(`(^|[\\s([{（])@${escapeRegExp(displayName)}(?=$|[\\s.,;:!?，。！？、)\\]}）])`, 'g');
      text = text.replace(pattern, `$1<@${id}>`);
    });

  return text;
}

// ─── 发送消息 ─────────────────────────────────────────────────────────────────
async function handleSend() {
  const text = normalizeMentionsForSending(inputText.value.trim());
  const imagesToSend = [...pendingImages.value];
  if (!text && imagesToSend.length === 0) return;
  if (!isConnected.value || isUploadingImage.value) return;

  if (text) {
    emit('send', text);
    inputText.value = '';
    selectedMentionMap.clear();
    closeMentionPicker();
  }

  if (imagesToSend.length > 0) {
    clearPendingImages();
    for (const item of imagesToSend) {
      const ok = await uploadAndSendImage(item.file, 'pending');
      if (!ok) {
        // 失败时把未发送成功的图片放回预览区，避免用户需要重新截图/复制。
        addPendingImages(imagesToSend.slice(imagesToSend.indexOf(item)).map((entry) => entry.file));
        break;
      }
    }
  }

  nextTick(() => {
    resizeComposer();
    scrollToBottom(true);
  });
}


function openImagePicker() {
  if (!isConnected.value || isUploadingImage.value) return;
  imageInputEl.value?.click?.();
}

function isSupportedChatImage(file) {
  return !!file && file.type?.startsWith('image/');
}

function ensureClipboardImageName(file, index = 0) {
  if (!file) return file;
  if (file.name) return file;

  const ext = file.type === 'image/gif'
    ? 'gif'
    : file.type === 'image/webp'
      ? 'webp'
      : file.type === 'image/jpeg'
        ? 'jpg'
        : 'png';

  return new File([file], `clipboard-${Date.now()}-${index}.${ext}`, { type: file.type || 'image/png' });
}

function makePendingImageId() {
  if (window.crypto?.randomUUID) return `img_${window.crypto.randomUUID()}`;
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function addPendingImages(files = []) {
  const nextItems = [];

  files.forEach((file, index) => {
    if (!isSupportedChatImage(file)) return;
    if (file.size > 20 * 1024 * 1024) {
      alert(`图片 ${file.name || index + 1} 超过 20MB，已跳过`);
      return;
    }

    nextItems.push({
      id: makePendingImageId(),
      file,
      name: file.name || `clipboard-${index + 1}`,
      previewUrl: URL.createObjectURL(file),
    });
  });

  if (nextItems.length === 0) return false;
  pendingImages.value = [...pendingImages.value, ...nextItems];
  nextTick(() => {
    resizeComposer();
    textareaEl.value?.focus?.();
  });
  return true;
}

function removePendingImage(id) {
  const item = pendingImages.value.find((entry) => entry.id === id);
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
  pendingImages.value = pendingImages.value.filter((entry) => entry.id !== id);
}

function clearPendingImages() {
  pendingImages.value.forEach((entry) => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  });
  pendingImages.value = [];
}

async function uploadAndSendImage(file, source = 'picker') {
  if (!isConnected.value) {
    alert('未连接频道，无法发送图片');
    return false;
  }

  if (!isSupportedChatImage(file)) {
    alert('请选择图片文件');
    return false;
  }

  if (file.size > 20 * 1024 * 1024) {
    alert('聊天图片不能超过 20MB');
    return false;
  }

  const channelId = chatStore.currentChannelId || appStore.connection.currentChannel || 'lobby';
  isUploadingImage.value = true;
  try {
    const res = await uploadChatImage(file, {
      channelId,
      userId: profileStore.userId,
    });
    const imageUrl = res?.imageUrl || res?.url;
    if (!imageUrl) throw new Error('服务器没有返回图片地址');
    emit('send', `![图片](${imageUrl})`);
    nextTick(() => scrollToBottom(true));
    return true;
  } catch (error) {
    console.error(`[ChatPanel] 上传聊天图片失败 source=${source}`, error);
    alert(`上传图片失败：${error?.message || error}`);
    return false;
  } finally {
    isUploadingImage.value = false;
  }
}

function handleImageSelected(event) {
  const files = Array.from(event.target?.files || []);
  if (event.target) event.target.value = '';
  if (files.length === 0) return;
  addPendingImages(files.map((file, index) => ensureClipboardImageName(file, index)));
}

async function handlePaste(event) {
  if (!event?.clipboardData || isUploadingImage.value) return;

  const imageFiles = [];
  const items = Array.from(event.clipboardData.items || []);
  items.forEach((item, index) => {
    if (item.kind !== 'file' || !item.type?.startsWith('image/')) return;
    const file = item.getAsFile?.();
    if (file) imageFiles.push(ensureClipboardImageName(file, index));
  });

  // 兼容部分环境：clipboardData.files 里有图片，但 items 里没有。
  if (imageFiles.length === 0) {
    Array.from(event.clipboardData.files || []).forEach((file, index) => {
      if (isSupportedChatImage(file)) imageFiles.push(ensureClipboardImageName(file, index));
    });
  }

  if (imageFiles.length === 0) return;

  event.preventDefault();
  addPendingImages(imageFiles);
}

function onMessageContentClick(event) {
  const target = event.target?.closest?.('[data-image-src]');
  const src = target?.dataset?.imageSrc;
  if (src) previewImageUrl.value = src;
}

function handleKeydown(e) {
  if (showMentionMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value + 1) % Math.max(mentionMenuCandidates.value.length, 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionActiveIndex.value = (mentionActiveIndex.value - 1 + Math.max(mentionMenuCandidates.value.length, 1)) % Math.max(mentionMenuCandidates.value.length, 1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertMentionCandidate(mentionMenuCandidates.value[mentionActiveIndex.value]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionPicker();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
    return;
  }

  // 富文本快捷键
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;

  if (e.key === 'b' || e.key === 'B') { e.preventDefault(); applyFormatting('**'); }
  else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); applyFormatting('*'); }
  else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); applyFormatting('`'); }
  else if (e.key === 'x' || e.key === 'X') {
    if (e.shiftKey) { e.preventDefault(); applyFormatting('~~'); }
  }
  else if (e.key === 's' || e.key === 'S') {
    if (e.shiftKey) { e.preventDefault(); applyFormatting('||'); }
  }
}

// ─── 富文本格式化 ──────────────────────────────────────────────────────────────
const FORMAT_BUTTONS = [
  { label: 'B', title: '粗体 (Ctrl+B)', markup: '**', activeClass: 'font-bold' },
  { label: 'I', title: '斜体 (Ctrl+I)', markup: '*', activeClass: 'italic' },
  { label: '`', title: '行内代码 (Ctrl+E)', markup: '`', activeClass: 'font-mono' },
  { label: 'S', title: '删除线 (Ctrl+Shift+X)', markup: '~~' },
  { label: '▌', title: '剧透/Ctrl+Shift+S', markup: '||' },
];

function applyFormatting(markup) {
  const el = textareaEl.value;
  if (!el) return;

  const start = el.selectionStart;
  const end = el.selectionEnd;
  const text = inputText.value;
  const selected = text.slice(start, end);

  if (selected.length > 0) {
    inputText.value = text.slice(0, start) + markup + selected + markup + text.slice(end);
    nextTick(() => {
      resizeComposer(el);
      el.focus();
      el.setSelectionRange(start + markup.length, end + markup.length);
    });
  } else {
    const placeholder = markup === '**' ? '粗体' : markup === '*' ? '斜体' : markup === '`' ? '代码' : markup === '~~' ? '删除线' : '剧透';
    inputText.value = text.slice(0, start) + markup + placeholder + markup + text.slice(end);
    nextTick(() => {
      resizeComposer(el);
      el.focus();
      const newStart = start + markup.length;
      const newEnd = newStart + placeholder.length;
      el.setSelectionRange(newStart, newEnd);
    });
  }
}

function resizeComposer(el = textareaEl.value) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(44, el.scrollHeight) + 'px';
}

function autoResize(e) {
  resizeComposer(e.target);
}

function refreshMentionStateFromTextarea() {
  const el = textareaEl.value;
  if (!el) return;
  updateMentionState({
    value: el.value,
    selectionStart: el.selectionStart,
  });
}

function handleComposerInput(e) {
  if (e?.target) inputText.value = e.target.value;
  autoResize(e);
  updateMentionState(e);
  // 再补一轮微任务读取真实 textarea 值，兼容输入法/浏览器事件顺序差异。
  queueMicrotask(refreshMentionStateFromTextarea);
}

function handleComposerCaretMove(e) {
  updateMentionState(e);
  queueMicrotask(refreshMentionStateFromTextarea);
}

// ─── Emoji 插入 ───────────────────────────────────────────────────────────────
function insertEmoji(emojiChar) {
  const el = textareaEl.value;
  if (!el) {
    inputText.value += emojiChar;
    return;
  }
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const before = inputText.value.slice(0, start);
  const after = inputText.value.slice(end);
  inputText.value = before + emojiChar + after;
  nextTick(() => {
    resizeComposer(el);
    el.setSelectionRange(start + emojiChar.length, start + emojiChar.length);
    el.focus();
  });
  showEmojiPicker.value = false;
}

// ─── Reaction ────────────────────────────────────────────────────────────────
function handleReaction(msgId, emoji) {
  const myId = profileStore.userId;
  toggleReaction(msgId, emoji, myId);

  // 同步到服务器（服务器负责广播给其他在线客户端）
  silentSyncReaction({
    messageId: msgId,
    emoji,
    senderId: myId,
    channelId: chatStore.currentChannelId || '',
  });

  closeReactionPicker();
}

function reactionCount(reactions, emoji) {
  return (reactions?.[emoji] || []).length;
}

function isMineReaction(reactions, emoji) {
  return (reactions?.[emoji] || []).includes(profileStore.userId);
}


function visibleReactions(reactions) {
  const result = {};
  for (const [emoji, users] of Object.entries(reactions || {})) {
    // 旧版本里可能存过 📌，新 UI 不再显示/发送大头针。
    if (emoji === '📌') continue;
    if (Array.isArray(users) && users.length > 0) result[emoji] = users;
  }
  return result;
}

function hasVisibleReactions(reactions) {
  return Object.keys(visibleReactions(reactions)).length > 0;
}

function addDisplayNameToMap(map, keys, name) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return;
  keys.forEach((key) => {
    const cleanKey = String(key || '').trim();
    if (cleanKey && !map.has(cleanKey)) map.set(cleanKey, cleanName);
  });
}

const reactionDisplayNameMap = computed(() => {
  const map = new Map();

  const selfName = profileStore.displayName || localStorage.getItem('lk_username') || '我';
  addDisplayNameToMap(map, [profileStore.userId, presenceStore.userId, presenceStore.identity, presenceStore.connectionId], selfName);

  Object.values(presenceStore.participants || {}).forEach((participant) => {
    addDisplayNameToMap(map, [participant.identity, participant.userId, participant.connectionId], participant.displayName);
  });

  (presenceStore.channels || []).forEach((channel) => {
    (channel.members || []).forEach((member) => {
      addDisplayNameToMap(map, [member.identity, member.userId, member.connectionId], member.displayName);
    });
  });

  Object.values(chatStore._cache || {}).forEach((list) => {
    (list || []).forEach((msg) => {
      addDisplayNameToMap(map, [msg.senderId, msg.senderUserId, msg.senderIdentity], msg.senderName);
    });
  });

  (chatStore.messages || []).forEach((msg) => {
    addDisplayNameToMap(map, [msg.senderId, msg.senderUserId, msg.senderIdentity], msg.senderName);
  });

  return map;
});

function isSelfReactionUser(userId) {
  const id = String(userId || '').trim();
  if (!id) return false;
  return [profileStore.userId, presenceStore.userId, presenceStore.identity, presenceStore.connectionId]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .includes(id);
}

function shortUserId(userId) {
  const id = String(userId || '').trim();
  if (!id) return '';
  if (id.length <= 10) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function resolveReactionDisplayName(userId) {
  const id = String(userId || '').trim();
  if (!id) return '未知用户';

  if (isSelfReactionUser(id)) {
    const selfName = profileStore.displayName || localStorage.getItem('lk_username') || '';
    return selfName ? `${selfName}（我）` : '我';
  }

  const name = reactionDisplayNameMap.value.get(id);
  if (name) return name;

  return `未知用户 ${shortUserId(id)}`;
}

function reactionTitle(users, emoji) {
  const names = Array.from(new Set((users || []).map(resolveReactionDisplayName)));
  if (names.length === 0) return `回应了 ${emoji}`;
  if (names.length <= 4) return `${names.join('、')} 回应了 ${emoji}`;
  return `${names.slice(0, 4).join('、')} 等 ${names.length} 人回应了 ${emoji}`;
}

// ─── 富文本渲染 ───────────────────────────────────────────────────────────────
function renderContent(content) {
  return renderMessageContent(content, {
    names: mentionNames.value,
    users: mentionRenderUsers.value,
    selfUserIds: [profileStore.userId, presenceStore.userId, presenceStore.identity, presenceStore.connectionId],
  });
}

// ─── 时间格式化 ───────────────────────────────────────────────────────────────
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const hhmm = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  if (isToday) return hhmm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

function formatFullTime(ts) {
  return new Date(ts).toLocaleString('zh-CN');
}
</script>

<template>
  <aside class="chat-panel-vue flex flex-col h-full bg-[#1e1f22] border-l border-white/5">
    <!-- 顶部标题栏 -->
    <header class="flex items-center gap-2 px-4 py-3 border-b border-white/5 shrink-0">
      <span class="text-[#959ba4] text-lg">💬</span>
      <div class="flex-1 min-w-0">
        <div class="text-[#f2f3f5] font-semibold text-sm leading-none truncate">{{ channelName }}</div>
        <div class="text-[#6d6f78] text-xs mt-0.5">频道内可见</div>
      </div>
    </header>

    <!-- 消息列表 -->
    <div
      ref="messagesEl"
      class="flex-1 overflow-y-auto px-2 py-4 space-y-0.5 custom-scroll"
      @scroll="checkScrollPos"
    >
      <!-- 空状态 -->
      <div v-if="groupedMessages.length === 0" class="flex flex-col items-center justify-center h-full gap-3 pb-8">
        <div class="w-16 h-16 rounded-full bg-[#2b2d31] flex items-center justify-center text-3xl">💬</div>
        <div class="text-[#f2f3f5] font-semibold text-base">欢迎来到 {{ channelName }}</div>
        <div class="text-[#6d6f78] text-sm text-center max-w-[200px]">这是频道的开始，发送第一条消息吧！</div>
      </div>

      <!-- 消息气泡 -->
      <div
        v-for="(msg, idx) in groupedMessages"
        :key="msg.id"
        class="msg-row group relative flex items-start gap-3 px-2 py-0.5 rounded hover:bg-white/[0.04] transition-colors duration-100"
        :class="{ 'mt-4': !msg.isGrouped, 'mt-0.5': msg.isGrouped, 'msg-row-mentioned': isMentionedMessage(msg) }"
        @mouseenter="onMsgMouseenter(msg.id)"
        @mouseleave="onMsgMouseleave"
        @contextmenu.prevent="openMessageContextMenu(msg.id)"
      >
        <!-- 头像列（非折叠时显示，折叠时占位） -->
        <div class="w-12 shrink-0 flex justify-center pt-0.5">
          <BaseAvatar
            v-if="!msg.isGrouped"
            class="cursor-pointer"
            :name="msg.senderName"
            :color="msg.senderColor"
            :preset="msg.senderPreset"
            :avatar-url="msg.senderAvatarUrl"
            size="md"
            title="右键 @ 这个成员"
            @contextmenu.stop.prevent="insertMentionFromMessage(msg)"
          />
          <!-- 折叠时显示时间（hover 才显示） -->
          <span
            v-else
            class="text-[10px] text-[#4e5058] leading-none mt-1 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
            :title="formatFullTime(msg.timestamp)"
          >{{ formatTime(msg.timestamp) }}</span>
        </div>

        <!-- 消息内容 -->
        <div class="flex-1 min-w-0 max-w-full">
          <!-- 发送者昵称 + 时间（非折叠时显示） -->
          <div v-if="!msg.isGrouped" class="flex items-baseline gap-2 mb-1">
            <span
              class="font-semibold text-sm leading-none cursor-pointer"
              :class="msg.isSelf ? 'text-[#5865f2]' : 'text-[#f2f3f5]'"
              :style="!msg.isSelf && msg.senderColor ? { color: msg.senderColor } : {}"
              title="右键 @ 这个成员"
              @contextmenu.stop.prevent="insertMentionFromMessage(msg)"
            >{{ msg.senderName }}</span>
            <span v-if="msg.isSelf" class="text-[10px] text-[#5865f2] bg-[#5865f2]/10 px-1 rounded leading-none py-0.5">我</span>
            <span class="text-[11px] text-[#4e5058]" :title="formatFullTime(msg.timestamp)">{{ formatTime(msg.timestamp) }}</span>
          </div>

          <!-- 正文（v-html 富文本渲染） -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            class="block w-full max-w-full text-[#dcddde] text-sm leading-relaxed whitespace-pre-wrap break-words msg-content"
            v-html="renderContent(msg.content)"
            @click="onMessageContentClick"
          />

          <!-- Reactions：只显示普通表情回应；旧版 📌 会被过滤 -->
          <div v-if="hasVisibleReactions(msg.reactions)" class="flex flex-wrap gap-1 mt-1.5">
            <button
              v-for="(users, emoji) in visibleReactions(msg.reactions)"
              :key="emoji"
              class="reaction-btn flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-all duration-150"
              :class="isMineReaction(msg.reactions, emoji)
                ? 'bg-[#5865f2]/20 border-[#5865f2]/60 text-[#5865f2]'
                : 'bg-white/5 border-white/10 text-[#b5bac1] hover:bg-white/10 hover:border-white/20'"
              :title="reactionTitle(users, emoji)"
              @click="handleReaction(msg.id, emoji)"
            >
              <span>{{ emoji }}</span>
              <span class="font-medium">{{ users.length }}</span>
            </button>
          </div>
        </div>

        <!-- 右键消息会直接打开 Reaction 选择器；不再显示 hover 操作栏和 Pin 菜单。 -->

        <!-- Reaction 选择器（气泡） -->
        <div
          v-if="reactionPickerMsgId === msg.id"
          :class="['reaction-picker absolute right-2 z-50 bg-[#2b2d31] border border-white/10 rounded-xl p-2 shadow-2xl w-64', idx < 3 ? 'top-full mt-1' : 'bottom-full mb-1']"
        >
          <div class="text-[10px] text-[#6d6f78] mb-1.5 px-1">选择回应</div>
          <div class="grid grid-cols-8 gap-0.5">
            <button
              v-for="qr in QUICK_REACTIONS"
              :key="qr.name"
              class="w-8 h-8 flex items-center justify-center text-lg rounded hover:bg-white/10 transition-colors"
              :title="`:${qr.name}:`"
              @click.stop="handleReaction(msg.id, qr.char)"
            >{{ qr.char }}</button>
          </div>
          <div class="border-t border-white/10 mt-2 pt-2">
            <div class="grid grid-cols-8 gap-0.5 max-h-32 overflow-y-auto custom-scroll">
              <button
                v-for="e in EMOJI_LIST.slice(0, 64)"
                :key="e.name"
                class="w-8 h-8 flex items-center justify-center text-base rounded hover:bg-white/10 transition-colors"
                :title="e.label"
                @click.stop="handleReaction(msg.id, e.char)"
              >{{ e.char }}</button>
            </div>
          </div>
          <button
            class="mt-2 w-full text-[11px] text-[#6d6f78] hover:text-[#b5bac1] transition-colors text-center"
            @click.stop="closeReactionPicker"
          >关闭</button>
        </div>
      </div>

      <!-- 新消息提示按钮 -->
      <button
        v-if="!isAtBottom && messages.length > 0"
        class="sticky bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-[#5865f2] text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg hover:bg-[#4752c4] transition-colors z-10"
        @click="jumpToLatestMessage"
      >
        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
        {{ unreadNewMessages > 0 ? `有 ${unreadNewMessages} 条未读消息` : '跳到最新' }}
      </button>
    </div>

    <!-- 输入区 -->
    <div class="px-3 pb-3 pt-2 shrink-0">
      <div class="relative flex flex-col bg-[#383a40] rounded-xl border border-white/5 focus-within:border-[#5865f2]/50 transition-colors overflow-visible">
        <div
          v-if="showMentionMenu"
          class="mention-picker absolute left-2 right-2 bottom-full mb-2 bg-[#2b2d31] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden"
          @mousedown.prevent
        >
          <div class="px-3 py-2 text-[11px] font-semibold text-[#949ba4] border-b border-white/5">选择要 @ 的成员</div>
          <div
            v-if="mentionMenuCandidates.length === 0"
            class="px-3 py-3 text-xs text-[#6d6f78]"
          >当前没有可提及成员</div>
          <button
            v-for="(candidate, index) in mentionMenuCandidates"
            :key="candidate.id + '-' + candidate.displayName"
            type="button"
            class="mention-candidate w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
            :class="index === mentionActiveIndex ? 'bg-[#5865f2]/20 text-white' : 'text-[#dbdee1] hover:bg-white/5'"
            @mouseenter="mentionActiveIndex = index"
            @click.stop="insertMentionCandidate(candidate)"
          >
            <BaseAvatar
              :name="candidate.displayName"
              :color="candidate.avatarColor"
              :preset="candidate.avatarPreset"
              :avatar-url="candidate.avatarUrl"
              size="sm"
            />
            <div class="min-w-0 flex-1">
              <div class="text-sm font-semibold truncate">@{{ candidate.displayName }} <span v-if="candidate.isSelf" class="text-[10px] text-[#949ba4] font-normal">我</span></div>
              <div class="text-[10px] text-[#6d6f78] truncate">{{ candidate.userId || candidate.identity }}</div>
            </div>
            <div class="text-[10px] text-[#6d6f78]">Enter</div>
          </button>
        </div>

        <div v-if="pendingImages.length > 0" class="pending-image-strip flex gap-2 px-3 pt-3 pb-1 overflow-x-auto custom-scroll">
          <div
            v-for="item in pendingImages"
            :key="item.id"
            class="pending-image-card relative w-16 h-16 rounded-lg overflow-hidden bg-black/20 border border-white/10 shrink-0"
            :title="item.name"
          >
            <img :src="item.previewUrl" alt="待发送图片" class="w-full h-full object-cover">
            <button
              class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-sm leading-none hover:bg-[#f23f42] transition-colors"
              title="移除图片"
              @click.stop="removePendingImage(item.id)"
            >×</button>
          </div>
        </div>

        <div class="flex items-end min-w-0">
        <!-- 输入框 -->
        <textarea
          ref="textareaEl"
          v-model="inputText"
          class="chat-composer-textarea flex-1 bg-transparent text-[#dcddde] text-sm placeholder-[#4e5058] px-4 py-3 resize-none leading-relaxed outline-none min-h-[44px]"
          :placeholder="isUploadingImage ? '图片上传中...' : (isConnected ? `发送消息到 #${channelName}...` : '未连接，无法发送消息')"
          :disabled="!isConnected"
          rows="1"
          @keydown="handleKeydown"
          @input="handleComposerInput"
          @click="handleComposerCaretMove"
          @focus="handleComposerCaretMove"
          @keyup="handleComposerCaretMove"
          @mouseup="handleComposerCaretMove"
          @select="handleComposerCaretMove"
          @compositionend="handleComposerInput"
          @paste="handlePaste"
        />

        <!-- 右侧工具栏 -->
        <div class="flex items-center gap-1 pr-2 pb-2 shrink-0">
          <input
            ref="imageInputEl"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            class="hidden"
            @change="handleImageSelected"
          >

          <!-- 图片按钮 -->
          <button
            class="w-8 h-8 flex items-center justify-center rounded transition-colors"
            :class="isConnected && !isUploadingImage
              ? 'text-[#b5bac1] hover:bg-white/10 hover:text-white'
              : 'text-[#4e5058] cursor-not-allowed'"
            :disabled="!isConnected || isUploadingImage"
            :title="isUploadingImage ? '图片上传中...' : '发送图片'"
            @click.stop="openImagePicker"
          >{{ isUploadingImage ? '…' : '🖼️' }}</button>

          <!-- Emoji 按钮 -->
          <button
            class="emoji-toggle-btn w-8 h-8 flex items-center justify-center text-[#b5bac1] rounded hover:bg-white/10 hover:text-white transition-colors text-lg"
            title="插入表情"
            @click.stop="showEmojiPicker = !showEmojiPicker"
          >😊</button>

          <!-- 发送按钮 -->
          <button
            class="w-8 h-8 flex items-center justify-center rounded transition-all duration-150"
            :class="(inputText.trim() || pendingImages.length > 0) && isConnected && !isUploadingImage
              ? 'bg-[#5865f2] text-white hover:bg-[#4752c4] shadow-[0_0_12px_rgba(88,101,242,0.4)]'
              : 'bg-white/5 text-[#4e5058] cursor-not-allowed'"
            :disabled="(!inputText.trim() && pendingImages.length === 0) || !isConnected || isUploadingImage"
            title="发送 (Enter)"
            @click="handleSend"
          >
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
        </div>
      </div>

      <!-- Emoji 选择器浮层 -->
      <div
        v-if="showEmojiPicker"
        class="emoji-picker absolute bottom-20 right-4 w-72 bg-[#2b2d31] border border-white/10 rounded-xl shadow-2xl z-50 p-3"
      >
        <input
          v-model="emojiSearch"
          class="w-full bg-[#1e1f22] text-[#dcddde] text-sm px-3 py-1.5 rounded-lg border border-white/10 outline-none placeholder-[#4e5058] mb-2"
          placeholder="搜索表情..."
          @click.stop
        >
        <div class="grid grid-cols-8 gap-0.5 max-h-48 overflow-y-auto custom-scroll">
          <button
            v-for="e in filteredEmoji"
            :key="e.name"
            class="w-8 h-8 flex items-center justify-center text-xl rounded hover:bg-white/10 transition-colors"
            :title="e.label"
            @click.stop="insertEmoji(e.char)"
          >{{ e.char }}</button>
        </div>
      </div>

      <!-- 富文本格式工具栏 -->
      <div class="flex items-center gap-0.5 mt-1.5 px-1">
        <button
          v-for="btn in FORMAT_BUTTONS"
          :key="btn.markup"
          :title="btn.title"
          class="w-7 h-7 flex items-center justify-center text-xs rounded transition-colors"
          :class="[btn.activeClass, 'text-[#6d6f78] hover:text-[#dbdee1] hover:bg-white/10']"
          @click="applyFormatting(btn.markup)"
        >{{ btn.label }}</button>
        <div class="flex-1"></div>
      </div>

      <div class="flex items-center justify-between mt-1 px-1">
        <span class="text-[10px] text-[#4e5058]">Enter 发送 · Shift+Enter 换行 · @ 提及成员 · Ctrl+V 添加图片预览</span>
        <span v-if="messages.length > 0" class="text-[10px] text-[#4e5058]">{{ messages.length }} 条消息</span>
      </div>
    </div>
    <!-- 图片预览浮层 -->
    <teleport to="body">
      <div
        v-if="previewImageUrl"
        class="chat-image-preview fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-6"
        @click.self="previewImageUrl = ''"
      >
        <button
          class="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/10 text-white text-2xl leading-none hover:bg-white/20 transition-colors"
          title="关闭"
          @click="previewImageUrl = ''"
        >×</button>
        <img
          :src="previewImageUrl"
          alt="聊天图片预览"
          class="max-w-[92vw] max-h-[88vh] object-contain rounded-lg shadow-2xl"
          @click.stop
        >
      </div>
    </teleport>

  </aside>
</template>

<style scoped>
.chat-composer-textarea {
  overflow-y: hidden;
  scrollbar-width: none;
}
.chat-composer-textarea::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.pending-image-strip {
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.14) transparent;
}
.pending-image-card img {
  display: block;
}


.mention-picker {
  max-height: 280px;
  overflow-y: auto;
}
.mention-candidate:first-of-type {
  margin-top: 2px;
}
.mention-candidate:last-of-type {
  margin-bottom: 2px;
}

/* 自定义滚动条 */
.custom-scroll::-webkit-scrollbar { width: 4px; }
.custom-scroll::-webkit-scrollbar-track { background: transparent; }
.custom-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
.custom-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

/* 富文本消息内容样式 */
.msg-row {
  min-width: 0;
}
.msg-row-mentioned {
  background: rgba(250, 166, 26, 0.08);
  box-shadow: inset 3px 0 0 rgba(250, 166, 26, 0.75);
}
.msg-row-mentioned:hover {
  background: rgba(250, 166, 26, 0.12);
}

:deep(.msg-content) {
  display: block;
  max-width: 100%;
  white-space: pre-wrap;
  word-break: normal;
  overflow-wrap: anywhere;
}
:deep(.msg-content strong) { color: #f2f3f5; font-weight: 700; }
:deep(.msg-content em) { font-style: italic; color: #f2f3f5; }
:deep(.msg-content del) { text-decoration: line-through; color: #6d6f78; }
:deep(.msg-content a.msg-link) {
  color: #00aff4;
  text-decoration: underline;
  text-underline-offset: 2px;
}
:deep(.msg-content a.msg-link:hover) { color: #00c0ff; }
:deep(.msg-content .msg-inline-code) {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.85em;
  background: rgba(30, 31, 34, 0.6);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 3px;
  padding: 0.1em 0.35em;
  color: #e3e5e8;
}
:deep(.msg-content .msg-code-block) {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.82em;
  background: #1e1f22;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  padding: 10px 14px;
  margin: 6px 0;
  overflow-x: auto;
  white-space: pre;
  color: #e3e5e8;
}
:deep(.msg-content .msg-emoji) {
  font-size: 1.2em;
  line-height: 1;
  display: inline-block;
}
:deep(.msg-content .msg-mention) {
  background: rgba(88, 101, 242, 0.2);
  color: #c9cdfb;
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
}
:deep(.msg-content .msg-mention:hover) { background: rgba(88, 101, 242, 0.35); }
:deep(.msg-content .msg-mention-self) {
  background: rgba(250, 166, 26, 0.22);
  color: #ffd37a;
  box-shadow: inset 0 0 0 1px rgba(250, 166, 26, 0.28);
}
:deep(.msg-content .msg-mention-weak) {
  color: #9da8ff;
}
:deep(.msg-content .msg-spoiler) {
  background: #1e1f22;
  color: transparent;
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
  user-select: none;
  transition: color 0.2s, background 0.2s;
}
:deep(.msg-content .msg-spoiler:hover) {
  background: rgba(255,255,255,0.08);
  color: #dcddde;
}


:deep(.msg-content .msg-image-wrap) {
  display: inline-block;
  max-width: min(320px, 100%);
  margin: 4px 0;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  cursor: zoom-in;
  overflow: hidden;
  vertical-align: top;
}
:deep(.msg-content .msg-image-wrap:hover) {
  filter: brightness(1.08);
}
:deep(.msg-content .msg-chat-image) {
  display: block;
  max-width: min(320px, 100%);
  max-height: 260px;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.18);
}
/* 头像图片样式 */
:deep(.base-avatar-img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}
</style>
