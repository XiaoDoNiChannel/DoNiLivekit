const WINDOW_MS = 10_000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const maxOrNull = values => values.length ? Math.max(...values) : null;
const sumOrNull = values => values.length ? values.reduce((sum, value) => sum + value, 0) : null;

export function classifyDiagnosticTrack(publication) {
    const source = publication.source || publication.track?.source;
    const name = String(publication.trackName || publication.name || publication.track?.name || '').toLowerCase();
    if (source === 'screen_share') return 'screen';
    if (publication.kind !== 'audio' && publication.track?.kind !== 'audio') return null;
    if (source === 'screen_share_audio' || /app[-_ ]?audio|system[-_ ]?audio|process[-_ ]?audio/.test(name)) return 'sharedAudio';
    if (source === 'microphone' || name === 'microphone') return 'voice';
    return null; // Unknown audio must not silently contaminate microphone metrics.
}

export function emptyAudioMetrics() {
    return { tracks: 0, txKbps: null, rxKbps: null, lossPercent: null, jitterMs: null, rttMs: null };
}

/** Counter windows are per track + RTP stream, so joins, SSRC changes and resets do not create spikes. */
export function createStatsAccumulator() {
    const windows = new Map();

    function delta(key, stat) {
        const timestamp = stat.timestamp instanceof Date ? stat.timestamp.getTime() : stat.timestamp;
        if (!finite(timestamp)) return {};
        let samples = windows.get(key) || [];
        const last = samples.at(-1);
        if (last && timestamp === last.timestamp) return {}; // A stale report is not a fresh observation.
        const counters = ['bytesSent', 'bytesReceived', 'packetsSent', 'packetsReceived', 'framesEncoded', 'framesDecoded', 'freezeCount'];
        if (last && (timestamp < last.timestamp || timestamp - last.timestamp > WINDOW_MS * 2
            || counters.some(field => finite(stat[field]) && finite(last[field]) && stat[field] < last[field]))) samples = [];
        const current = { timestamp };
        for (const field of [...counters, 'packetsLost']) if (finite(stat[field])) current[field] = stat[field];
        samples.push(current);
        while (samples.length > 2 && samples[1].timestamp <= timestamp - WINDOW_MS) samples.shift();
        windows.set(key, samples);
        const first = samples[0];
        const seconds = (timestamp - first.timestamp) / 1000;
        if (seconds <= 0) return {};
        const result = { seconds };
        for (const field of [...counters, 'packetsLost']) {
            if (finite(current[field]) && finite(first[field])) result[field] = Math.max(0, current[field] - first[field]);
        }
        return result;
    }

    function summarize(tracks, target = null) {
        const seen = new Set();
        const audio = { voice: [], sharedAudio: [] };
        const screens = [];
        const transportRtts = [];
        let reportCount = 0;
        for (const entry of tracks) {
            const rows = entry.report ? Array.from(entry.report.values()) : [];
            const byId = new Map(rows.map(stat => [stat.id, stat]));
            const rtpType = entry.direction === 'send' ? 'outbound-rtp' : 'inbound-rtp';
            const mediaRows = rows.filter(stat => {
                if (stat.type !== rtpType || stat.isRemote) return false;
                const kind = stat.kind || stat.mediaType;
                if (kind !== (entry.group === 'screen' ? 'video' : 'audio')) return false;
                const codec = byId.get(stat.codecId)?.mimeType || '';
                return !/\/(rtx|red|ulpfec|flexfec)/i.test(codec);
            });
            if (mediaRows.length) reportCount++;
            for (const stat of rows) {
                if (stat.type === 'transport' && stat.selectedCandidatePairId) {
                    const pair = byId.get(stat.selectedCandidatePairId);
                    if (finite(pair?.currentRoundTripTime)) transportRtts.push(pair.currentRoundTripTime * 1000);
                }
            }
            const tx = [], rx = [], losses = [], jitters = [], rtts = [], fps = [], freezes = [];
            const reasons = new Set();
            let dimensions = null;
            for (const stat of mediaRows) {
                const key = `${entry.key}:${stat.id}`;
                seen.add(key);
                const change = delta(key, stat);
                if (finite(change.bytesSent)) tx.push(change.bytesSent * 8 / change.seconds / 1000);
                if (finite(change.bytesReceived)) rx.push(change.bytesReceived * 8 / change.seconds / 1000);
                if (finite(change.packetsReceived) && finite(change.packetsLost)) losses.push({ received: change.packetsReceived, lost: change.packetsLost });
                if (finite(stat.jitter)) jitters.push(stat.jitter * 1000);
                const remote = byId.get(stat.remoteId);
                if (finite(remote?.roundTripTime)) rtts.push(remote.roundTripTime * 1000);
                if (finite(stat.framesPerSecond)) fps.push(stat.framesPerSecond);
                else {
                    const frames = entry.direction === 'send' ? change.framesEncoded : change.framesDecoded;
                    if (finite(frames)) fps.push(frames / change.seconds);
                }
                if (finite(change.freezeCount)) freezes.push(change.freezeCount);
                if (stat.qualityLimitationReason) reasons.add(stat.qualityLimitationReason);
                if (finite(stat.frameWidth) && finite(stat.frameHeight)
                    && (!dimensions || stat.frameWidth * stat.frameHeight > dimensions.width * dimensions.height)) {
                    dimensions = { width: stat.frameWidth, height: stat.frameHeight };
                }
            }
            const lost = losses.reduce((sum, value) => sum + value.lost, 0);
            const received = losses.reduce((sum, value) => sum + value.received, 0);
            const metric = {
                key: entry.key, name: entry.name, direction: entry.direction, available: mediaRows.length > 0,
                txKbps: sumOrNull(tx), rxKbps: sumOrNull(rx), lost, received,
                lossPercent: lost + received > 0 ? lost / (lost + received) * 100 : null,
                jitterMs: maxOrNull(jitters), rttMs: maxOrNull(rtts),
            };
            if (entry.group === 'screen') screens.push({
                ...metric, fps: maxOrNull(fps), dimensions, freezes: sumOrNull(freezes),
                limitations: [...reasons], target: entry.direction === 'send' && target?.trackSid === entry.sid ? { ...target } : null,
            });
            else audio[entry.group].push(metric);
        }
        for (const key of windows.keys()) if (!seen.has(key)) windows.delete(key);
        function aggregate(rows) {
            const metric = emptyAudioMetrics();
            metric.tracks = rows.length;
            for (const field of ['txKbps', 'rxKbps']) metric[field] = sumOrNull(rows.map(row => row[field]).filter(finite));
            for (const field of ['jitterMs', 'rttMs']) metric[field] = maxOrNull(rows.map(row => row[field]).filter(finite));
            const received = rows.reduce((sum, row) => sum + row.received, 0);
            const lost = rows.reduce((sum, row) => sum + row.lost, 0);
            metric.lossPercent = received + lost > 0 ? lost / (received + lost) * 100 : null;
            return metric;
        }
        const voice = aggregate(audio.voice);
        const sharedAudio = aggregate(audio.sharedAudio);
        const rttMs = maxOrNull([...transportRtts, voice.rttMs, sharedAudio.rttMs].filter(finite));
        return { voice, sharedAudio, screens, rttMs, reportCount };
    }
    return { summarize, reset: () => windows.clear() };
}

