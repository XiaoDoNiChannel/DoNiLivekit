import { reactive } from 'vue';
import { fetchChatHistory, clearChatHistory } from '../shared/apiClient.js';
import { logError } from '../shared/errors.js';

// 获取当前用户 identity（延迟导入避免循环依赖）
function getSelfIdentity() {
  try {
    // 优先用 sessionStorage 中的 Presence identity
    const presenceIdentity = sessionStorage.getItem('lk_presence_identity');
    if (presenceIdentity) return presenceIdentity;
  } catch (_) {}
  return '';
}

// ─── 常量 ──────────────────────────────────────────────────────────────────────
const CHAT_STORAGE_PREFIX = 'donichannel_chat_v1_';
const MAX_MESSAGES_PER_CHANNEL = 200;
// 同一发送者、相邻消息间隔在此时间内视为"连续消息"（可折叠头像/昵称）
const GROUPING_THRESHOLD_MS = 5 * 60 * 1000; // 5 分钟

// ─── 消息结构 ─────────────────────────────────────────────────────────────────
/**
 * 消息对象结构：
 * {
 *   id: string,           // nanoid (不依赖外部库，用 Math.random 生成)
 *   channelId: string,
 *   senderId: string,     // participant.identity
 *   senderName: string,
 *   senderColor: string,  // 头像背景色
 *   senderPreset: string, // emoji 预设
 *   senderAvatarUrl: string|null, // base64 图片头像（可选）
 *   content: string,      // 原始文本（支持 markdown 语法 & Discord emoji :name:）
 *   timestamp: number,    // Date.now()
 *   reactions: Record<string, string[]>, // emoji -> [senderId, ...]
 *   isSelf: boolean,
 * }
 */

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

// ─── Store ────────────────────────────────────────────────────────────────────
export const chatStore = reactive({
  /** 当前频道 ID */
  currentChannelId: null,
  /** 当前频道的消息列表（响应式） */
  messages: [],
  /** 内存缓存：其他频道已加载的消息（避免重复读取 localStorage） */
  _cache: {},
});

// ─── 持久化 ───────────────────────────────────────────────────────────────────
/** 将当前频道的消息保存到 localStorage。 */
function persistCurrentChannel() {
  const channelId = chatStore.currentChannelId;
  if (!channelId) return;

  try {
    // 只保存可序列化字段（过滤掉运行时临时字段）
    const toSave = chatStore.messages.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      senderId: m.senderId,
      senderName: m.senderName,
      senderColor: m.senderColor,
      senderPreset: m.senderPreset,
      senderAvatarUrl: m.senderAvatarUrl ?? null,
      content: m.content,
      timestamp: m.timestamp,
      reactions: m.reactions ?? {},
      isSelf: m.isSelf,
    }));
    localStorage.setItem(storageKey(channelId), JSON.stringify(toSave));
  } catch (e) {
    // localStorage 写满时静默失败，不影响运行时
    // eslint-disable-next-line no-console
    console.warn('[chatStore] 持久化失败', e);
  }
}

/** 从 localStorage 加载指定频道的消息。 */
function loadFromStorage(channelId) {
  const raw = localStorage.getItem(storageKey(channelId));
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) return [];

  // 兼容旧版消息结构，补全缺失字段
  return parsed.map((m) => ({
    id: m.id || generateId(),
    channelId: m.channelId || channelId,
    senderId: m.senderId || '',
    senderName: m.senderName || '未知用户',
    senderColor: m.senderColor || '#5865f2',
    senderPreset: m.senderPreset || '',
    senderAvatarUrl: m.senderAvatarUrl ?? null,
    content: m.content || '',
    timestamp: m.timestamp || Date.now(),
    reactions: m.reactions && typeof m.reactions === 'object' ? m.reactions : {},
    isSelf: !!m.isSelf,
  }));
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 切换到指定频道，加载该频道的历史消息。
 * @param {string} channelId
 */
export function switchChatChannel(channelId) {
  const cleanId = String(channelId || 'lobby').trim();

  // 保存上一个频道
  if (chatStore.currentChannelId) {
    chatStore._cache[chatStore.currentChannelId] = [...chatStore.messages];
  }

  chatStore.currentChannelId = cleanId;

  // 优先从内存缓存取，否则从 localStorage 加载
  if (chatStore._cache[cleanId]) {
    chatStore.messages = chatStore._cache[cleanId];
  } else {
    chatStore.messages = loadFromStorage(cleanId);
    chatStore._cache[cleanId] = chatStore.messages;
  }
}

