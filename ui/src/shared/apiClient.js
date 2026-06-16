/**
 * DoNiChannel 后端 HTTP API 客户端。
 *
 * 集中管理和后端 REST 接口的通信：
 * - 聊天历史拉取
 * - 消息持久化（POST）
 * - Reaction 同步
 * - 用户资料查询
 */

import { logError } from './errors.js';
import { appStore } from '../stores/appStore.js';
import { DEFAULT_SERVER_IP } from './constants.js';

let _apiBase = '';

/** 获取当前后端基础地址，未显式设置时自动推断。 */
export function getApiBase() {
  if (_apiBase) return _apiBase;
  
  // 未加入房间前，_apiBase 为空，从 appStore 获取并推断
  try {
    const ip = appStore?.connection?.serverIp || DEFAULT_SERVER_IP;
    const host = ip.includes(':') ? ip.split(':')[0] : ip;
    const port = ip.includes(':') ? ip.split(':')[1] : '5000';
    return `http://${host}:${port}`;
  } catch (e) {
    return 'http://127.0.0.1:5000';
  }
}

/** 设置当前后端基础地址（由 runtime.js 在连接时调用）。 */
export function setApiBase(apiBase) {
  _apiBase = String(apiBase || '').replace(/\/$/, '');
}

/** 通用 fetch 封装，自动加前缀、处理 JSON 和错误。 */
async function apiFetch(path, options = {}) {
  const base = getApiBase();
  if (!base) {
    throw new Error('[apiClient] apiBase 未设置，请先调用 setApiBase()');
  }

  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[apiClient] ${options.method || 'GET'} ${url} → ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── 聊天 ─────────────────────────────────────────────────────────────────────

/**
 * 清空聊天历史记录（指定频道或全部频道）。
 * @param {string|null} [channelId] - 频道 ID，不传则清空全部
 * @returns {Promise<{ ok: boolean, channel: string }>}
 */
export async function clearChatHistory(channelId, { adminToken } = {}) {
  let path = '/api/chat/history';
  const params = new URLSearchParams();
  if (channelId) params.set('channel', channelId);
  if (adminToken) params.set('adminToken', adminToken);
  const qs = params.toString();
  if (qs) path += `?${qs}`;
  return apiFetch(path, { method: 'DELETE' });
}

/**
 * 拉取频道聊天历史记录。
 * @param {string} channelId
 * @param {{ limit?: number, before?: number }} [opts]
 * @returns {Promise<{ messages: Array, channelId: string }>}
 */
export async function fetchChatHistory(channelId, { limit = 50, before } = {}) {
  let path = `/api/chat/history?channel=${encodeURIComponent(channelId)}&limit=${limit}`;
  if (before != null) path += `&before=${before}`;
  return apiFetch(path, { cache: 'no-store' });
}

/**
 * 持久化一条聊天消息到服务器。
 * @param {Object} msg - 消息对象（同 chatStore 结构）
 * @returns {Promise<{ ok: boolean, id: string }>}
 */
export async function postChatMessage(msg) {
  return apiFetch('/api/chat/message', {
    method: 'POST',
    body: JSON.stringify({
      id: msg.id,
      channelId: msg.channelId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      senderColor: msg.senderColor,
      senderPreset: msg.senderPreset,
      senderAvatarUrl: msg.senderAvatarUrl,
      content: msg.content,
      timestamp: msg.timestamp,
    }),
  });
}

/**
 * 同步 Reaction 到服务器（服务器负责广播给其他客户端）。
 * @param {{ messageId, emoji, senderId, channelId }} params
 * @returns {Promise<{ ok: boolean, action: string, reactions: Object }>}
 */
export async function syncReaction({ messageId, emoji, senderId, channelId }) {
  return apiFetch('/api/chat/reaction', {
    method: 'POST',
    body: JSON.stringify({ messageId, emoji, senderId, channelId }),
  });
}

/**
 * 查询某个用户的资料缓存。
 * 优先使用 userId，兼容旧 identity。
 * @param {string} userId
 * @returns {Promise<{ identity, userId, displayName, avatarColor, avatarPreset, avatarUrl, statusText }|null>}
 */
export async function fetchUserProfile(userId) {
  try {
    const key = encodeURIComponent(userId || '');
    if (!key) return null;
    return await apiFetch(`/api/user/profile?userId=${key}`);
  } catch (_) {
    return null;
  }
}

/**
 * 保存用户资料到后端 SQLite。
 * @param {{ userId, displayName, avatarColor, avatarPreset, avatarUrl, statusText }} profile
 */
export async function saveUserProfile(profile) {
  return apiFetch('/api/user/profile', {
    method: 'POST',
    body: JSON.stringify({
      userId: profile.userId,
      displayName: profile.displayName,
      avatarColor: profile.avatarColor,
      avatarPreset: profile.avatarPreset,
      avatarUrl: profile.avatarUrl || '',
      statusText: profile.statusText || '在线',
    }),
  });
}

/**
 * 上传头像文件到服务器。
 * @param {File} file - 图片文件
 * @returns {Promise<{ ok: boolean, url: string }>}
 */
export async function uploadAvatar(file, { userId } = {}) {
  const base = getApiBase();
  if (!base) {
    throw new Error('[apiClient] apiBase 未设置，请先调用 setApiBase()');
  }

  const formData = new FormData();
  formData.append('file', file);
  if (userId) formData.append('userId', userId);

  const url = `${base}/api/upload/avatar`;
  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    // 注意：不要手动设置 Content-Type，fetch 会自动加上 multipart/form-data 及其 boundary
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[apiClient] POST ${url} → ${res.status}: ${text}`);
  }

  return res.json();
}


/**
 * 上传聊天图片到服务器。
 * @param {File} file - 图片文件
 * @param {{ channelId?: string, userId?: string }} [opts]
 * @returns {Promise<{ ok: boolean, url: string, imageUrl: string, sizeBytes?: number, contentType?: string }>}
 */
export async function uploadChatImage(file, { channelId, userId } = {}) {
  const base = getApiBase();
  if (!base) {
    throw new Error('[apiClient] apiBase 未设置，请先调用 setApiBase()');
  }

  const formData = new FormData();
  formData.append('file', file);
  if (channelId) formData.append('channelId', channelId);
  if (userId) formData.append('userId', userId);

  const url = `${base}/api/upload/chat-image`;
  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    // 不要手动设置 Content-Type，fetch 会自动加 multipart boundary。
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[apiClient] POST ${url} → ${res.status}: ${text}`);
  }

  return res.json();
}


