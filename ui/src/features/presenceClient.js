import {
    applyPresenceMessage,
    setPresenceConnectionState,
    resetPresenceStore,
} from '../stores/presenceStore.js';

/**
 * 创建 Presence WebSocket 客户端。
 *
 * 负责：
 * 1. 进入大厅时连接 /ws/presence。
 * 2. 接收后端 snapshot / moved / offline 等消息。
 * 3. 用户切频道时发送 join_channel。
 * 4. 离开频道时发送 leave_channel。
 */
export function createPresenceClient({ logError, onMessage, onConnectionChange } = {}) {
    let socket = null;
    let identity = '';
    let userId = '';
    let connectionId = '';
    let displayName = '';
    let lastConnectOptions = null;
    let shouldReconnect = false;
    let reconnectTimer = null;
    let lastApiBase = '';
    let currentChannelId = null;

    /** 将 http://host:5000 转成 ws://host:5000。 */
    function toWsBase(apiBase) {
        return String(apiBase || '').replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    }

    /** 为本次前端会话生成稳定 identity，方便 Presence 和 LiveKit 使用同一个身份。 */
    function createIdentity(username) {
        const safeName = String(username || '访客').trim() || '访客';

        if (window.crypto?.randomUUID) {
            return `${safeName}-${window.crypto.randomUUID().slice(0, 8)}`;
        }

        return `${safeName}-${Math.random().toString(16).slice(2, 10)}`;
    }

    /** 为本次前端会话生成 connectionId。 */
    function createConnectionId() {
        return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    }

    /** 发送 JSON 消息；连接未就绪时直接忽略。 */
    function send(payload) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(payload));
        return true;
    }

    /** 连接 Presence WebSocket。 */
    async function connect({ apiBase, username, identity: propIdentity, userId: propUserId, connectionId: propConnectionId, avatarColor, avatarPreset, avatarUrl, statusText }) {
        if (
            socket &&
            (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        const cleanName = String(username || '访客').trim();
        displayName = cleanName;
        // userId 是长期身份；identity 保持旧 LiveKit/Presence 兼容；connectionId 是本次连接身份。
        userId = propUserId || propIdentity || sessionStorage.getItem('lk_presence_user_id') || '';
        identity = propIdentity || userId || sessionStorage.getItem('lk_presence_identity') || createIdentity(cleanName);
        connectionId = propConnectionId || sessionStorage.getItem('lk_presence_connection_id') || createConnectionId();

        if (!userId) userId = identity;
        sessionStorage.setItem('lk_presence_user_id', userId);
        sessionStorage.setItem('lk_presence_identity', identity);
        sessionStorage.setItem('lk_presence_connection_id', connectionId);

        lastApiBase = apiBase;
        shouldReconnect = true;
        lastConnectOptions = { apiBase, username: displayName, identity, userId, connectionId, avatarColor, avatarPreset, avatarUrl, statusText };

        const wsBase = toWsBase(apiBase);
        const url = `${wsBase}/ws/presence?user=${encodeURIComponent(displayName)}&identity=${encodeURIComponent(identity)}&userId=${encodeURIComponent(userId)}&connectionId=${encodeURIComponent(connectionId)}&avatarColor=${encodeURIComponent(avatarColor || '#5865f2')}&avatarPreset=${encodeURIComponent(avatarPreset || '')}&avatarUrl=${encodeURIComponent(avatarUrl || '')}&statusText=${encodeURIComponent(statusText || '在线')}`;

        await new Promise((resolve, reject) => {
            socket = new WebSocket(url);

            socket.onopen = () => {
                console.log('[Presence] 已连接', url);
                setPresenceConnectionState({
                    connected: true,
                    identity,
                    userId,
                    connectionId,
                    displayName,
                });
                onConnectionChange?.({
                    connected: true,
                    identity,
                    userId,
                    connectionId,
                    displayName,
                    currentChannelId,
                });
                resolve();
            };

            socket.onmessage = (event) => {
                let message = null;

                try {
                    message = JSON.parse(event.data);
                } catch (error) {
                    logError?.('presenceClient/onmessage 解析 Presence 消息失败', error, 'warn');
                    return;
                }

                applyPresenceMessage(message);
                onMessage?.(message);
            };

            socket.onerror = (event) => {
                logError?.('presenceClient/socket Presence 连接错误', event, 'warn');
            };

            socket.onclose = () => {
                console.warn('[Presence] 连接已关闭');

                setPresenceConnectionState({
                    connected: false,
                    identity,
                    userId,
                    connectionId,
                    displayName,
                });
                onConnectionChange?.({
                    connected: false,
                    identity,
                    userId,
                    connectionId,
                    displayName,
                    currentChannelId,
                });

                socket = null;

                if (shouldReconnect && lastApiBase) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(() => {
                        connect(lastConnectOptions || { apiBase: lastApiBase, username: displayName, identity, userId, connectionId }).catch((error) => {
                            logError?.('presenceClient/reconnect Presence 重连失败', error, 'warn');
                        });
                    }, 1500);
                }
            };
        });
    }

    /** 主动断开 Presence。 */
    function disconnect() {
        shouldReconnect = false;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        currentChannelId = null;

        if (socket) {
            socket.close();
            socket = null;
        }

        resetPresenceStore();
        onConnectionChange?.({
            connected: false,
            identity,
            userId,
            connectionId,
            displayName,
            currentChannelId,
        });
    }

    /** 请求后端重新发送完整快照。 */
    function requestSnapshot() {
        return send({ type: 'request_snapshot' });
    }

    /** 通知后端：当前用户进入某个语音频道。 */
    function joinChannel(channelId) {
        const cleanId = String(channelId || '').trim();
        if (!cleanId) return false;

        currentChannelId = cleanId;
        return send({
            type: 'join_channel',
            channelId: cleanId,
        });
    }

    /** 通知后端：当前用户离开语音频道，但仍在大厅。 */
    function leaveChannel() {
        currentChannelId = null;
        return send({
            type: 'leave_channel',
        });
    }

    /** 当前 Presence identity，后续用于和 LiveKit token 保持一致。 */
    function getIdentity() {
        return identity;
    }

    function getUserId() {
        return userId || identity;
    }

    function getConnectionId() {
        return connectionId;
    }

    /** 当前连接是否可用。 */
    function isConnected() {
        return !!socket && socket.readyState === WebSocket.OPEN;
    }

    /** 更新并广播当前用户的个人资料 */
    function updateProfile({ displayName: nextDisplayName, avatarColor, avatarPreset, avatarUrl, statusText }) {
        if (nextDisplayName) displayName = String(nextDisplayName).trim() || displayName;
        return send({
            type: 'update_profile',
            displayName: displayName || nextDisplayName || '',
            avatarColor,
            avatarPreset,
            avatarUrl: avatarUrl || '',
            statusText: statusText || '在线',
        });
    }

    return {
        connect,
        disconnect,
        requestSnapshot,
        joinChannel,
        leaveChannel,
        getIdentity,
        getUserId,
        getConnectionId,
        getCurrentChannel: () => currentChannelId,
        isConnected,
        updateProfile,
    };
}