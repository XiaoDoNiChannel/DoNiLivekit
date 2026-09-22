/**
 * DoNiChannel Chat WebSocket 客户端（Phase 2）。
 *
 * 职责：
 * - 建立独立 /ws/chat 通道
 * - 频道订阅
 * - 消息发送 / ACK / 广播接收
 * - Reaction / Pin 同步
 * - 断线重连
 */
const CONNECT_TIMEOUT_MS = 3000;
const ACK_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 12_000;
const PONG_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function createChatClient({ logError, onMessage, onConnectionChange, onMessageFailed, webSocketFactory } = {}) {
  let socket = null;
  let connectionAttempt = null;
  let shouldReconnect = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let heartbeatTimer = null;
  let pongTimer = null;
  const pendingMessages = new Map();
  const createSocket = webSocketFactory || ((url) => new WebSocket(url));
  let lastConnectOptions = null;
  // currentChannelId 表示前端希望订阅的频道；confirmed/pending 用于避免重复订阅。
  let currentChannelId = null;
  let confirmedChannelId = null;
  let pendingSubscribeChannelId = null;

  let userId = '';
  let connectionId = '';
  let identity = '';
  let displayName = '';
  let avatarColor = '#5865f2';
  let avatarPreset = '';
  let avatarUrl = '';

  function toWsBase(apiBase) {
    return String(apiBase || '').replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  }

  function isConnected() {
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  function getReadyState() {
    if (!socket) return WebSocket.CLOSED;
    return socket.readyState;
  }

  function getDebugState() {
    const state = getReadyState();
    return {
      connected: isConnected(),
      readyState: state,
      readyStateText: state === WebSocket.CONNECTING ? 'CONNECTING' : state === WebSocket.OPEN ? 'OPEN' : state === WebSocket.CLOSING ? 'CLOSING' : 'CLOSED',
      shouldReconnect,
      hasLastConnectOptions: !!lastConnectOptions,
      currentChannelId,
      confirmedChannelId,
      pendingSubscribeChannelId,
      userId,
      connectionId,
      identity,
      displayName,
    };
  }

  function boundedWait(promise, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), connectionTimeout(timeoutMs));
      promise.then((connected) => {
        clearTimeout(timer);
        resolve(connected);
      });
    });
  }

  function connectionTimeout(timeoutMs) {
    return Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : CONNECT_TIMEOUT_MS;
  }

  function waitUntilConnected(timeoutMs = CONNECT_TIMEOUT_MS) {
    if (isConnected()) return Promise.resolve(true);
    if (!connectionAttempt) return Promise.resolve(false);
    return boundedWait(connectionAttempt.promise, timeoutMs);
  }

  function ensureConnected(options = {}, timeoutMs = CONNECT_TIMEOUT_MS) {
    if (isConnected()) return Promise.resolve(true);
    const connectOptions = { ...(lastConnectOptions || {}), ...(options || {}) };
    // 从调用开始计时；并发调用共享握手，但较短的调用期限不会取消其他等待者。
    return boundedWait(connect(connectOptions, timeoutMs), timeoutMs);
  }

  function scheduleReconnect() {
    if (!shouldReconnect || !lastConnectOptions?.apiBase || reconnectTimer !== null) return;
    const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** reconnectAttempt));
    const delayMs = Math.min(RECONNECT_MAX_MS, Math.round(exponential * (0.75 + Math.random() * 0.5)));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(lastConnectOptions);
    }, delayMs);
  }

  function clearHeartbeat() {
    clearTimeout(heartbeatTimer);
    clearTimeout(pongTimer);
    heartbeatTimer = null;
    pongTimer = null;
  }

  function startHeartbeat(candidate) {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (socket !== candidate) return;
      // 先登记期限；即使浏览器始终不触发 close，黑洞连接也会被淘汰。
      pongTimer = setTimeout(() => retireSocket(candidate, 'pong_timeout'), PONG_TIMEOUT_MS);
      if (!send({ type: 'ping', clientTime: Date.now() })) retireSocket(candidate, 'send_failed');
    }, HEARTBEAT_INTERVAL_MS);
  }

  function clearPendingMessage(clientMessageId) {
    const pending = pendingMessages.get(clientMessageId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingMessages.delete(clientMessageId);
    return true;
  }

  function failPendingMessage(clientMessageId, reason) {
    if (clearPendingMessage(clientMessageId)) onMessageFailed?.({ clientMessageId, reason });
  }

  function retireSocket(candidate, reason) {
    if (socket !== candidate) return;
    // 先失效再 close，所有迟到的回调只能作用于原 socket。
    socket = null;
    connectionAttempt?.finish(false);
    clearHeartbeat();
    confirmedChannelId = null;
    pendingSubscribeChannelId = null;
    try { candidate.close(); } catch (_) {}
    scheduleReconnect();
    for (const clientMessageId of Array.from(pendingMessages.keys())) {
      failPendingMessage(clientMessageId, reason);
    }
    emitConnectionState(false);
  }

  function emitConnectionState(connected) {
    onConnectionChange?.({
      connected,
      userId,
      connectionId,
      identity,
      displayName,
      currentChannelId,
    });
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      logError?.('chatClient/send 发送 Chat 消息失败', error, 'warn');
      return false;
    }
  }

  // 每次握手的所有出口都 resolve boolean，不留下无人处理的 rejection。
  function connect(options = {}, timeoutMs = CONNECT_TIMEOUT_MS) {
    if (isConnected()) return Promise.resolve(true);
    if (connectionAttempt) return connectionAttempt.promise;
    if (socket) retireSocket(socket, 'connection_closed');

    const apiBase = options.apiBase;
    if (!apiBase) {
      logError?.('chatClient/connect 缺少 apiBase，跳过连接', null, 'warn');
      return Promise.resolve(false);
    }

    userId = String(options.userId || options.identity || '').trim();
    connectionId = String(options.connectionId || '').trim();
    identity = String(options.identity || userId || '').trim();
    displayName = String(options.displayName || options.username || '访客').trim() || '访客';
    avatarColor = String(options.avatarColor || '#5865f2');
    avatarPreset = String(options.avatarPreset || '');
    avatarUrl = String(options.avatarUrl || '');
    const statusText = String(options.statusText || '在线');

    if (!userId) userId = identity || displayName;
    if (!identity) identity = userId;
    if (!connectionId) connectionId = `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    lastConnectOptions = {
      ...options,
      userId,
      connectionId,
      identity,
      displayName,
      avatarColor,
      avatarPreset,
      avatarUrl,
      statusText,
    };
    shouldReconnect = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    const wsBase = toWsBase(apiBase);
    const params = new URLSearchParams({
      user: displayName,
      userId,
      connectionId,
      identity,
      avatarColor,
      avatarPreset,
      avatarUrl,
      statusText,
    });
    const url = `${wsBase}/ws/chat?${params.toString()}`;

    let candidate;
    try {
      candidate = createSocket(url);
    } catch (error) {
      scheduleReconnect();
      logError?.('chatClient/connect 创建 Chat 连接失败', error, 'warn');
      return Promise.resolve(false);
    }
    socket = candidate;
    let resolveAttempt;
    const promise = new Promise((resolve) => { resolveAttempt = resolve; });
    const attempt = {
      promise,
      finish(connected) {
        if (connectionAttempt !== attempt) return;
        clearTimeout(attempt.timer);
        connectionAttempt = null;
        resolveAttempt(connected);
      },
      timer: setTimeout(() => retireSocket(candidate, 'connect_timeout'), connectionTimeout(timeoutMs)),
    };
    connectionAttempt = attempt;

    candidate.onopen = () => {
      if (socket !== candidate) return;
      attempt.finish(true);
      reconnectAttempt = 0;
      startHeartbeat(candidate);
      console.log('[Chat] 已连接', url);
      confirmedChannelId = null;
      pendingSubscribeChannelId = null;
      emitConnectionState(true);

      if (currentChannelId) {
        subscribeChannel(currentChannelId, { force: true });
      } else {
        send({ type: 'request_state' });
      }
    };

    candidate.onmessage = (event) => {
      if (socket !== candidate) return;
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        logError?.('chatClient/onmessage 解析 Chat 消息失败', error, 'warn');
        return;
      }

      if (!message || typeof message !== 'object') return;
      if (message.type === 'pong') {
        if (pongTimer !== null) startHeartbeat(candidate);
        return;
      }
      if (message.type === 'message_ack') {
        clearPendingMessage(message.clientMessageId);
      } else if (message.type === 'message_created' && message.message) {
        // 服务器广播同样证明消息已持久化；避免随后 ACK 超时覆盖 sent。
        clearPendingMessage(message.message.clientMessageId);
      }

      if (message.type === 'chat_subscribed') {
        confirmedChannelId = message.channelId || null;
        currentChannelId = confirmedChannelId;
        if (pendingSubscribeChannelId === confirmedChannelId) {
          pendingSubscribeChannelId = null;
        }
      }

      onMessage?.(message);
    };

    candidate.onerror = (event) => {
      if (socket !== candidate) return;
      retireSocket(candidate, 'connection_error');
      logError?.('chatClient/socket Chat 连接错误', event, 'warn');
    };

    candidate.onclose = () => {
      if (socket !== candidate) return;
      console.warn('[Chat] 连接已关闭');
      retireSocket(candidate, 'connection_closed');
    };
    return promise;
  }

  function disconnect() {
    shouldReconnect = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;

    if (socket) {
      retireSocket(socket, 'disconnected');
    } else {
      emitConnectionState(false);
    }
  }

  function subscribeChannel(channelId, options = {}) {
    const nextChannelId = String(channelId || '').trim() || null;
    const force = !!options.force;

    currentChannelId = nextChannelId;

    if (!nextChannelId) {
      confirmedChannelId = null;
      pendingSubscribeChannelId = null;
      return send({ type: 'unsubscribe_channel' });
    }

    // Phase 2.2：如果已经确认订阅或正在等待同一频道的订阅确认，不重复发送 subscribe。
    if (!force && (confirmedChannelId === nextChannelId || pendingSubscribeChannelId === nextChannelId)) {
      return true;
    }

    if (!isConnected()) return false;

    pendingSubscribeChannelId = nextChannelId;
    const ok = send({ type: 'subscribe_channel', channelId: nextChannelId });
    if (!ok) pendingSubscribeChannelId = null;
    return ok;
  }

  function requestState() {
    return send({ type: 'request_state' });
  }

  function ping() {
    return send({ type: 'ping' });
  }

  function sendMessage({ clientMessageId, channelId, content, senderColor, senderPreset, senderAvatarUrl }) {
    if (!clientMessageId || !isConnected()) return false;
    if (pendingMessages.has(clientMessageId)) return true;
    pendingMessages.set(clientMessageId, {
      timer: setTimeout(() => failPendingMessage(clientMessageId, 'ack_timeout'), ACK_TIMEOUT_MS),
    });
    const sent = send({
      type: 'send_message',
      clientMessageId,
      channelId: channelId || currentChannelId,
      content,
      senderColor: senderColor || avatarColor,
      senderPreset: senderPreset ?? avatarPreset,
      senderAvatarUrl: senderAvatarUrl ?? avatarUrl,
    });
    if (!sent) clearPendingMessage(clientMessageId);
    // true 仅表示已写入 socket，送达由 ACK / 广播决定。
    return sent;
  }

  function toggleReaction({ messageId, emoji, channelId }) {
    return send({
      type: 'toggle_reaction',
      messageId,
      emoji,
      channelId: channelId || currentChannelId,
    });
  }

  return {
    connect,
    disconnect,
    subscribeChannel,
    requestState,
    ping,
    send,
    sendMessage,
    toggleReaction,
    isConnected,
    waitUntilConnected,
    ensureConnected,
    getReadyState,
    getDebugState,
    getCurrentChannel: () => currentChannelId,
    getConfirmedChannel: () => confirmedChannelId,
    getUserId: () => userId,
    getConnectionId: () => connectionId,
    getIdentity: () => identity,
  };
}
