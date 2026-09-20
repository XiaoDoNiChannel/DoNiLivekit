const DIFF_TYPES = new Set([
    'participant_online',
    'participant_offline',
    'participant_moved',
    'profile_updated',
]);

export function createPresenceSyncState() {
    return {
        lastEpoch: '',
        lastSeq: 0,
        hasSnapshot: false,
        pendingDiffs: [],
    };
}

export function preparePresenceResync(state = createPresenceSyncState()) {
    return {
        ...state,
        hasSnapshot: false,
        pendingDiffs: [],
    };
}

export function isPresenceStateMessage(message) {
    return message?.type === 'presence_snapshot' || DIFF_TYPES.has(message?.type);
}

function normalizeVersion(message) {
    const epoch = String(message?.serverEpoch || '').trim();
    const seq = Number(message?.seq);
    if (!epoch || !Number.isSafeInteger(seq) || seq < 0) return null;
    return { epoch, seq };
}

function enqueueDiff(pendingDiffs, message, epoch, minSeq = -1) {
    const bySeq = new Map();
    for (const candidate of [...pendingDiffs, message]) {
        const version = normalizeVersion(candidate);
        if (!version || version.epoch !== epoch || version.seq <= minSeq) continue;
        bySeq.set(version.seq, candidate);
    }
    return [...bySeq.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
}

/**
 * Presence 有序协议纯状态机。
 * 返回的 applyMessages 已按可安全应用的顺序排列；调用者只需依次写入 store。
 */
export function reducePresenceProtocol(currentState, message) {
    const state = currentState || createPresenceSyncState();
    if (!isPresenceStateMessage(message)) {
        return { state, applyMessages: [message], requestSnapshot: false, ignored: false };
    }

    const version = normalizeVersion(message);
    if (!version) {
        return { state, applyMessages: [], requestSnapshot: true, ignored: true };
    }

    const epochChanged = !!state.lastEpoch && state.lastEpoch !== version.epoch;
    const base = epochChanged
        ? createPresenceSyncState()
        : { ...state, pendingDiffs: [...(state.pendingDiffs || [])] };
    base.lastEpoch = version.epoch;

    if (message.type !== 'presence_snapshot') {
        if (!base.hasSnapshot) {
            base.pendingDiffs = enqueueDiff(base.pendingDiffs, message, version.epoch, base.lastSeq);
            return {
                state: base,
                applyMessages: [],
                requestSnapshot: true,
                ignored: false,
                epochChanged,
            };
        }

        if (version.seq <= base.lastSeq) {
            return { state: base, applyMessages: [], requestSnapshot: false, ignored: true, epochChanged };
        }

        if (version.seq !== base.lastSeq + 1) {
            base.pendingDiffs = enqueueDiff(base.pendingDiffs, message, version.epoch, base.lastSeq);
            return { state: base, applyMessages: [], requestSnapshot: true, ignored: false, epochChanged };
        }

        base.lastSeq = version.seq;
        return { state: base, applyMessages: [message], requestSnapshot: false, ignored: false, epochChanged };
    }

    // 已同步时，旧 snapshot 不能回滚后来已经应用的 diff。
    if (base.hasSnapshot && version.seq <= base.lastSeq) {
        return { state: base, applyMessages: [], requestSnapshot: false, ignored: true, epochChanged };
    }

    const applyMessages = [message];
    base.hasSnapshot = true;
    base.lastSeq = version.seq;

    const pending = enqueueDiff(base.pendingDiffs, null, version.epoch, version.seq);
    const remaining = [];
    let gapDetected = false;

    for (const diff of pending) {
        const diffSeq = Number(diff.seq);
        if (!gapDetected && diffSeq === base.lastSeq + 1) {
            applyMessages.push(diff);
            base.lastSeq = diffSeq;
        } else if (diffSeq > base.lastSeq) {
            gapDetected = true;
            remaining.push(diff);
        }
    }

    base.pendingDiffs = remaining;
    return {
        state: base,
        applyMessages,
        requestSnapshot: gapDetected,
        ignored: false,
        epochChanged,
    };
}

/** 重连后只生成一组恢复动作，避免重复 join 导致重复成员。 */
export function buildPresenceRecoveryMessages(channelId) {
    const cleanChannel = String(channelId || '').trim();
    return [
        ...(cleanChannel ? [{ type: 'join_channel', channelId: cleanChannel }] : []),
        { type: 'request_snapshot' },
    ];
}
