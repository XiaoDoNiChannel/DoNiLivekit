// Publication objects stay here; only serializable display state enters the store.
export function publicationKind(pub, track = pub?.track) {
    const source = String(pub?.source || track?.source || '').replaceAll('-', '_');
    if (source === 'screen_share' && pub?.kind !== 'audio') return 'screen';
    const names = [pub?.trackName, pub?.name, track?.name, track?.mediaStreamTrack?.label]
        .filter(Boolean).join('|').toLowerCase().replace(/[\s_]+/g, '-');
    if (['app-audio', 'appaudio', 'application-audio', 'process-audio', 'system-audio', 'window-audio'].some(n => names.includes(n))) return 'appaudio';
    // Old clients' native display audio must never be mistaken for microphone audio.
    if (source === 'screen_share_audio') return 'unsupported';
    return pub?.kind === 'audio' || track?.kind === 'audio' ? 'mic' : 'unsupported';
}

export function createShareSubscriptions({ store, onError = () => {}, onWanted = () => {}, now = Date.now }) {
    let room = null;
    let reconnecting = false;
    const entries = new Map();
    const seen = new Set();
    const timers = new Map();
    const idFor = (pub, participant) => `${participant.identity}:${pub.trackSid || pub.sid}`;
    const signature = (pub, participant) => `${participant.identity}:${publicationKind(pub)}:${pub.trackName || pub.name || ''}`;

    function publish() {
        store.shares = [...entries.values()].map(({ pub, participant, ...entry }) => ({
            ...entry, displayName: participant.name || participant.identity,
        }));
    }
    function request(entry, wanted) {
        entry.wanted = wanted;
        onWanted(entry.pub.trackSid, wanted);
        try {
            entry.pub.setSubscribed(wanted);
        } catch (error) {
            entry.wanted = false;
            store.error = '订阅失败，请重试';
            onError(error);
        }
    }
    function dismiss(id) {
        store.notices = store.notices.filter(n => n.id !== id);
        clearTimeout(timers.get(id)); timers.delete(id);
    }
    function notify(entry) {
        if (seen.has(entry.id)) return;
        seen.add(entry.id);
        store.notices = [...store.notices, { id: entry.id, createdAt: now() }].slice(-3);
        timers.set(entry.id, setTimeout(() => dismiss(entry.id), 8000));
    }
    function discover(pub, participant, { restored = false } = {}) {
        restored = restored || reconnecting;
        if (!pub || !participant || participant.identity === room?.localParticipant?.identity) return;
        const kind = publicationKind(pub);
        if (kind === 'mic') { pub.setSubscribed(true); return; }
        if (kind === 'unsupported') { pub.setSubscribed(false); return; }
        const id = idFor(pub, participant);
        let entry = entries.get(id);
        if (entry) {
            entry.pub = pub; entry.participant = participant;
            request(entry, entry.wanted); publish(); return;
        }
        // A full reconnect may replace SIDs without creating a new sharing session.
        const previous = restored ? [...entries.values()].find(e => e.signature === signature(pub, participant)) : null;
        entry = {
            id, identity: participant.identity, kind, signature: signature(pub, participant),
            title: kind === 'screen' ? (pub.trackName && !/^screen/i.test(pub.trackName) ? pub.trackName : '屏幕 / 窗口')
                : (pub.trackName?.startsWith('app-audio:') ? pub.trackName.slice(10) : '程序音频'),
            wanted: previous?.wanted || false, subscribed: false, pub, participant,
        };
        if (previous) {
            entries.delete(previous.id); dismiss(previous.id);
            if (store.watchingId === previous.id) store.watchingId = id;
            seen.add(id);
        }
        entries.set(id, entry);
        request(entry, entry.wanted);
        publish();
        if (!restored) notify(entry);
    }
    function remove(pub, participant) {
        if (reconnecting) return;
        const id = idFor(pub, participant);
        const entry = entries.get(id);
        if (!entry) return;
        if (store.watchingId === id) {
            store.watchingId = ''; store.endedName = entry.participant.name || entry.identity;
        }
        entries.delete(id); dismiss(id); publish();
    }
    function sync({ restored = false } = {}) {
        const currentIds = new Set();
        room?.remoteParticipants?.forEach(participant => participant.trackPublications.forEach(pub => {
            currentIds.add(idFor(pub, participant)); discover(pub, participant, { restored });
        }));
        for (const entry of [...entries.values()]) {
            if (!currentIds.has(entry.id)) remove(entry.pub, entry.participant);
        }
    }
    function reset() {
        entries.forEach(entry => { try { entry.pub.setSubscribed(false); } catch (_) {} });
        entries.clear(); seen.clear(); timers.forEach(clearTimeout); timers.clear();
        Object.assign(store, { shares: [], notices: [], watchingId: '', view: 'chat', endedName: '', error: '' });
        room = null; reconnecting = false;
    }
    function attach(nextRoom) { reset(); room = nextRoom; }
    function watchScreen(id) {
        store.error = '';
        const entry = entries.get(id);
        if (!entry || entry.kind !== 'screen') return;
        for (const other of entries.values()) if (other.kind === 'screen' && other.id !== id && other.wanted) request(other, false);
        request(entry, true);
        if (entry.wanted) { store.watchingId = id; store.view = 'watch'; store.endedName = ''; }
        dismiss(id); publish();
    }
    function stopWatching() {
        const entry = entries.get(store.watchingId);
        if (entry) request(entry, false);
        store.watchingId = ''; store.view = 'chat'; store.endedName = ''; publish();
    }
    function toggleListening(id) {
        store.error = '';
        const entry = entries.get(id);
        if (!entry || entry.kind !== 'appaudio') return;
        request(entry, !entry.wanted); dismiss(id); publish();
    }
    function allowTrack(pub, participant, track) {
        if (publicationKind(pub, track) === 'mic') return true;
        return !!entries.get(idFor(pub, participant))?.wanted;
    }
    function subscribed(pub, participant, value) {
        const entry = entries.get(idFor(pub, participant));
        if (entry) { entry.subscribed = value; publish(); }
    }
    function participantLeft(participant) {
        if (reconnecting) return;
        for (const entry of [...entries.values()]) if (entry.identity === participant.identity) remove(entry.pub, participant);
    }
    function failed(sid) {
        const entry = [...entries.values()].find(e => e.pub.trackSid === sid);
        if (!entry) return;
        request(entry, false); entry.subscribed = false;
        store.error = `${entry.kind === 'screen' ? '观看' : '收听'}连接失败，请重试`;
        publish();
    }
    return { attach, reset, discover, remove, sync, watchScreen, stopWatching, toggleListening,
        allowTrack, subscribed, participantLeft, failed, dismiss,
        backToChat: () => { store.view = 'chat'; },
        isCurrentRoom: value => room === value,
        reconnecting: () => { reconnecting = true; },
        reconnected: () => { reconnecting = false; sync({ restored: true }); },
    };
}
