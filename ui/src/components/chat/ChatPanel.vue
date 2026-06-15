<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import BaseAvatar from '../common/BaseAvatar.vue';
import { chatStore, shouldGroupWithPrev, toggleReaction, applyServerReactionUpdate } from '../../stores/chatStore.js';
import { profileStore } from '../../stores/profileStore.js';
import { presenceStore } from '../../stores/presenceStore.js';
import { renderMessageContent, QUICK_REACTIONS, EMOJI_LIST } from '../../shared/messageRenderer.js';
import { appStore } from '../../stores/appStore.js';
import { silentSyncReaction } from '../../shared/apiClient.js';

const emit = defineEmits(['send']);

// ─── 输入框状态 ────────────────────────────────────────────────────────────────
const inputText = ref('');
const textareaEl = ref(null);
const messagesEl = ref(null);

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
}
function closeReactionPicker() {
  reactionPickerMsgId.value = null;
  hoveredMsgId.value = null;
}

// 点击空白处关闭 reaction picker & emoji picker
function onDocumentClick(e) {
  if (!e.target.closest('.reaction-picker') && !e.target.closest('.msg-action-btn')) {
    reactionPickerMsgId.value = null;
  }
  if (!e.target.closest('.emoji-picker') && !e.target.closest('.emoji-toggle-btn')) {
    showEmojiPicker.value = false;
  }
}
onMounted(() => document.addEventListener('click', onDocumentClick, true));
onUnmounted(() => document.removeEventListener('click', onDocumentClick, true));

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
function handleSend() {
  const text = inputText.value.trim();
  if (!text) return;
  emit('send', text);
  inputText.value = '';
  nextTick(() => {
    if (textareaEl.value) textareaEl.value.style.height = 'auto';
    scrollToBottom(true);
  });
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
      el.focus();
      el.setSelectionRange(start + markup.length, end + markup.length);
    });
  } else {
    const placeholder = markup === '**' ? '粗体' : markup === '*' ? '斜体' : markup === '`' ? '代码' : markup === '~~' ? '删除线' : '剧透';
    inputText.value = text.slice(0, start) + markup + placeholder + markup + text.slice(end);
    nextTick(() => {
      el.focus();
      const newStart = start + markup.length;
      const newEnd = newStart + placeholder.length;
      el.setSelectionRange(newStart, newEnd);
    });
  }
}

function autoResize(e) {
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
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
    el.setSelectionRange(start + emojiChar.length, start + emojiChar.length);
    el.focus();
  });
  showEmojiPicker.value = false;
}

// ─── Reaction ────────────────────────────────────────────────────────────────
/**
 * 获取当前用户在 reaction 中使用的 ID。
 * 优先使用 Presence identity（与消息的 senderId 保持一致），
 * 未连接时回退到 profileStore.userId。
 */
function getSelfReactionId() {
  return presenceStore.identity || profileStore.userId;
}

async function handleReaction(msgId, emoji) {
  const myId = getSelfReactionId();
  // 乐观更新：立即在本地修改，提供即时反馈
  toggleReaction(msgId, emoji, myId);

  // 同步到服务器，用响应结果做最终校准（防止并发快速点击状态不一致）
  const result = await silentSyncReaction({
    messageId: msgId,
    emoji,
    senderId: myId,
    channelId: chatStore.currentChannelId || '',
  });

  // 用服务端权威状态校准本地（服务端已排除了广播给自己，所以自己需要从响应中同步）
  if (result?.reactions !== undefined) {
    applyServerReactionUpdate({
      messageId: msgId,
      reactions: result.reactions,
    });
  }

  closeReactionPicker();
}

function reactionCount(reactions, emoji) {
  return (reactions?.[emoji] || []).length;
}

function isMineReaction(reactions, emoji) {
  const myId = getSelfReactionId();
  return (reactions?.[emoji] || []).includes(myId);
}

