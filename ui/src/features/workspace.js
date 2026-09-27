/** Acknowledged commands; all authoritative cards arrive in versioned Presence snapshots. */
export function createWorkspaceFeature({ store, send, schedule = setTimeout, unschedule = clearTimeout }) {
    let sequence = 0;
    const pending = new Map();
    function receive(message) {
        if (message.type === 'presence_snapshot') {
            store.supported = message.workspaceVersion === 1;
            store.cards = store.supported && Array.isArray(message.partyCards) ? message.partyCards : [];
        }
        if (message.type !== 'workspace_result') return;
        const entry = pending.get(message.requestId);
        if (!entry) return;
        pending.delete(message.requestId); unschedule(entry.timer);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error || '大厅操作失败'));
    }
    function disconnect() {
        for (const entry of pending.values()) { unschedule(entry.timer); entry.reject(new Error('连接已断开，操作结果未确认，请重连后检查列表')); }
        pending.clear(); store.supported = false; store.cards = [];
    }
    async function run(action, values) {
        if (store.busy) return null;
        store.error = '';
        if (!store.supported) { store.error = '请先连接大厅；组队功能需要更新后的服务端。'; return null; }
        store.busy = true;
        const requestId = `workspace_${Date.now()}_${++sequence}`;
        try {
            return await new Promise((resolve, reject) => {
                const timer = schedule(() => { pending.delete(requestId); reject(new Error('服务端未确认操作，请检查列表后再试')); }, 10000);
                pending.set(requestId, { resolve, reject, timer });
                try {
                    if (!send({ type: 'workspace_command', requestId, action, values })) throw new Error('大厅连接已断开');
                } catch (error) { pending.delete(requestId); unschedule(timer); reject(error); }
            });
        } catch (error) { store.error = error.message || String(error); return null; }
        finally { store.busy = false; }
    }
    return { receive, run, disconnect };
}

export function onlineInterests(card, participants) {
    const online = new Map(Object.values(participants || {}).map(p => [p.userId || p.identity, p]));
    return (card.interests || []).filter(p => online.has(p.userId)).map(p => ({ ...p, displayName: online.get(p.userId).displayName || p.displayName }));
}

/** One exclusive panel value avoids hidden flags contradicting each other. */
export function workspaceLayout({ watching, sameVoice, panel }) {
    const showWatch = !!watching && !!sameVoice;
    return { watch: showWatch, chat: !showWatch || panel === 'chat', cards: panel === 'cards', sideChat: showWatch && panel === 'chat' };
}