/**
 * 向当前频道添加一条消息。
 * @param {Object} msgData - 消息数据（不含 id/timestamp）
 */
export function addChatMessage(msgData) {
  const channelId = chatStore.currentChannelId || 'lobby';
  const msg = {
    id: msgData.id || generateId(),
    channelId,
    senderId: msgData.senderId || '',
    senderName: msgData.senderName || '未知用户',
    senderColor: msgData.senderColor || '#5865f2',
    senderPreset: msgData.senderPreset || '',
    senderAvatarUrl: msgData.senderAvatarUrl ?? null,
    content: msgData.content || '',
    timestamp: msgData.timestamp || Date.now(),
    reactions: {},
    isSelf: !!msgData.isSelf,
  };

  chatStore.messages.push(msg);

  // 超过上限时移除最旧的消息
  if (chatStore.messages.length > MAX_MESSAGES_PER_CHANNEL) {
    chatStore.messages.splice(0, chatStore.messages.length - MAX_MESSAGES_PER_CHANNEL);
  }

  persistCurrentChannel();
  return msg;  // 返回消息对象，供调用方转发到服务器
}

/**
 * 对某条消息添加或取消 emoji reaction。
 * @param {string} messageId
 * @param {string} emoji
 * @param {string} senderId
 */
export function toggleReaction(messageId, emoji, senderId) {
  const msg = chatStore.messages.find((m) => m.id === messageId);
  if (!msg) return;

  if (!msg.reactions[emoji]) {
    msg.reactions[emoji] = [];
  }

  const idx = msg.reactions[emoji].indexOf(senderId);
  if (idx >= 0) {
    msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) {
      delete msg.reactions[emoji];
    }
  } else {
    msg.reactions[emoji].push(senderId);
  }

  persistCurrentChannel();
}



/** 更新历史聊天记录中的发送者头像（当某个用户修改了资料时） */
export function updateChatAvatars(identity, avatarColor, avatarPreset, avatarUrl) {
  if (!identity) return;
  let changed = false;
  
  // 更新当前频道内存中的消息
  for (const msg of chatStore.messages) {
    if (msg.senderId === identity) {
      msg.senderColor = avatarColor;
      msg.senderPreset = avatarPreset;
      msg.senderAvatarUrl = avatarUrl;
      changed = true;
    }
  }
  if (changed) persistCurrentChannel();

  // 更新缓存中的消息
  for (const channelId in chatStore._cache) {
    let cacheChanged = false;
    for (const msg of chatStore._cache[channelId]) {
      if (msg.senderId === identity) {
        msg.senderColor = avatarColor;
        msg.senderPreset = avatarPreset;
        msg.senderAvatarUrl = avatarUrl;
        cacheChanged = true;
      }
    }
    // 如果需要持久化缓存，可以将缓存覆盖回 localStorage
    if (cacheChanged) {
      localStorage.setItem(storageKey(channelId), JSON.stringify(chatStore._cache[channelId]));
    }
  }
}

/**
 * 清空指定频道（或当前频道）的消息。
 * @param {string|null} channelId
 */
export function clearChatChannel(channelId) {
  const cleanId = String(channelId || chatStore.currentChannelId || 'lobby').trim();

  if (chatStore.currentChannelId === cleanId) {
    chatStore.messages = [];
  }

  delete chatStore._cache[cleanId];
  localStorage.removeItem(storageKey(cleanId));

  clearChatHistory(cleanId).catch(() => {});
}

/**
 * 判断两条消息是否应该折叠（连续消息分组）。
 * 相同发送者 + 时间差在阈值内 -> 折叠。
 * @param {Object} prevMsg
 * @param {Object} currMsg
 * @returns {boolean}
 */
export function shouldGroupWithPrev(prevMsg, currMsg) {
  if (!prevMsg || !currMsg) return false;
  if (prevMsg.senderId !== currMsg.senderId) return false;
  return currMsg.timestamp - prevMsg.timestamp < GROUPING_THRESHOLD_MS;
}

/**
 * 从服务器加载频道历史记录，合并到当前消息列表（去重）。
 * 在 switchChatChannel 之后调用，让新加入的用户也能看到历史。
 * @param {string} channelId
 * @param {{ limit?: number }} [opts]
 */
