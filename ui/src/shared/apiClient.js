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
import { DEFAULT_SERVER_IP } from './constants.js';

let _apiBase = '';

/**
 * 将 "host:port" 格式（或已带协议头的 URL）解析为 http://host:port。
 * @param {string} ip - 如 "10.0.0.1:5000" 或 "http://10.0.0.1:5000"
 * @returns {string}
 */
function ipToApiBase(ip) {
  const clean = String(ip || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '')
    .replace(/\/$/, '');
  if (!clean) return '';
  const host = clean.includes(':') ? clean.split(':')[0] : clean;
  const port = clean.includes(':') ? (clean.split(':')[1] || '5000') : '5000';
  return `http://${host}:${port}`;
}

/**
 * 获取当前后端基础地址。
 *
 * 优先级：
 *   1. 已通过 setApiBase() 显式设置的地址（joinRoom 时设置）
 *   2. 实时读取 DOM #server-ip 输入框（与 getServerConfig 同源，最准确）
 *   3. localStorage lk_server_ip（页面刷新后的恢复值）
 *   4. DEFAULT_SERVER_IP 常量（最终兜底，不再硬编码 127.0.0.1）
 */
export function getApiBase() {
  if (_apiBase) return _apiBase;

  try {
    // 优先实时读 DOM 输入框（与 getServerConfig() 同源，保持一致）
    const inputEl = typeof document !== 'undefined' ? document.getElementById('server-ip') : null;
    const domValue = inputEl?.value?.trim();
    if (domValue) return ipToApiBase(domValue);

    // 其次读 localStorage 中保存的上次连接地址
    const stored = localStorage.getItem('lk_server_ip');
    if (stored) return ipToApiBase(stored);
  } catch (_) {}

  // 最终兜底使用常量（不再硬编码 127.0.0.1）
  return ipToApiBase(DEFAULT_SERVER_IP);
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
export async function clearChatHistory(channelId) {
  let path = '/api/chat/history';
  if (channelId) path += `?channel=${encodeURIComponent(channelId)}`;
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
  return apiFetch(path);
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
 * @param {string} identity
 * @returns {Promise<{ identity, displayName, avatarColor, avatarPreset, avatarUrl }|null>}
 */
export async function fetchUserProfile(identity) {
  try {
    return await apiFetch(`/api/user/profile?identity=${encodeURIComponent(identity)}`);
  } catch (_) {
    return null;
  }
}

/**
 * 上传头像文件到服务器。
 * @param {File} file - 图片文件
 * @returns {Promise<{ ok: boolean, url: string }>}
 */
export async function uploadAvatar(file) {
  const base = getApiBase();
  if (!base) {
    throw new Error('[apiClient] apiBase 未设置，请先调用 setApiBase()');
  }

  const formData = new FormData();
  formData.append('file', file);

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
 */
export async function silentSyncReaction(params) {
  try {
    const base = getApiBase();
    if (!base) return;
    return await syncReaction(params);
  } catch (e) {
    logError('apiClient/silentSyncReaction Reaction 同步失败', e, 'warn');
    return null;
  }
}

/**
 * 将相对路径的头像 URL（如 /uploads/xxx.png）拼接为完整 URL。
 * 如果已经是完整的 URL、base64 或为空，则直接返回原内容。
 * @param {string|null} avatarUrl
 * @returns {string|null}
 */
export function resolveAvatarUrl(avatarUrl) {
  if (!avatarUrl) return null;
  // base64 数据 URL 或已经是完整 URL，直接返回
  if (avatarUrl.startsWith('data:') || avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    return avatarUrl;
  }
  // 相对路径（如 /uploads/xxx.png）拼接 apiBase
  if (avatarUrl.startsWith('/')) {
    const base = getApiBase();
    return base ? `${base}${avatarUrl}` : avatarUrl;
  }
  return avatarUrl;
}