/**
 * 查询某个用户的头像历史。
 * @param {string} userId
 * @returns {Promise<{ ok: boolean, userId: string, items: Array }>}
 */
export async function fetchAvatarHistory(userId, { limit = 12 } = {}) {
  const key = encodeURIComponent(userId || '');
  if (!key) return { ok: false, items: [] };
  return apiFetch(`/api/user/avatar-history?userId=${key}&limit=${limit}`);
}

// ─── 安全封装（不抛出，只打日志） ─────────────────────────────────────────────

/**
 * 静默版 postChatMessage：失败时只打日志，不影响本地渲染。
 * 用于"先本地显示、后台同步到服务器"的场景。
 */
export async function silentPostChatMessage(msg) {
  try {
    const apiBase = getApiBase();
    if (!apiBase) {
      logError('apiClient/silentPostChatMessage apiBase 未设置，消息无法持久化', null, 'warn');
      return;
    }
    await postChatMessage(msg);
  } catch (e) {
    logError('apiClient/silentPostChatMessage 消息持久化失败', e, 'warn');
  }
}

/**
 * 静默版 syncReaction：失败时只打日志。
 *
 * Phase 2：新客户端优先通过独立 Chat WebSocket 同步 Reaction。
 * 若 Chat WebSocket 不可用，则回退到旧 REST 接口，保持兼容。
 */
export async function silentSyncReaction(params) {
  try {
    const chatClient = window.__chatClient;
    if (chatClient?.isConnected?.()) {
      const sent = chatClient.toggleReaction?.({
        messageId: params.messageId,
        emoji: params.emoji,
        channelId: params.channelId,
      });
      if (sent) return { ok: true, via: 'chat_ws' };
    }

    return await syncReaction(params);
  } catch (e) {
    logError(
      `apiClient/silentSyncReaction Reaction 同步失败 messageId=${params?.messageId || ''} emoji=${params?.emoji || ''} channel=${params?.channelId || ''}`,
      e,
      'warn'
    );
    return null;
  }
}