export async function loadServerHistory(channelId, { limit = 50 } = {}) {
  const cleanId = String(channelId || '').trim();
  if (!cleanId) return;

  try {
    const { messages: serverMsgs } = await fetchChatHistory(cleanId, { limit });
    if (!Array.isArray(serverMsgs) || serverMsgs.length === 0) return;

    // 当前频道可能已切换，只处理当前频道
    if (chatStore.currentChannelId !== cleanId) return;

    // 获取当前用户 identity，用于正确标记 isSelf
    const selfId = getSelfIdentity();

    // 合并：去掉本地已有的（按 id 去重），服务器消息插到头部
    const localIds = new Set(chatStore.messages.map((m) => m.id));
    const newMsgs = serverMsgs
      .filter((m) => !localIds.has(m.id))
      .map((m) => ({
        ...m,
        // 根据当前用户 identity 重新判断 isSelf（服务端统一返回 false）
        isSelf: selfId ? m.senderId === selfId : (m.isSelf || false),
        reactions: m.reactions || {},
      }));

    if (newMsgs.length === 0) return;

    // 将服务器旧消息插入到本地消息列表前面，按时间戳排序
    chatStore.messages = [...newMsgs, ...chatStore.messages]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_MESSAGES_PER_CHANNEL);

    // 更新缓存和持久化
    chatStore._cache[cleanId] = chatStore.messages;
    persistCurrentChannel();
  } catch (e) {
    logError('chatStore/loadServerHistory 加载服务器历史失败', e, 'warn');
  }
}

/**
 * 将来自服务器广播（Presence WebSocket chat_message）的消息写入 chatStore。
 * 用于接收其他人发送的、从服务器推送过来的消息（避免重复渲染）。
 * @param {Object} serverMsg
 * @param {string} selfIdentity - 当前用户的 identity，用于标记 isSelf
 */
export function applyServerChatMessage(serverMsg, selfIdentity) {
  if (!serverMsg || !serverMsg.channelId) return;

  const targetChannelId = serverMsg.channelId;

  // 去重检查函数
  function isDuplicate(msgList) {
    return msgList.some((m) => m.id === serverMsg.id);
  }

  if (targetChannelId === chatStore.currentChannelId) {
    // 属于当前频道：直接写入当前消息列表
    if (isDuplicate(chatStore.messages)) return;
    addChatMessage({
      ...serverMsg,
      isSelf: serverMsg.senderId === selfIdentity,
    });
  } else {
    // 属于其他频道：写入内存缓存（而不是丢弃），避免切换频道后漏消息
    if (!chatStore._cache[targetChannelId]) {
      // 该频道尚未在缓存中，不加载历史（避免不必要的 IO），只初始化空缓存
      chatStore._cache[targetChannelId] = [];
    }
    const cacheList = chatStore._cache[targetChannelId];
    if (isDuplicate(cacheList)) return;
    const msg = {
      id: serverMsg.id || generateId(),
      channelId: targetChannelId,
      senderId: serverMsg.senderId || '',
      senderName: serverMsg.senderName || '未知用户',
      senderColor: serverMsg.senderColor || '#5865f2',
      senderPreset: serverMsg.senderPreset || '',
      senderAvatarUrl: serverMsg.senderAvatarUrl ?? null,
      content: serverMsg.content || '',
      timestamp: serverMsg.timestamp || Date.now(),
      reactions: serverMsg.reactions || {},
      isSelf: serverMsg.senderId === selfIdentity,
    };
    cacheList.push(msg);
    // 超过上限时裁剪旧消息
    if (cacheList.length > MAX_MESSAGES_PER_CHANNEL) {
      cacheList.splice(0, cacheList.length - MAX_MESSAGES_PER_CHANNEL);
    }
    // 持久化到 localStorage
    try {
      localStorage.setItem(storageKey(targetChannelId), JSON.stringify(cacheList));
    } catch (_) {}
  }
}

/**
 * 将来自服务器广播的 reaction_update 应用到本地消息。
 * 同时处理当前频道和内存缓存中其他频道的消息。
 * @param {{ messageId, reactions, channelId }} update
 */
export function applyServerReactionUpdate(update) {
  if (!update || !update.messageId) return;

  // 优先在当前频道消息中查找
  const msg = chatStore.messages.find((m) => m.id === update.messageId);
  if (msg) {
    msg.reactions = update.reactions || {};
    persistCurrentChannel();
    return;
  }

  // 在其他频道的缓存中查找
  for (const channelId in chatStore._cache) {
    const cacheList = chatStore._cache[channelId];
    const cachedMsg = cacheList.find((m) => m.id === update.messageId);
    if (cachedMsg) {
      cachedMsg.reactions = update.reactions || {};
      // 同步持久化到 localStorage
      try {
        localStorage.setItem(storageKey(channelId), JSON.stringify(cacheList));
      } catch (_) {}
      return;
    }
  }
}
