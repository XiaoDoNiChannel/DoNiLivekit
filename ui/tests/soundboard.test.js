import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSound, percent, readSoundboardSettings, shortcutFromEvent } from '../src/features/soundboardAudio.js';
import { createSoundboardFeature } from '../src/features/soundboard.js';
import { createShareSubscriptions, publicationKind } from '../src/features/shareSubscriptions.js';

const buffer = (samples = [1, -1, 0.4, -0.4], duration = 2) => ({ duration, numberOfChannels: 1, getChannelData: () => Float32Array.from(samples) });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, overrides = {}) {
    const values = new Map(), calls = [], sources = [], gains = [], sinks = [];
    let mic = true, room, time = 1000, event;
    const makeRoom = name => ({ name, state: 'connected', localParticipant: {
        publishTrack: async (track, options) => { calls.push(['publish', name, options]); return { track }; },
        unpublishTrack: async (track, stop) => calls.push(['unpublish', name, stop]),
    } });
    room = makeRoom('A');
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
    const state = { ...readSoundboardSettings(storage), ready: false, items: [], peers: [], shortcutErrors: {}, playing: '', mode: '' };
    const audio = { play: async () => {}, pause() {}, setSinkId: async id => sinks.push(id) };
    const ctx = { currentTime: 0, resume: async () => {}, close: async () => {},
        createConstantSource: () => ({ offset: { value: 0 }, connect() {}, start() {}, stop() {} }),
        createGain() { const node = { gain: { value: 1, setTargetAtTime(v) { this.value = v; }, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; } }, connect() {} }; gains.push(node); return node; },
        createMediaStreamDestination() { const track = { stop() {}, clone: () => ({ stop() {} }) }; return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } }; },
        decodeAudioData: async () => buffer(),
        createBufferSource() { const node = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } }; sources.push(node); return node; },
    };
    const invoke = async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'soundboard_list') return [{ id: 'seed-1.mp3', name: '庆祝' }, { id: 'seed-3.mp3', name: '鼓掌' }];
        if (cmd === 'soundboard_read') return btoa('test');
    };
    const feature = createSoundboardFeature({ state, invoke, storage, listen: async (_, handler) => { event = handler; return () => {}; },
        getRoom: () => room, canSend: () => mic && room?.state === 'connected', getOutputId: () => 'headphones',
        createContext: () => ctx, createAudio: () => audio, now: () => time, ...overrides });
    t.after(() => feature.dispose());
    return { feature, state, calls, ctx, gains, sources, sinks, values, makeRoom,
        mic: v => { mic = v; }, room: v => { room = v; }, advance: () => { time += 500; }, event: id => event({ payload: id }) };
}
test('normalization only attenuates; defaults cap loud samples and never amplify quiet clips', () => {
    for (const samples of [[1, -1], [0.9, 0, 0, 0], [.001, -.001], [0, 0]]) {
        const result = analyzeSound(buffer(samples));
        assert.ok(result.attenuation <= 1);
        assert.ok(result.peak * result.attenuation <= .5 + 1e-7);
        assert.ok(result.rms * result.attenuation <= .1 + 1e-7);
        assert.ok(result.peak * result.attenuation * .6 <= .3 + 1e-7);
    }
    assert.equal(analyzeSound(buffer([.001])).attenuation, 1);
    assert.throws(() => analyzeSound(buffer([1], 31)), /30 秒/);
    assert.throws(() => analyzeSound(buffer([NaN])), /损坏/);
    assert.throws(() => analyzeSound({ ...buffer(), numberOfChannels: 6 }), /立体声/);
    assert.equal(percent(500), 100); assert.equal(percent(-2), 0);
});
test('stored zero volume survives restart, malformed settings recover, and shortcuts require modifiers or F keys', () => {
    const get = value => readSoundboardSettings({ getItem: () => value });
    assert.equal(get('{"volume":0}').volume, 0);
    assert.equal(get('bad').volume, 60); assert.deepEqual(get('{"clips":42}').clips, {});
    assert.equal(shortcutFromEvent({ key: 'a', code: 'KeyA' }), '');
    assert.equal(shortcutFromEvent({ key: 'F8', code: 'F8' }), 'F8');
    assert.equal(shortcutFromEvent({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true }), 'Ctrl+Alt+Digit1');
});
test('preview cannot reach send bus; channel playback uses the same gain and selected output', async t => {
    const h = harness(t); await h.feature.start();
    assert.equal(h.state.items[1].shortcut, 'Ctrl+Alt+Digit3');
    await h.feature.play('seed-1.mp3', true);
    const level = h.gains[0].gain.value;
    assert.equal(h.gains[1].gain.value, 0); assert.equal(h.gains[2].gain.value, 1);
    assert.equal(h.sinks.at(-1), 'headphones');
    await h.feature.play('seed-1.mp3');
    assert.equal(h.gains[0].gain.value, level); assert.equal(h.gains[1].gain.value, 1); assert.equal(h.gains[2].gain.value, 0);
    assert.equal(h.sources[0].stopped, true);
    assert.equal(h.calls.filter(c => c[0] === 'publish').length, 1);
    h.feature.preferences({ volume: 0 }); assert.equal(h.gains[0].gain.value, 0);
    h.feature.stop(); assert.equal(h.gains[1].gain.value, 0); assert.equal(h.state.playing, '');
});
test('muted users may preview but cannot broadcast; cooldown and recording suppress repeated shortcuts', async t => {
    const h = harness(t); await h.feature.start(); h.mic(false);
    await h.feature.play('seed-1.mp3'); assert.equal(h.sources.length, 0); assert.match(h.state.error, /麦克风/);
    await h.feature.play('seed-1.mp3', true); assert.equal(h.sources.length, 1);
    h.mic(true); h.advance(); await h.feature.play('seed-1.mp3');
    await h.feature.play('seed-1.mp3'); assert.equal(h.sources.length, 2);
    h.state.recording = 'seed-3.mp3'; h.advance(); h.event('seed-1.mp3'); await tick(); assert.equal(h.sources.length, 2);
    h.state.recording = ''; h.event('_stop'); assert.equal(h.state.playing, '');
});
test('stop during decode cancels delayed playback', async t => {
    const h = harness(t); await h.feature.start();
    const d = deferred(); h.ctx.decodeAudioData = () => d.promise;
    h.state.items.push({ id: 'uncached.mp3', volume: 100 });
    const play = h.feature.play('uncached.mp3', true); await tick(); h.feature.stop();
    d.resolve(buffer()); await play;
    assert.equal(h.sources.length, 0); assert.equal(h.state.playing, '');
});
test('switching rooms stops immediately and drains a late publication before preparing the next room', async t => {
    const h = harness(t); h.room(null); await h.feature.start();
    const old = h.makeRoom('old'), next = h.makeRoom('new'), d = deferred();
    old.localParticipant.publishTrack = () => d.promise;
    h.room(old); const preparing = h.feature.prepare(); await tick();
    const resetting = h.feature.reset(); h.room(next); const nextPreparing = h.feature.prepare();
    await tick(); assert.equal(h.calls.filter(c => c[0] === 'publish').length, 0);
    d.resolve({ track: {} }); await Promise.all([preparing, resetting, nextPreparing]);
    assert.ok(h.calls.some(c => c[0] === 'unpublish' && c[1] === 'old' && c[2] === true));
    assert.ok(h.calls.some(c => c[0] === 'publish' && c[1] === 'new')); assert.equal(h.state.sendReady, true);
});
test('shortcut conflict preserves prior choice and import validates before persisting', async t => {
    const h = harness(t, { invoke: async (cmd, args) => {
        if (cmd === 'soundboard_list') return [{ id: 'seed-1.mp3', name: '庆祝' }];
        if (cmd === 'soundboard_read') return btoa('test');
        if (cmd === 'soundboard_bind' && args.shortcut === 'F8') throw new Error('已占用');
        if (cmd === 'soundboard_import') assert.fail('invalid audio must never be stored');
    } });
    await h.feature.start(); await h.feature.setShortcut('seed-1.mp3', 'F8');
    assert.equal(h.state.items[0].shortcut, 'Ctrl+Alt+Digit1'); assert.match(h.state.shortcutErrors['seed-1.mp3'], /占用/);
    h.ctx.decodeAudioData = async () => buffer([.1], 31);
    await h.feature.importFiles([{ name: 'long.mp3', size: 4, arrayBuffer: async () => new ArrayBuffer(4) }]);
    assert.match(h.state.error, /30 秒/); assert.equal(h.state.busy, false);
});
test('soundboard subscription is independent of microphone and program audio; blocking applies to late tracks', () => {
    let receive = true, peers = [];
    const store = { shares: [], notices: [] };
    const c = createShareSubscriptions({ store, allowSoundboard: () => receive, onSoundboardsChanged: value => { peers = value; } });
    const room = { localParticipant: { identity: 'self' }, remoteParticipants: new Map() }; c.attach(room);
    const person = { identity: 'A', name: '朋友' }, pub = { kind: 'audio', source: 'microphone', trackName: 'soundboard', trackSid: 's', setSubscribed(v) { this.wanted = v; } };
    assert.equal(publicationKind(pub), 'soundboard'); c.discover(pub, person);
    assert.equal(pub.wanted, true); assert.equal(store.shares.length, 0); assert.equal(store.notices.length, 0); assert.equal(peers[0].identity, 'A');
    receive = false; c.syncSoundboards(); assert.equal(pub.wanted, false); assert.equal(c.allowTrack(pub, person), false);
    assert.equal(c.allowTrack({ kind: 'audio', source: 'microphone', trackName: 'mic' }, person), true);
    c.participantLeft(person); assert.equal(peers.length, 0); c.reset();
});