function getReactionUserNames(userIds) {
  if (!Array.isArray(userIds)) return '';
  const myId = getSelfReactionId();
  
  return userIds.map(id => {
    if (id === myId) return '你';
    
    // 优先从在线列表查找昵称
    const p = presenceStore.participants[id];
    if (p && p.displayName) return p.displayName;
    
    // 其次从当前聊天记录中提取发过的消息查找名字
    const msg = chatStore.messages.find(m => m.senderId === id);
    if (msg && msg.senderName) return msg.senderName;
    
    // 兜底：取 uuid 前的部分（通常是名字-uuid 格式）
    return id.includes('-') ? id.split('-')[0] : '某人';
  }).join(', ');
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
        <div class="flex-1 min-w-0">
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
            class="text-[#dcddde] text-sm leading-relaxed break-words msg-content"
            v-html="renderContent(msg.content)"
          />

          <!-- Reactions -->
          <div v-if="Object.keys(msg.reactions || {}).length > 0" class="flex flex-wrap gap-1 mt-1.5">
            <button
              v-for="(users, emoji) in msg.reactions"
              :key="emoji"
              class="reaction-btn flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-all duration-150"
              :class="isMineReaction(msg.reactions, emoji)
                ? 'bg-[#5865f2]/20 border-[#5865f2]/60 text-[#5865f2]'
                : 'bg-white/5 border-white/10 text-[#b5bac1] hover:bg-white/10 hover:border-white/20'"
              :title="`${getReactionUserNames(users)} 回应了 ${emoji}`"
              @click="handleReaction(msg.id, emoji)"
            >
              <span>{{ emoji }}</span>
              <span class="font-medium">{{ users.length }}</span>
            </button>
          </div>
        </div>

        <!-- 消息操作栏（hover 显示） -->
        <div
          class="msg-actions absolute right-2 top-0 -translate-y-1/2 flex items-center gap-1 bg-[#2b2d31] border border-white/10 rounded-lg px-1 py-0.5 shadow-lg"
          :class="hoveredMsgId === msg.id ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'"
          style="transition: opacity 0.1s;"
        >
          <!-- 快速 reaction -->
          <button
            v-for="qr in QUICK_REACTIONS.slice(0, 5)"
            :key="qr.name"
            class="msg-action-btn w-7 h-7 flex items-center justify-center text-base rounded hover:bg-white/10 transition-colors"
            :title="`:${qr.name}:`"
            @click.stop="handleReaction(msg.id, qr.char)"
          >{{ qr.char }}</button>

          <!-- 更多 reaction -->
          <button
            class="msg-action-btn w-7 h-7 flex items-center justify-center text-[#b5bac1] rounded hover:bg-white/10 hover:text-white transition-colors"
            title="更多表情"
            @click.stop="openReactionPicker(msg.id)"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>
        </div>

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
      <div class="relative flex items-end bg-[#383a40] rounded-xl border border-white/5 focus-within:border-[#5865f2]/50 transition-colors">
        <!-- 输入框 -->
        <textarea
          ref="textareaEl"
          v-model="inputText"
          class="flex-1 bg-transparent text-[#dcddde] text-sm placeholder-[#4e5058] px-4 py-3 resize-none leading-relaxed outline-none max-h-30 min-h-[44px]"
          :placeholder="isConnected ? `发送消息到 #${channelName}...` : '未连接，无法发送消息'"
          :disabled="!isConnected"
          rows="1"
          @keydown="handleKeydown"
          @input="autoResize"
        />

        <!-- 右侧工具栏 -->
        <div class="flex items-center gap-1 pr-2 pb-2 shrink-0">
          <!-- Emoji 按钮 -->
          <button
            class="emoji-toggle-btn w-8 h-8 flex items-center justify-center text-[#b5bac1] rounded hover:bg-white/10 hover:text-white transition-colors text-lg"
            title="插入表情"
            @click.stop="showEmojiPicker = !showEmojiPicker"
          >😊</button>

          <!-- 发送按钮 -->
          <button
            class="w-8 h-8 flex items-center justify-center rounded transition-all duration-150"
            :class="inputText.trim() && isConnected
              ? 'bg-[#5865f2] text-white hover:bg-[#4752c4] shadow-[0_0_12px_rgba(88,101,242,0.4)]'
              : 'bg-white/5 text-[#4e5058] cursor-not-allowed'"
            :disabled="!inputText.trim() || !isConnected"
            title="发送 (Enter)"
            @click="handleSend"
          >
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
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
        <span class="text-[10px] text-[#4e5058]">Enter 发送 · Shift+Enter 换行</span>
        <span v-if="messages.length > 0" class="text-[10px] text-[#4e5058]">{{ messages.length }} 条消息</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 自定义滚动条 */
.custom-scroll::-webkit-scrollbar { width: 4px; }
.custom-scroll::-webkit-scrollbar-track { background: transparent; }
.custom-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
.custom-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

/* 富文本消息内容样式 */
:deep(.msg-content) {
  word-break: break-word;
  overflow-wrap: break-word;
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

/* 头像图片样式 */
:deep(.base-avatar-img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}
</style>
