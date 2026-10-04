// Serializable data only. Chat and media remain owned by the main window.
const clip = (value, limit = 80) => Array.from(String(value ?? '')).slice(0, limit).join('');
const metric = value => Number.isFinite(value) ? value : null;
export function buildTeamPanel({ app, presence, diagnostics, chat = {}, sharing = {}, chatConnected = false }) {
    const channelId = chat.currentChannelId || '';
    const channel = presence.channels?.find(row => row.id === channelId || row.name === channelId);
    const connected = app.connection.isConnected;
    return {
        chatChannelId: channelId,
        chatChannel: clip(channel?.displayName || channel?.name || channelId || '未选择聊天频道'),
        chatConnected,
        unread: chat.notifications?.[channelId]?.unread || 0,
        mentions: chat.notifications?.[channelId]?.mentions || 0,
        messages: (chat.messages || []).filter(row => row.channelId === channelId).slice(-30).map(row => ({
            id: clip(row.id, 160), sender: clip(row.senderName), content: clip(row.content, 2000),
            timestamp: row.timestamp, self: !!row.isSelf, status: row.status || 'sent', truncated: Array.from(row.content || '').length > 2000,
        })),
        members: connected ? (presence.voiceMembers || []).slice(0, 100).map(member => {
            const voice = [member.identity, member.userId, member.connectionId, member.displayName]
                .map(key => presence.voiceStates?.[key]).find(Boolean) || {};
            return { identity: clip(member.identity, 160), name: clip(member.displayName || member.identity),
                self: !!voice.isSelf, micOn: !!voice.micOpen, audio: !!voice.hasAppAudio,
                volumeIdentity: clip(voice.volumeIdentity || member.identity, 160),
                micVolume: voice.micVolumePercent ?? 100, audioVolume: voice.appAudioVolumePercent ?? 100 };
        }) : [],
        memberCount: connected ? (presence.voiceMembers || []).length : 0,
        shares: connected ? (sharing.shares || []).map(row => ({
            id: clip(row.signature || `${row.identity}:${row.kind}`, 240), name: clip(row.displayName), kind: row.kind,
        })).slice(0, 100) : [],
        micLevel: connected && app.media.micOn && app.media.micSource === 'rust' ? Math.round(app.media.micLevel || 0) : null,
        rttMs: metric(diagnostics.rttMs), lossPercent: metric(diagnostics.voice?.lossPercent),
        jitterMs: metric(diagnostics.voice?.jitterMs), diagnosticsAt: diagnostics.updatedAt,
        availability: diagnostics.availability || 'idle',
        issues: (diagnostics.issues || []).slice(0, 4).map(row => ({ title: clip(row.title), detail: clip(row.detail, 240) })),
    };
}

// Reconnects establish a new baseline, rather than reporting everybody leaving/joining.
export function createTeamActivity({ now = Date.now } = {}) {
    let scope = '', previous = null, events = [], sequence = 0;
    function add(text, kind) { events.push({ id: ++sequence, text, kind, timestamp: now() }); }
    function names(rows) { return rows.slice(0, 3).map(row => row.name).join('、') + (rows.length > 3 ? ` 等 ${rows.length} 人` : ''); }
    return { update(snapshot) {
        const key = `${snapshot.session}:${snapshot.channel}`;
        if (key !== scope) { scope = key; previous = null; events = []; }
        const panel = snapshot.panel;
        if (!snapshot.connected || snapshot.reconnecting) { previous = null; return events.slice(); }
        const members = new Map(panel.members.map(row => [row.identity, row]));
        const shares = new Map(panel.shares.map(row => [row.id, row]));
        if (snapshot.screenOn) shares.set('self-screen', { name: '你', kind: 'screen' });
        if (snapshot.appAudioOn) shares.set('self-audio', { name: '你', kind: 'appaudio' });
        if (previous) {
            const joined = [...members.values()].filter(row => !previous.members.has(row.identity));
            const left = [...previous.members.values()].filter(row => !members.has(row.identity));
            if (joined.length) add(`${names(joined)} 加入频道`, 'join');
            if (left.length) add(`${names(left)} 离开频道`, 'leave');
            for (const [id, row] of shares) if (!previous.shares.has(id)) add(`${row.name} 开始共享${row.kind === 'screen' ? '屏幕' : '程序音频'}`, 'share');
            for (const [id, row] of previous.shares) if (!shares.has(id)) add(`${row.name} 结束共享${row.kind === 'screen' ? '屏幕' : '程序音频'}`, 'share');
        }
        previous = { members, shares };
        events = events.slice(-30);
        return events.slice();
    } };
}

export function validateTeamAction(state, request, now = Date.now()) {
    if (!Number.isFinite(request.deadline) || now > request.deadline) throw Error('操作已过期，请重试');
    if (state.session !== request.session) throw Error('频道状态已变化，请重试');
    const panel = state.panel;
    if (['chat', 'read'].includes(request.kind)) {
        if (!request.channelId || request.channelId !== panel.chatChannelId) throw Error('聊天频道已变化，请重试');
        if (request.kind === 'chat' && (!panel.chatConnected || typeof request.content !== 'string' || !request.content.trim() || Array.from(request.content).length > 2000)) throw Error('消息为空、过长或聊天连接已断开');
    } else if (request.kind === 'volume') {
        if (!state.connected || state.reconnecting) throw Error('语音连接已变化');
        if (!['mic', 'appaudio'].includes(request.source) || !Number.isFinite(request.value) || request.value < 0 || request.value > 300
            || !panel.members.some(row => !row.self && row.volumeIdentity === request.identity)) throw Error('成员或音量无效');
    } else throw Error('未知浮窗操作');
}