export function diagnosticCandidates(snapshot) {
    const issues = [];
    for (const [group, label] of [['voice', '语音'], ['sharedAudio', '共享音频']]) {
        const value = snapshot[group];
        if (value?.lossPercent >= 3) issues.push({ key: `${group}-loss`, title: `${label}接收丢包增加`, detail: `近 10 秒接收丢包 ${value.lossPercent.toFixed(1)}%。仅凭接收统计无法定位故障端。`, advice: '先确认是否所有成员都受影响，再检查网络连接。' });
    }
    if (snapshot.rttMs >= 180) issues.push({ key: 'rtt', title: '通话链路延迟升高', detail: `当前链路 RTT 约 ${Math.round(snapshot.rttMs)} ms；这不是端到端音频延迟。`, advice: '检查网络占用和连接稳定性，避免仅凭 RTT 判断故障位置。' });
    for (const screen of snapshot.screens) {
        const reason = screen.limitations.includes('cpu') ? 'cpu' : screen.limitations.includes('bandwidth') ? 'bandwidth' : null;
        if (reason) issues.push({ key: `${screen.key}-${reason}`, title: reason === 'cpu' ? '共享编码受 CPU 限制' : '共享发送受带宽限制', detail: `${screen.name}：编码器报告 ${reason === 'cpu' ? 'CPU' : '带宽'} 限制。`, advice: reason === 'cpu' ? '可停止共享后降低帧率或分辨率，再观察效果。' : '可减少上传占用，或停止共享后降低画质再试。' });
        if (screen.freezes > 0) issues.push({ key: `${screen.key}-freeze`, title: '共享接收出现卡顿', detail: `${screen.name}：最近约 10 秒记录到 ${screen.freezes} 次冻结。`, advice: '结合接收丢包和发送端状态排查，接收端无法独自确认原因。' });
    }
    return issues;
}
