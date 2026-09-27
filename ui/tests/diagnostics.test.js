import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiagnosticTrack, createStatsAccumulator, diagnosticCandidates } from '../src/features/diagnosticStats.js';
import { createDiagnosticsFeature } from '../src/features/diagnostics.js';
import { createDiagnosticsState, getDiagnosticSummary } from '../src/stores/diagnosticsStore.js';

const report = (...rows) => new Map(rows.map(row => [row.id, row]));
const inbound = (timestamp, received, lost, extras = {}) => ({ id: 'in', type: 'inbound-rtp', kind: 'audio', timestamp, packetsReceived: received, packetsLost: lost, bytesReceived: received * 100, ...extras });
const entry = (stats, extras = {}) => ({ key: 'voice:alice', sid: 'mic', group: 'voice', direction: 'receive', name: 'Alice', report: report(...stats), ...extras });

test('voice, system audio and screen are isolated; unknown audio stays unclassified', () => {
    assert.equal(classifyDiagnosticTrack({ kind: 'audio', source: 'microphone' }), 'voice');
    assert.equal(classifyDiagnosticTrack({ kind: 'audio', source: 'unknown', trackName: 'app-audio' }), 'sharedAudio');
    assert.equal(classifyDiagnosticTrack({ kind: 'audio', source: 'screen_share_audio' }), 'sharedAudio');
    assert.equal(classifyDiagnosticTrack({ kind: 'video', source: 'screen_share' }), 'screen');
    assert.equal(classifyDiagnosticTrack({ kind: 'audio', source: 'unknown' }), null);
});

test('loss uses recent deltas instead of lifetime counts and old loss ages out', () => {
    const stats = createStatsAccumulator();
    assert.equal(stats.summarize([entry([inbound(0, 100000, 50000)])]).voice.lossPercent, null);
    let sample = stats.summarize([entry([inbound(2000, 100099, 50001)])]);
    assert.equal(sample.voice.lossPercent, 1);
    assert.equal(sample.voice.rxKbps, 39.6);
    stats.summarize([entry([inbound(10000, 100499, 50001)])]);
    sample = stats.summarize([entry([inbound(12000, 100599, 50001)])]);
    assert.equal(sample.voice.lossPercent, 0);
});

test('counter reset, SSRC replacement and missing counters never become bogus zeros or spikes', () => {
    const stats = createStatsAccumulator();
    stats.summarize([entry([inbound(0, 1000, 10)])]);
    let sample = stats.summarize([entry([inbound(2000, 2, 0)])]);
    assert.equal(sample.voice.lossPercent, null);
    assert.equal(sample.voice.rxKbps, null);
    sample = stats.summarize([entry([inbound(4000, 10, 0, { id: 'new-ssrc' })])]);
    assert.equal(sample.voice.lossPercent, null);
    sample = stats.summarize([entry([{ id: 'new-ssrc', type: 'inbound-rtp', kind: 'audio', timestamp: 6000 }])]);
    assert.equal(sample.voice.rxKbps, null);
});

test('late packets can reduce cumulative lost count without inventing negative loss', () => {
    const stats = createStatsAccumulator();
    stats.summarize([entry([inbound(0, 100, 10)])]);
    assert.equal(stats.summarize([entry([inbound(2000, 120, 8)])]).voice.lossPercent, 0);
});

test('peer departure removes its counters; packet-weighted loss keeps shared audio separate', () => {
    const stats = createStatsAccumulator();
    const rows = t => [entry([inbound(t, t / 20, t / 200)]), entry([inbound(t, t / 20, 0)], { key: 'voice:bob' }), entry([inbound(t, t / 100, t / 20)], { key: 'app', group: 'sharedAudio' })];
    stats.summarize(rows(0));
    const sample = stats.summarize(rows(2000));
    assert.ok(Math.abs(sample.voice.lossPercent - 10 / 210 * 100) < 0.0001);
    assert.ok(sample.sharedAudio.lossPercent > 80);
    const left = stats.summarize(rows(4000).slice(0, 1));
    assert.equal(left.voice.tracks, 1);
    assert.ok(left.voice.rxKbps > 0);
});

test('screen target stays separate from reported dimensions, frame rate and bitrate; RTX excluded', () => {
    const stats = createStatsAccumulator();
    const screen = t => entry([
        { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp: t, bytesSent: t * 100, framesEncoded: t / 40, frameWidth: 1280, frameHeight: 720, qualityLimitationReason: 'cpu' },
        { id: 'repair', type: 'outbound-rtp', kind: 'video', timestamp: t, bytesSent: t * 999, codecId: 'rtx' },
        { id: 'rtx', type: 'codec', mimeType: 'video/rtx' },
    ], { key: 'screen', sid: 's1', group: 'screen', direction: 'send' });
    const target = { trackSid: 's1', width: 1920, height: 1080, fps: 60, bitrateKbps: 5000 };
    stats.summarize([screen(0)], target);
    const result = stats.summarize([screen(2000)], target).screens[0];
    assert.equal(result.target.fps, 60);
    assert.equal(result.fps, 25);
    assert.deepEqual(result.dimensions, { width: 1280, height: 720 });
    assert.equal(result.txKbps, 800);
    assert.deepEqual(result.limitations, ['cpu']);
    assert.equal(stats.summarize([screen(4000)], { ...target, trackSid: 'old' }).screens[0].target, null);
});

test('low fps on a static screen does not imply CPU or bandwidth limitation', () => {
    const snapshot = { rttMs: 40, voice: {}, sharedAudio: {}, screens: [{ key: 's', name: 'Me', fps: 1, limitations: ['none'], target: { fps: 60 } }] };
    assert.deepEqual(diagnosticCandidates(snapshot), []);
    snapshot.screens[0].limitations = ['bandwidth'];
    assert.equal(diagnosticCandidates(snapshot)[0].title, '共享发送受带宽限制');
});

