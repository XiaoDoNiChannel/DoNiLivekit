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
export function createPresenceClient({ logError, onMessage }) {
    let socket = null;
    let identity = '';
    let displayName = '';
    let shouldReconnect = false;
    let reconnectTimer = null;
    let lastApiBase = '';
    // 保存最近一次的头像信息，供重连时使用
    let lastAvatarColor = '#5865f2';
    let lastAvatarPreset = '';
    let lastAvatarUrl = '';

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

    /** 发送 JSON 消息；连接未就绪时直接忽略。 */
    function send(payload) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(payload));
        return true;
    }

    /** 连接 Presence WebSocket。 */
    async function connect({ apiBase, username, identity: propIdentity, avatarColor, avatarPreset, avatarUrl }) {
        if (
            socket &&
            (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        ) {
            return;
        }

        const cleanName = String(username || '访客').trim();
        displayName = cleanName;
        // 优先使用传入的 identity，其次 sessionStorage，最后自动生成
        identity = propIdentity || sessionStorage.getItem('lk_presence_identity') || createIdentity(cleanName);
        sessionStorage.setItem('lk_presence_identity', identity);

        // 更新最新头像信息（供重连使用）
        if (avatarColor) lastAvatarColor = avatarColor;
        if (avatarPreset !== undefined) lastAvatarPreset = avatarPreset;
        if (avatarUrl !== undefined) lastAvatarUrl = avatarUrl;

        lastApiBase = apiBase;
        shouldReconnect = true;

        const wsBase = toWsBase(apiBase);
        const url = `${wsBase}/ws/presence?user=${encodeURIComponent(displayName)}&identity=${encodeURIComponent(identity)}&avatarColor=${encodeURIComponent(avatarColor || '#5865f2')}&avatarPreset=${encodeURIComponent(avatarPreset || '')}&avatarUrl=${encodeURIComponent(avatarUrl || '')}`;

        await new Promise((resolve, reject) => {
            socket = new WebSocket(url);

            socket.onopen = () => {
                console.log('[Presence] 已连接', url);
                setPresenceConnectionState({
                    connected: true,
                    identity,
                    displayName,
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
                    displayName,
                });

                socket = null;

                if (shouldReconnect && lastApiBase) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(() => {
                        // 重连时带上完整头像信息，避免服务端重新注册时头像丢失
                        connect({
                            apiBase: lastApiBase,
                            username: displayName,
                            identity,
                            avatarColor: lastAvatarColor,
                            avatarPreset: lastAvatarPreset,
                            avatarUrl: lastAvatarUrl,
                        }).catch((error) => {
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

        if (socket) {
            socket.close();
            socket = null;
        }

        resetPresenceStore();
    }

    /** 请求后端重新发送完整快照。 */
    function requestSnapshot() {
        return send({ type: 'request_snapshot' });
    }

    /** 通知后端：当前用户进入某个语音频道。 */
    function joinChannel(channelId) {
        return send({
            type: 'join_channel',
            channelId,
        });
    }

    /** 通知后端：当前用户离开语音频道，但仍在大厅。 */
    function leaveChannel() {
        return send({
            type: 'leave_channel',
        });
    }

    /** 当前 Presence identity，后续用于和 LiveKit token 保持一致。 */
    function getIdentity() {
        return identity;
    }

    /** 当前连接是否可用。 */
    function isConnected() {
        return !!socket && socket.readyState === WebSocket.OPEN;
    }

    /** 更新并广播当前用户的个人资料 */
    function updateProfile({ avatarColor, avatarPreset, avatarUrl }) {
        // 缓存最新头像信息，供重连时使用
        if (avatarColor) lastAvatarColor = avatarColor;
        if (avatarPreset !== undefined) lastAvatarPreset = avatarPreset;
        if (avatarUrl !== undefined) lastAvatarUrl = avatarUrl || '';
        return send({
            type: 'update_profile',
            avatarColor,
            avatarPreset,
            avatarUrl: avatarUrl || '',
        });
    }

    return {
        connect,
        disconnect,
        requestSnapshot,
        joinChannel,
        leaveChannel,
        getIdentity,
        isConnected,
        updateProfile,
    };
}