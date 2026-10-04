import { buildTeamPanel, validateTeamAction } from './overlayTeam.js';
const text = (value, limit = 60) => Array.from(String(value || '')).slice(0, limit).join('');

export function buildOverlaySnapshot({ app, presence, diagnostics, theme, session, connectionState, chat, sharing, chatConnected }) {
    const connected = connectionState === 'connected';
    const reconnecting = ['reconnecting', 'signalReconnecting'].includes(connectionState);
    const speaking = connected ? (presence.voiceMembers || []).filter(member => {
        const keys = [member.identity, member.userId, member.connectionId, member.displayName].filter(Boolean);
        const voice = keys.map(key => presence.voiceStates?.[key]).find(Boolean);
        return voice?.micOpen !== false && keys.some(key => presence.speakingIdentities?.[key]);
    }) : [];
    const channel = presence.channels?.find(item => item.id === app.connection.currentChannel || item.name === app.connection.currentChannel);
    return {
        session, connected, reconnecting,
        channel: text(channel?.displayName || channel?.name || app.connection.currentChannel || '未加入频道'),
        panel: buildTeamPanel({ app: { ...app, connection: { ...app.connection, isConnected: connected } }, presence, diagnostics, chat, sharing, chatConnected }),
        micOn: connected && !!app.media.micOn,
        screenOn: connected && !!app.media.screenOn,
        appAudioOn: connected && !!app.media.appAudioSharing,
        speakers: speaking.slice(0, 3).map(member => text(member.displayName || member.identity || '成员')),
        speakerCount: speaking.length,
        networkText: connected && diagnostics.issues?.length ? text(diagnostics.issues[0].title, 40) : '',
        networkWarning: connected && !!diagnostics.issues?.length,
        theme: text(theme || 'doni-dark', 40),
    };
}

/** Main webview owns all connections. This bridge forwards only serializable display state. */
export function createOverlayOwner({ invoke, listen, getSnapshot, toggleMic, sendChat, markRead, setVolume, onError = () => {}, now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
    let running = false, disposed = false, publishing = false, dirty = false, timer = null, acting = false;
    const unlisteners = [];
    function changed() {
        dirty = true;
        if (!running || timer !== null || publishing) return;
        timer = schedule(() => { timer = null; void publish(); }, 100);
    }
    async function publish() {
        if (!running) return;
        if (publishing) { dirty = true; return; }
        publishing = true; dirty = false;
        try { await invoke('overlay_publish', { snapshot: getSnapshot() }); }
        catch (error) { onError(String(error)); }
        finally { publishing = false; if (dirty) changed(); }
    }
    async function handleMic(request) {
        if (!running || !request || !Number.isSafeInteger(request.id)) return;
        let error = null, ownsAction = false;
        try {
            const state = getSnapshot();
            if (acting) throw Error('麦克风操作尚未完成');
            if (!Number.isFinite(request.deadline) || now() > request.deadline) throw Error('操作已过期，请重试');
            if (!state.connected || state.reconnecting || state.session !== request.session || typeof request.enabled !== 'boolean') throw Error('频道状态已变化，请重试');
            acting = true; ownsAction = true;
            if (state.micOn !== request.enabled) await toggleMic();
            const after = getSnapshot();
            if (!after.connected || after.session !== request.session || after.micOn !== request.enabled) throw Error('麦克风状态未确认，请在主界面检查');
            await publish();
        } catch (reason) { error = String(reason?.message || reason); }
        finally {
            if (ownsAction) acting = false;
            try { await invoke('overlay_mic_result', { id: request.id, error }); } catch (_) { /* Owner may be shutting down. */ }
        }
    }
    async function handleAction(request) {
        if (!running || !request || !Number.isSafeInteger(request.id)) return;
        let error = null, ownsAction = false;
        try {
            if (acting) throw Error('浮窗操作尚未完成');
            validateTeamAction(getSnapshot(), request, now());
            acting = true; ownsAction = true;
            if (request.kind === 'chat') {
                if (!await sendChat(request.content, request.channelId)) throw Error('消息未发送，请在消息列表检查状态');
            } else if (request.kind === 'read') await markRead(request.channelId);
            else await setVolume(request.identity, request.source, request.value);
            await publish();
        } catch (reason) { error = String(reason?.message || reason); }
        finally {
            if (ownsAction) acting = false;
            try { await invoke('overlay_action_result', { id: request.id, error }); } catch (_) { /* Owner closed. */ }
        }
    }
    async function start() {
        if (running || disposed) return;
        for (const [event, handler] of [['overlay-poll', () => void publish()], ['overlay-mic-request', event => void handleMic(event.payload)], ['overlay-action-request', event => void handleAction(event.payload)]]) {
            const unlisten = await listen(event, handler);
            if (disposed) { unlisten?.(); return; }
            unlisteners.push(unlisten);
        }
        running = true;
        await publish();
    }
    function dispose() { disposed = true; running = false; dirty = false; if (timer !== null) unschedule(timer); unlisteners.splice(0).forEach(fn => fn?.()); }
    return { start, changed, publish, handleMic, handleAction, dispose };
}

export function acceptOverlayPacket(previous, next) {
    if (!next || !Number.isSafeInteger(next.sequence) || !next.snapshot) return previous;
    if (previous && next.sequence < previous.sequence) return previous;
    // Same sequence may carry a fresh=false reply from the native freshness check.
    return next;
}
