import { reactive } from 'vue';
import { fetchChatHistory, clearChatHistory } from '../shared/apiClient.js';
import { logError } from '../shared/errors.js';

// ─── 常量 ──────────────────────────────────────────────────────────────────────
const CHAT_STORAGE_PREFIX = 'donichannel_chat_v1_';
const MAX_MESSAGES_PER_CHANNEL = 200;
// 同一发送者、相邻消息间隔在此时间内视为“连续消息”（可折叠头像/昵称）
const GROUPING_THRESHOLD_MS = 5 * 60 * 1000;
// 历史补偿节流：同一频道短时间多次触发时只允许一次请求。
const HISTORY_REFRESH_MIN_INTERVAL_MS = 3000;
const historyRefreshState = {};

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function generateId() {
  return 'local_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function storageKey(channelId) {
  return CHAT_STORAGE_PREFIX + String(channelId || 'lobby').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function safeJsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function normalizeChannelId(channelId) {
  return String(channelId || 'lobby').trim() || 'lobby';
}

function normalizeMessage(raw = {}, fallbackChannelId = 'lobby', selfId = '') {
  const channelId = normalizeChannelId(raw.channelId || fallbackChannelId);
  const id = String(raw.id || raw.serverMessageId || raw.clientMessageId || generateId());
  const senderId = String(raw.senderId || raw.senderUserId || raw.userId || '');

  return {
    id,
    clientMessageId: raw.clientMessageId || id,
    serverMessageId: raw.serverMessageId || raw.id || id,
    channelId,
    senderId,
    senderUserId: raw.senderUserId || senderId,
    senderIdentity: raw.senderIdentity || raw.identity || '',
    senderName: raw.senderName || raw.displayName || '未知用户',
    senderColor: raw.senderColor || raw.avatarColor || '#5865f2',
    senderPreset: raw.senderPreset || raw.avatarPreset || '',
    senderAvatarUrl: raw.senderAvatarUrl ?? raw.avatarUrl ?? null,
    content: raw.content || '',
    timestamp: Number(raw.timestamp || Date.now()),
    reactions: raw.reactions && typeof raw.reactions === 'object' ? raw.reactions : {},
    isSelf: raw.isSelf !== undefined ? !!raw.isSelf : (!!selfId && senderId === selfId),
    status: raw.status || 'sent',
  };
}

function serializeMessage(m) {
  return {
    id: m.id,
    clientMessageId: m.clientMessageId,
    serverMessageId: m.serverMessageId,
    channelId: m.channelId,
    senderId: m.senderId,
    senderUserId: m.senderUserId,
    senderIdentity: m.senderIdentity,
    senderName: m.senderName,
    senderColor: m.senderColor,
    senderPreset: m.senderPreset,
    senderAvatarUrl: m.senderAvatarUrl ?? null,
    content: m.content,
    timestamp: m.timestamp,
    reactions: m.reactions ?? {},
    isSelf: !!m.isSelf,
    status: m.status || 'sent',
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────
export const chatStore = reactive({
  /** 当前频道 ID */
  currentChannelId: null,
  /** 当前频道的消息列表（响应式） */
  messages: [],
  /** 内存缓存：其他频道已加载的消息（避免重复读取 localStorage） */
  _cache: {},
  /** Reaction 可能先于消息到达；先暂存，等消息出现后再补应用 */
  _pendingReactions: {},
});

// ─── 持久化 ───────────────────────────────────────────────────────────────────
function persistChannel(channelId) {
  const cleanId = normalizeChannelId(channelId);
  const list = cleanId === chatStore.currentChannelId
    ? chatStore.messages
    : (chatStore._cache[cleanId] || []);

  try {
    localStorage.setItem(storageKey(cleanId), JSON.stringify(list.map(serializeMessage)));
  } catch (e) {
    console.warn('[chatStore] 持久化失败', e);
  }
}

function persistCurrentChannel() {
  if (!chatStore.currentChannelId) return;
  persistChannel(chatStore.currentChannelId);
}

function loadFromStorage(channelId) {
  const cleanId = normalizeChannelId(channelId);
  const raw = localStorage.getItem(storageKey(cleanId));
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((m) => normalizeMessage(m, cleanId));
}

function getChannelList(channelId) {
  const cleanId = normalizeChannelId(channelId);
  if (chatStore.currentChannelId === cleanId) return chatStore.messages;
  if (!chatStore._cache[cleanId]) chatStore._cache[cleanId] = loadFromStorage(cleanId);
  return chatStore._cache[cleanId];
}

function findMessageInList(list, idOrClientId) {
  return list.find((m) => m.id === idOrClientId || m.clientMessageId === idOrClientId || m.serverMessageId === idOrClientId);
}

function findMessageAnywhere(idOrClientId) {
  if (!idOrClientId) return null;

  let msg = findMessageInList(chatStore.messages, idOrClientId);
  if (msg) return { msg, channelId: chatStore.currentChannelId };

  for (const [channelId, list] of Object.entries(chatStore._cache)) {
    msg = findMessageInList(list, idOrClientId);
    if (msg) return { msg, channelId };
  }

  return null;
}

function applyPendingReactionForMessage(message) {
  if (!message?.id) return;
  const pending = chatStore._pendingReactions[message.id] || chatStore._pendingReactions[message.serverMessageId] || chatStore._pendingReactions[message.clientMessageId];
  if (!pending) return;

  message.reactions = pending.reactions || {};
  delete chatStore._pendingReactions[message.id];
  if (message.serverMessageId) delete chatStore._pendingReactions[message.serverMessageId];
  if (message.clientMessageId) delete chatStore._pendingReactions[message.clientMessageId];
}

function upsertMessageToChannel(message, channelId) {
  const cleanId = normalizeChannelId(channelId || message.channelId);
  const list = getChannelList(cleanId);
  const existing = findMessageInList(list, message.id) || findMessageInList(list, message.clientMessageId);

  if (existing) {
    Object.assign(existing, {
      ...message,
      reactions: message.reactions || existing.reactions || {},
      status: message.status || existing.status || 'sent',
    });
    applyPendingReactionForMessage(existing);
    persistChannel(cleanId);
    return existing;
  }

  applyPendingReactionForMessage(message);
  list.push(message);
  list.sort((a, b) => a.timestamp - b.timestamp);

  if (list.length > MAX_MESSAGES_PER_CHANNEL) {
    list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
  }

  persistChannel(cleanId);
  return message;
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

export function switchChatChannel(channelId) {
  const cleanId = normalizeChannelId(channelId);

  if (chatStore.currentChannelId) {
    chatStore._cache[chatStore.currentChannelId] = [...chatStore.messages];
  }

  chatStore.currentChannelId = cleanId;

  if (chatStore._cache[cleanId]) {
    chatStore.messages = chatStore._cache[cleanId];
  } else {
    chatStore.messages = loadFromStorage(cleanId);
    chatStore._cache[cleanId] = chatStore.messages;
  }

  for (const msg of chatStore.messages) applyPendingReactionForMessage(msg);
  persistCurrentChannel();
}

export function addChatMessage(msgData) {
  const channelId = normalizeChannelId(msgData.channelId || chatStore.currentChannelId || 'lobby');
  const localId = msgData.id || msgData.clientMessageId || generateId();
  const msg = normalizeMessage({
    ...msgData,
    id: localId,
    clientMessageId: msgData.clientMessageId || localId,
    channelId,
    status: msgData.status || 'sending',
  }, channelId);

  return upsertMessageToChannel(msg, channelId);
}

export function markMessageSent({ clientMessageId, serverMessageId, messageId }) {
  const found = findMessageAnywhere(clientMessageId || messageId || serverMessageId);
  if (!found) return;
  found.msg.status = 'sent';
  if (serverMessageId) found.msg.serverMessageId = serverMessageId;
  if (messageId) found.msg.id = messageId;
  persistChannel(found.channelId);
}

export function markMessageFailed(clientMessageId) {
  const found = findMessageAnywhere(clientMessageId);
  if (!found) return;
  found.msg.status = 'failed';
  persistChannel(found.channelId);
}

export function toggleReaction(messageId, emoji, senderId) {
  const found = findMessageAnywhere(messageId);
  const msg = found?.msg;
  if (!msg) return;

  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

  const idx = msg.reactions[emoji].indexOf(senderId);
  if (idx >= 0) {
    msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
  } else {
    msg.reactions[emoji].push(senderId);
  }

  persistChannel(found.channelId);
}

export function updateChatAvatars(identity, avatarColor, avatarPreset, avatarUrl) {
  if (!identity) return;
  const ids = new Set([identity]);
  let changedCurrent = false;

  for (const msg of chatStore.messages) {
    if (ids.has(msg.senderId) || ids.has(msg.senderUserId) || ids.has(msg.senderIdentity)) {
      msg.senderColor = avatarColor;
      msg.senderPreset = avatarPreset;
      msg.senderAvatarUrl = avatarUrl;
      changedCurrent = true;
    }
  }
  if (changedCurrent) persistCurrentChannel();

  for (const channelId in chatStore._cache) {
    let cacheChanged = false;
    for (const msg of chatStore._cache[channelId]) {
      if (ids.has(msg.senderId) || ids.has(msg.senderUserId) || ids.has(msg.senderIdentity)) {
        msg.senderColor = avatarColor;
        msg.senderPreset = avatarPreset;
        msg.senderAvatarUrl = avatarUrl;
        cacheChanged = true;
      }
    }
    if (cacheChanged) persistChannel(channelId);
  }
}

export function clearChatChannel(channelId) {
  const cleanId = normalizeChannelId(channelId || chatStore.currentChannelId || 'lobby');

  if (chatStore.currentChannelId === cleanId) {
    chatStore.messages = [];
  }

  delete chatStore._cache[cleanId];
  localStorage.removeItem(storageKey(cleanId));

  clearChatHistory(cleanId).catch(() => {});
}

export function shouldGroupWithPrev(prevMsg, currMsg) {
  if (!prevMsg || !currMsg) return false;
  if (prevMsg.senderId !== currMsg.senderId) return false;
  return currMsg.timestamp - prevMsg.timestamp < GROUPING_THRESHOLD_MS;
}

export function loadServerHistory(channelId, { limit = 50 } = {}) {
  const cleanId = String(channelId || '').trim();
  if (!cleanId) return Promise.resolve(false);

  const state = historyRefreshState[cleanId] || (historyRefreshState[cleanId] = {
    lastStartedAt: 0,
    inFlight: null,
  });
  const now = Date.now();

  // Store 层作为历史补偿唯一闸门：
  // 1. 请求正在进行时，后续触发直接复用同一个 Promise。
  // 2. 同一频道 3 秒内不再发起新的 GET /api/chat/history。
  if (state.inFlight) return state.inFlight;
  if (now - state.lastStartedAt < HISTORY_REFRESH_MIN_INTERVAL_MS) {
    return Promise.resolve(false);
  }

  state.lastStartedAt = now;
  state.inFlight = (async () => {
    try {
      const { messages: serverMsgs } = await fetchChatHistory(cleanId, { limit });
      if (Array.isArray(serverMsgs) && serverMsgs.length > 0) {
        const targetList = getChannelList(cleanId);
        const selfId = '';

        for (const raw of serverMsgs) {
          const msg = normalizeMessage(raw, cleanId, selfId);
          upsertMessageToChannel({ ...msg, status: 'sent' }, cleanId);
        }

        targetList.sort((a, b) => a.timestamp - b.timestamp);
        if (targetList.length > MAX_MESSAGES_PER_CHANNEL) {
          targetList.splice(0, targetList.length - MAX_MESSAGES_PER_CHANNEL);
        }

        if (chatStore.currentChannelId === cleanId) {
          chatStore.messages = targetList;
        }
        persistChannel(cleanId);
      }

      return true;
    } catch (e) {
      logError('chatStore/loadServerHistory 加载服务器历史失败', e, 'warn');
      return false;
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

export function applyServerChatMessage(serverMsg, selfIdentityOrUserId = '') {
  if (!serverMsg || !serverMsg.channelId) return;
  const cleanId = normalizeChannelId(serverMsg.channelId);
  const msg = normalizeMessage(serverMsg, cleanId, selfIdentityOrUserId);
  msg.isSelf = msg.isSelf || (!!selfIdentityOrUserId && (msg.senderId === selfIdentityOrUserId || msg.senderUserId === selfIdentityOrUserId || msg.senderIdentity === selfIdentityOrUserId));
  msg.status = 'sent';
  upsertMessageToChannel(msg, cleanId);
}

export function applyServerReactionUpdate(update) {
  if (!update || !update.messageId) return;

  const found = findMessageAnywhere(update.messageId);
  if (!found) {
    chatStore._pendingReactions[update.messageId] = {
      channelId: update.channelId || '',
      reactions: update.reactions || {},
      updatedAt: Date.now(),
    };
    return;
  }

  found.msg.reactions = update.reactions || {};
  persistChannel(found.channelId);
}
