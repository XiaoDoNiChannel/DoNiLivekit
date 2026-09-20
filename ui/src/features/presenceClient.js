import {
    applyPresenceMessage,
    setPresenceConnectionState,
    resetPresenceStore,
} from '../stores/presenceStore.js';
import {
    buildPresenceRecoveryMessages,
    createPresenceSyncState,
    preparePresenceResync,
    reducePresenceProtocol,
} from './presenceProtocol.js';

const HEARTBEAT_INTERVAL_MS = 12_000;
const PONG_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Presence 长连接：heartbeat、有抖动退避、旧 socket 隔离和有序协议恢复。 */
export function createPresenceClient({ logError, onMessage, onConnectionChange, webSocketFactory } = {}) {
    let socket = null;
    let identity = '';
    let userId = '';
    let connectionId = '';
    let displayName = '';
    let lastConnectOptions = null;
    let shouldReconnect = false;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    let lastApiBase = '';
    let currentChannelId = null;
    let reconnectAttempt = 0;
    let lastPongAt = 0;
    let protocolState = createPresenceSyncState();

    const createSocket = webSocketFactory || ((url) => new WebSocket(url));

    function toWsBase(apiBase) {
        return String(apiBase || '').replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    }

    function createIdentity(username) {
        const safeName = String(username || '访客').trim() || '访客';
        if (window.crypto?.randomUUID) return `${safeName}-${window.crypto.randomUUID().slice(0, 8)}`;
        return `${safeName}-${Math.random().toString(16).slice(2, 10)}`;
    }

    function createConnectionId() {
        return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    }

    function sendOn(targetSocket, payload) {
        if (!targetSocket || targetSocket !== socket || targetSocket.readyState !== WebSocket.OPEN) return false;
        targetSocket.send(JSON.stringify(payload));
        return true;
    }

    function send(payload) {
        return sendOn(socket, payload);
    }

    function clearHeartbeat(targetSocket = null) {
        if (targetSocket && targetSocket !== socket) return;
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    function startHeartbeat(targetSocket) {
        clearHeartbeat();
        lastPongAt = Date.now();
        heartbeatTimer = setInterval(() => {
            if (targetSocket !== socket || targetSocket.readyState !== WebSocket.OPEN) return;
            const silenceMs = Date.now() - lastPongAt;
            if (silenceMs > PONG_TIMEOUT_MS) {
                console.warn('[Presence] pong 超时，主动重连', { silenceMs });
                try { targetSocket.close(4001, 'pong timeout'); } catch (_) {}
                return;
            }
            sendOn(targetSocket, { type: 'ping', clientTime: Date.now() });
        }, HEARTBEAT_INTERVAL_MS);
    }

    function scheduleReconnect() {
        if (!shouldReconnect || !lastApiBase || reconnectTimer) return;
        const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** reconnectAttempt));
        const jittered = Math.round(exponential * (0.75 + Math.random() * 0.5));
        const delayMs = Math.min(RECONNECT_MAX_MS, jittered);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect(lastConnectOptions || {
                apiBase: lastApiBase,
                username: displayName,
                identity,
                userId,
                connectionId,
            }).catch((error) => {
                logError?.('presenceClient/reconnect Presence 重连失败', error, 'warn');
                scheduleReconnect();
            });
        }, delayMs);
    }

    function publishConnectionState(connected) {
        setPresenceConnectionState({ connected, identity, userId, connectionId, displayName });
        onConnectionChange?.({ connected, identity, userId, connectionId, displayName, currentChannelId });
    }

    function handleProtocolMessage(message, targetSocket) {
        const result = reducePresenceProtocol(protocolState, message);
        protocolState = result.state;
        for (const orderedMessage of result.applyMessages) {
            applyPresenceMessage(orderedMessage);
            onMessage?.(orderedMessage);
        }
        if (result.requestSnapshot) sendOn(targetSocket, { type: 'request_snapshot' });
    }

    async function connect(options) {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

        const {
            apiBase,
            username,
            identity: propIdentity,
            userId: propUserId,
            connectionId: propConnectionId,
            avatarColor,
            avatarPreset,
            avatarUrl,
            statusText,
        } = options || {};
        const cleanName = String(username || '访客').trim();
        displayName = cleanName;
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
            const candidate = createSocket(url);
            socket = candidate;
            let opened = false;

            candidate.onopen = () => {
                if (socket !== candidate) return;
                opened = true;
                reconnectAttempt = 0;
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
                protocolState = preparePresenceResync(protocolState);
                startHeartbeat(candidate);
                publishConnectionState(true);
                for (const recoveryMessage of buildPresenceRecoveryMessages(currentChannelId)) {
                    sendOn(candidate, recoveryMessage);
                }
                console.log('[Presence] 已连接', url);
                resolve();
            };

            candidate.onmessage = (event) => {
                if (socket !== candidate) return;
                let message;
                try {
                    message = JSON.parse(event.data);
                } catch (error) {
                    logError?.('presenceClient/onmessage 解析 Presence 消息失败', error, 'warn');
                    return;
                }
                if (message.type === 'pong') {
                    lastPongAt = Date.now();
                    return;
                }
                handleProtocolMessage(message, candidate);
            };

            candidate.onerror = (event) => {
                if (socket !== candidate) return;
                logError?.('presenceClient/socket Presence 连接错误', event, 'warn');
                if (!opened) reject(new Error('Presence WebSocket 连接失败'));
                try { candidate.close(); } catch (_) {}
            };

            candidate.onclose = () => {
                if (socket !== candidate) return;
                clearHeartbeat(candidate);
                socket = null;
                protocolState = preparePresenceResync(protocolState);
                publishConnectionState(false);
                console.warn('[Presence] 连接已关闭');
                if (!opened) reject(new Error('Presence WebSocket 在建立前关闭'));
                scheduleReconnect();
            };
        });
    }

    function disconnect() {
        shouldReconnect = false;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        clearHeartbeat();
        currentChannelId = null;
        const current = socket;
        socket = null;
        if (current) {
            current.onopen = null;
            current.onmessage = null;
            current.onerror = null;
            current.onclose = null;
            try { current.close(); } catch (_) {}
        }
        protocolState = createPresenceSyncState();
        resetPresenceStore();
        onConnectionChange?.({ connected: false, identity, userId, connectionId, displayName, currentChannelId });
    }

    function requestSnapshot() { return send({ type: 'request_snapshot' }); }
    function joinChannel(channelId) {
        const cleanId = String(channelId || '').trim();
        if (!cleanId) return false;
        currentChannelId = cleanId;
        return send({ type: 'join_channel', channelId: cleanId });
    }
    function leaveChannel() {
        currentChannelId = null;
        return send({ type: 'leave_channel' });
    }
    function updateProfile({ displayName: nextDisplayName, avatarColor, avatarPreset, avatarUrl, statusText }) {
        if (nextDisplayName) displayName = String(nextDisplayName).trim() || displayName;
        return send({ type: 'update_profile', displayName, avatarColor, avatarPreset, avatarUrl: avatarUrl || '', statusText: statusText || '在线' });
    }

    return {
        connect,
        disconnect,
        requestSnapshot,
        joinChannel,
        leaveChannel,
        getIdentity: () => identity,
        getUserId: () => userId || identity,
        getConnectionId: () => connectionId,
        getCurrentChannel: () => currentChannelId,
        isConnected: () => !!socket && socket.readyState === WebSocket.OPEN,
        updateProfile,
        getDiagnostics: () => ({ reconnectAttempt, lastPongAt, protocolState: { ...protocolState } }),
    };
}
