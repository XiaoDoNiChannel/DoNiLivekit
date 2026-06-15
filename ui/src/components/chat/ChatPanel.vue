<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import BaseAvatar from '../common/BaseAvatar.vue';
import { chatStore, shouldGroupWithPrev, toggleReaction } from '../../stores/chatStore.js';
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
  }
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeydown);
  nextTick(() => resizeComposer());
});
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onDocumentKeydown);
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

function checkScrollPos() {
  const el = messagesEl.value;
  if (!el) return;
  isAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollToBottom(force = false) {
  const el = messagesEl.value;
  if (!el) return;
  if (force || isAtBottom.value) {
    nextTick(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

watch(messages, () => scrollToBottom(), { deep: false });

// ─── 当前频道名 ───────────────────────────────────────────────────────────────
const channelName = computed(() => appStore.connection.currentChannel || '聊天');
const isConnected = computed(() => appStore.connection.isConnected);

// ─── 发送消息 ─────────────────────────────────────────────────────────────────
async function handleSend() {
  const text = inputText.value.trim();
  const imagesToSend = [...pendingImages.value];
  if (!text && imagesToSend.length === 0) return;
  if (!isConnected.value || isUploadingImage.value) return;

  if (text) {
    emit('send', text);
    inputText.value = '';
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
  return renderMessageContent(content);
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
        :class="{ 'mt-4': !msg.isGrouped, 'mt-0.5': msg.isGrouped }"
        @mouseenter="onMsgMouseenter(msg.id)"
        @mouseleave="onMsgMouseleave"
        @contextmenu.prevent="openMessageContextMenu(msg.id)"
      >
        <!-- 头像列（非折叠时显示，折叠时占位） -->
        <div class="w-12 shrink-0 flex justify-center pt-0.5">
          <BaseAvatar
            v-if="!msg.isGrouped"
            :name="msg.senderName"
            :color="msg.senderColor"
            :preset="msg.senderPreset"
            :avatar-url="msg.senderAvatarUrl"
            size="md"
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
              class="font-semibold text-sm leading-none"
              :class="msg.isSelf ? 'text-[#5865f2]' : 'text-[#f2f3f5]'"
              :style="!msg.isSelf && msg.senderColor ? { color: msg.senderColor } : {}"
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
        @click="scrollToBottom(true)"
      >
        <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
        跳到最新
      </button>
    </div>

    <!-- 输入区 -->
    <div class="px-3 pb-3 pt-2 shrink-0">
      <div class="relative flex flex-col bg-[#383a40] rounded-xl border border-white/5 focus-within:border-[#5865f2]/50 transition-colors overflow-hidden">
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
          @input="autoResize"
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
        <span class="text-[10px] text-[#4e5058]">Enter 发送 · Shift+Enter 换行 · Ctrl+V 添加图片预览</span>
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

/* 自定义滚动条 */
.custom-scroll::-webkit-scrollbar { width: 4px; }
.custom-scroll::-webkit-scrollbar-track { background: transparent; }
.custom-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
.custom-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

/* 富文本消息内容样式 */
.msg-row {
  min-width: 0;
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