test('receiver freeze count uses a window and unsupported freeze data stays unknown', () => {
    const stats = createStatsAccumulator();
    const screen = (time, freezeCount) => entry([{ ...inbound(time, time / 20, 0), kind: 'video', freezeCount, framesDecoded: time / 50 }], { key: 's', group: 'screen' });
    stats.summarize([screen(0, 9)]);
    const value = stats.summarize([screen(2000, 10)]).screens[0];
    assert.equal(value.freezes, 1);
    assert.equal(value.fps, 20);
    assert.equal(value.target, null);
    assert.equal(stats.summarize([screen(4000, undefined)]).screens[0].freezes, null);
});

test('RTT uses selected transport / linked remote report, never an unused candidate pair', () => {
    const stats = createStatsAccumulator();
    const snapshot = stats.summarize([entry([
        inbound(0, 1, 0), { id: 'transport', type: 'transport', selectedCandidatePairId: 'chosen' },
        { id: 'chosen', type: 'candidate-pair', currentRoundTripTime: 0.035 },
        { id: 'unused', type: 'candidate-pair', currentRoundTripTime: 9 },
    ])]);
    assert.equal(snapshot.rttMs, 35);
});

function harness(options = {}) {
    let time = 0, nextReport = report(inbound(0, 0, 0));
    const callbacks = new Map();
    const pub = { kind: 'audio', source: 'microphone', trackSid: 'm', track: { getRTCStatsReport: async () => nextReport } };
    const room = { name: 'test-channel', state: 'connected', localParticipant: { identity: 'me', trackPublications: new Map() }, remoteParticipants: new Map([['alice', { identity: 'alice', trackPublications: new Map([['m', pub]]) }]]),
        on(name, fn) { callbacks.set(name, fn); }, off(name) { callbacks.delete(name); } };
    const state = createDiagnosticsState();
    const cleared = [];
    const feature = createDiagnosticsFeature({ store: state, now: () => time, setTimer: () => 1, clearTimer: id => cleared.push(id), ...options });
    return { feature, room, state, callbacks, pub, cleared, set: (t, value) => { time = t; nextReport = value; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('only sustained anomalies create one incident, then an evidence-based recovery', async () => {
    const h = harness(); h.feature.attachRoom(h.room); await flush();
    for (const t of [2000, 4000, 6000, 8000, 10000]) {
        h.set(t, report(inbound(t, t / 20, t / 200))); await h.feature.collect();
        if (t < 8000) assert.equal(h.state.issues.length, 0);
    }
    assert.equal(h.state.issues.length, 1);
    assert.equal(h.state.events.filter(event => event.title === '语音接收丢包增加').length, 1);
    h.set(20000, report(inbound(20000, 10000, 50))); await h.feature.collect();
    assert.equal(h.state.issues.length, 0);
    assert.ok(h.state.events.some(event => event.type === 'recovery'));
    h.feature.dispose();
});

test('missing statistics end an incident as unknown, not recovered', async () => {
    const h = harness(); h.feature.attachRoom(h.room); await flush();
    for (const t of [2000, 4000, 6000, 8000]) { h.set(t, report(inbound(t, t / 20, t / 200))); await h.feature.collect(); }
    h.set(10000, undefined); await h.feature.collect();
    assert.equal(h.state.availability, 'unavailable');
    assert.equal(h.state.voice.lossPercent, null);
    assert.ok(h.state.events.some(event => event.title.endsWith('统计中断')));
    assert.equal(h.state.events.filter(event => event.type === 'recovery').length, 0);
    h.feature.dispose();
});

test('switching rooms discards late reports, resets baselines, removes listeners and retains event history', async () => {
    const h = harness(); let resolve;
    h.pub.track.getRTCStatsReport = () => new Promise(done => { resolve = done; });
    h.feature.attachRoom(h.room);
    await Promise.resolve();
    h.feature.attachRoom(null);
    resolve(report(inbound(2000, 100, 20))); await flush();
    assert.equal(h.state.voice, null);
    assert.equal(h.state.history.length, 0);
    assert.equal(h.callbacks.size, 0);
    assert.deepEqual(h.cleared, [1]);
    assert.ok(h.state.events.length >= 2);
});

test('reconnect invalidates old sampling and does not duplicate state-change events', async () => {
    const h = harness(); h.feature.attachRoom(h.room); await flush();
    h.callbacks.get('connectionStateChanged')('reconnecting');
    h.callbacks.get('reconnecting')();
    assert.equal(h.state.events.filter(event => event.title === '连接中断，正在重连').length, 1);
    assert.equal(getDiagnosticSummary(h.state).text, '正在重连');
    h.callbacks.get('reconnected')();
    h.set(2000, report(inbound(2000, 300, 5))); await h.feature.collect();
    assert.equal(h.state.voice.lossPercent, null);
    h.feature.dispose();
});

test('manual bookmarks and session history are bounded', () => {
    const h = harness();
    for (let i = 0; i < 120; i++) h.feature.markMoment();
    assert.equal(h.state.events.length, 100);
    assert.equal(new Set(h.state.events.map(event => event.id)).size, 100);
});

test('a stalled RTC report times out and does not permanently block later samples', async () => {
    const h = harness({ readTimeoutMs: 5 });
    h.feature.attachRoom(h.room); await flush();
    h.pub.track.getRTCStatsReport = () => new Promise(() => {});
    await h.feature.collect();
    assert.equal(h.state.availability, 'unavailable');
    h.pub.track.getRTCStatsReport = async () => report(inbound(5000, 100, 0));
    await h.feature.collect();
    assert.equal(h.state.availability, 'ready');
    h.feature.dispose();
});
