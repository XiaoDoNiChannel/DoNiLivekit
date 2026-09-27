import { classifyDiagnosticTrack, createStatsAccumulator, diagnosticCandidates } from './diagnosticStats.js';

const SAMPLE_MS = 2_000;
const HISTORY_MS = 120_000;
const ISSUE_DELAY_MS = 6_000;

/** Read-only observer. It owns sampling and listeners, never publishes or modifies media. */
export function createDiagnosticsFeature({ store, events = {}, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, readTimeoutMs = 3000 }) {
    let room = null, timer = null, generation = 0, busyGeneration = null;
    let sequence = Math.max(0, ...store.events.map(event => event.id));
    let listeners = [], knownScreens = new Map();
    const accumulator = createStatsAccumulator();
    const pending = new Map();

    async function readReport(track) {
        let deadline;
        try {
            return await Promise.race([
                Promise.resolve().then(() => track.getRTCStatsReport?.()).catch(() => null),
                new Promise(resolve => { deadline = setTimeout(() => resolve(null), readTimeoutMs); }),
            ]);
        } finally { clearTimeout(deadline); }
    }

    function record(type, title, detail = '') {
        store.events.unshift({ id: ++sequence, time: now(), channel: store.channel, type, title, detail });
        store.events.splice(100);
    }

    function resetMetrics() {
        accumulator.reset(); pending.clear();
        Object.assign(store, { voice: null, sharedAudio: null, screens: [], rttMs: null, issues: [], updatedAt: null, partial: false });
    }

    function changeConnection(value) {
        if (store.connection === value) return;
        const wasConnected = store.connection === 'connected';
        store.connection = value;
        resetMetrics();
        store.availability = value === 'connected' ? 'collecting' : 'idle';
        const labels = { connected: '通话已连接', reconnecting: '连接中断，正在重连', disconnected: '通话已断开' };
        if (labels[value]) record(value === 'reconnecting' || (wasConnected && value === 'disconnected') ? 'warning' : 'info', labels[value]);
    }

    function publications(participant) {
        return Array.from(participant?.trackPublications?.values?.() || []);
    }

    function describe(pub, participant, direction) {
        const group = classifyDiagnosticTrack(pub);
        if (!group) return null;
        const sid = pub.trackSid || pub.track?.sid;
        if (!sid) return null;
        return { key: `${direction}:${participant?.identity || 'local'}:${sid}`, sid, group, direction,
            name: direction === 'send' ? '我的共享' : (participant?.name || participant?.identity || '远端共享'), track: pub.track };
    }

    function screenEvent(pub, participant, direction, active) {
        const entry = describe(pub, participant, direction);
        if (entry?.group !== 'screen') return;
        if (active && !knownScreens.has(entry.key)) {
            knownScreens.set(entry.key, entry.name);
            record('info', direction === 'send' ? '开始发送屏幕共享' : '开始接收屏幕共享', entry.name);
        } else if (!active && knownScreens.has(entry.key)) {
            knownScreens.delete(entry.key);
            record('info', direction === 'send' ? '停止发送屏幕共享' : '停止接收屏幕共享', entry.name);
            if (direction === 'send') store.target = null;
        }
    }

    function gatherTracks() {
        const tracks = [];
        const participants = [{ participant: room?.localParticipant, direction: 'send' },
            ...Array.from(room?.remoteParticipants?.values?.() || []).map(participant => ({ participant, direction: 'receive' }))];
        for (const { participant, direction } of participants) {
            for (const pub of publications(participant)) {
                const entry = describe(pub, participant, direction);
                if (!entry?.track) continue;
                tracks.push(entry);
                screenEvent(pub, participant, direction, true);
            }
        }
        const current = new Set(tracks.filter(track => track.group === 'screen').map(track => track.key));
        for (const [key, name] of knownScreens) if (!current.has(key)) {
            knownScreens.delete(key);
            record('info', key.startsWith('send:') ? '停止发送屏幕共享' : '停止接收屏幕共享', name);
            if (key.startsWith('send:')) store.target = null;
        }
        return tracks;
    }

    function updateIssues(snapshot, time) {
        const candidates = diagnosticCandidates(snapshot);
        const current = new Map(candidates.map(issue => [issue.key, issue]));
        const active = new Map(store.issues.map(issue => [issue.key, issue]));
        for (const issue of candidates) {
            if (!pending.has(issue.key)) pending.set(issue.key, time);
            if (time - pending.get(issue.key) >= ISSUE_DELAY_MS && !active.has(issue.key)) {
                const value = { ...issue, since: pending.get(issue.key) };
                active.set(issue.key, value);
                const firstSeen = new Date(value.since).toLocaleTimeString('zh-CN', { hour12: false });
                record('warning', issue.title, `${issue.detail} 首次观察于 ${firstSeen}。`);
            } else if (active.has(issue.key)) Object.assign(active.get(issue.key), issue);
        }
        for (const [key, issue] of active) if (!current.has(key)) {
            const duration = Math.round((time - issue.since) / 1000);
            // A missing field or an ended track cannot prove recovery either.
            const audioGroup = key === 'voice-loss' ? 'voice' : key === 'sharedAudio-loss' ? 'sharedAudio' : null;
            const screen = snapshot.screens.find(value => key.startsWith(`${value.key}-`));
            const measurable = audioGroup ? Number.isFinite(snapshot[audioGroup]?.lossPercent)
                : key === 'rtt' ? Number.isFinite(snapshot.rttMs)
                : key.endsWith('-freeze') ? Number.isFinite(screen?.freezes) : !!screen?.limitations.length;
            const unknown = !measurable;
            record(unknown ? 'info' : 'recovery', unknown ? `${issue.title}：统计中断` : `${issue.title}：当前未再观察到`, `已观察约 ${duration} 秒。${unknown ? '轨道结束或统计缺失，无法确认恢复。' : ''}`);
            active.delete(key);
        }
        for (const key of pending.keys()) if (!current.has(key)) pending.delete(key);
        store.issues = [...active.values()];
    }

    async function collect() {
        if (!room || store.connection !== 'connected' || busyGeneration === generation) return;
        const token = generation;
        busyGeneration = token;
        try {
            const tracks = gatherTracks();
            const results = await Promise.all(tracks.map(async entry => {
                try {
                    const report = await readReport(entry.track);
                    return { ...entry, report };
                } catch (_) { return { ...entry, report: null }; }
            }));
            if (token !== generation || store.connection !== 'connected') return;
            const time = now();
            const snapshot = accumulator.summarize(results, store.target);
            const partial = tracks.length > snapshot.reportCount;
            Object.assign(store, { voice: snapshot.voice, sharedAudio: snapshot.sharedAudio, screens: snapshot.screens,
                rttMs: snapshot.rttMs, updatedAt: time, partial,
                availability: !tracks.length ? 'idle' : !snapshot.reportCount ? 'unavailable' : 'ready' });
            const previous = store.history.at(-1);
            if (previous && time - previous.time > SAMPLE_MS * 3) {
                store.history.push({ time: time - SAMPLE_MS, rttMs: null, lossPercent: null, sharedAudioLoss: null, screens: [] });
            }
            store.history.push({ time, rttMs: snapshot.rttMs, lossPercent: snapshot.voice.lossPercent,
                sharedAudioLoss: snapshot.sharedAudio.lossPercent,
                screens: snapshot.screens.map(screen => ({ key: screen.key, fps: screen.fps })) });
            store.history = store.history.filter(point => point.time >= time - HISTORY_MS).slice(-61);
            updateIssues({ ...snapshot, partial }, time);
        } catch (_) {
            if (token === generation) {
                resetMetrics();
                store.availability = 'unavailable';
            }
        } finally { if (busyGeneration === token) busyGeneration = null; }
    }

    function detach() {
        generation++;
        if (timer !== null) clearTimer(timer);
        timer = null;
        for (const [event, handler] of listeners) room?.off?.(event, handler);
        listeners = [];
        knownScreens.clear();
        room = null;
        store.target = null;
        resetMetrics();
    }

    function attachRoom(nextRoom) {
        if (room === nextRoom) return;
        if (room && store.connection !== 'disconnected') record('info', '已离开通话');
        detach();
        store.connection = 'disconnected';
        store.availability = 'idle';
        store.history = [];
        room = nextRoom;
        if (!room) return;
        store.channel = room.name || '';
        const bind = (key, fallback, handler) => {
            const name = events[key] || fallback;
            room.on(name, handler); listeners.push([name, handler]);
        };
        bind('ConnectionStateChanged', 'connectionStateChanged', value => {
            generation++; // Invalidate any report requested before a reconnect.
            changeConnection(value);
        });
        bind('Reconnecting', 'reconnecting', () => { generation++; changeConnection('reconnecting'); });
        bind('Reconnected', 'reconnected', () => { generation++; changeConnection('connected'); });
        bind('Disconnected', 'disconnected', () => { generation++; changeConnection('disconnected'); });
        bind('LocalTrackPublished', 'localTrackPublished', pub => screenEvent(pub, room.localParticipant, 'send', true));
        bind('LocalTrackUnpublished', 'localTrackUnpublished', pub => screenEvent(pub, room.localParticipant, 'send', false));
        bind('TrackSubscribed', 'trackSubscribed', (_track, pub, participant) => screenEvent(pub, participant, 'receive', true));
        bind('TrackUnsubscribed', 'trackUnsubscribed', (_track, pub, participant) => screenEvent(pub, participant, 'receive', false));
        changeConnection(room.state || 'connected');
        timer = setTimer(() => { void collect(); }, SAMPLE_MS);
        void collect();
    }

    return {
        attachRoom, collect,
        setTarget: target => { store.target = target ? { ...target } : null; },
        markMoment: () => record('note', '手动标记：刚才卡了一下', '结合此时刻附近的趋势和事件排查。'),
        dispose: () => { detach(); store.connection = 'disconnected'; store.availability = 'idle'; },
    };
}
