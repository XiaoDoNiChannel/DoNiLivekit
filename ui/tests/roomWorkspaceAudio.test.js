import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAudioFeature } from '../src/features/remoteAudio.js';
import { createRoomConnectionFeature } from '../src/features/roomConnection.js';

test('stop listening silences the gain immediately; changing volume cannot reactivate it', t => {
    const previousDocument = globalThis.document, previousMediaStream = globalThis.MediaStream;
    t.after(() => { globalThis.document = previousDocument; globalThis.MediaStream = previousMediaStream; });
    globalThis.MediaStream = class {};
    const audio = { dataset: { audioIdentity: 'A', audioSource: 'appaudio', audioTrackSid: 'a' }, muted: true };
    globalThis.document = { querySelectorAll: () => [audio] };
    const volumes = { appaudio: 1 };
    const node = { gain: { value: 1 }, connect() {}, disconnect() {} };
    const feature = createRemoteAudioFeature({
        ensureParticipantVolumeState: () => volumes, ensureAudioContext() {},
        getRemoteAudioContext: () => ({ createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createGain: () => node, destination: {} }),
        normalizeGainValue: v => Number(v) / 100, saveUserVolumesToStorage() {},
    });
    feature.addRemoteGainNode('A', 'appaudio', { sid: 'a', mediaStreamTrack: {} }, audio);
    assert.equal(node.gain.value, 1); feature.setTrackEnabled('a', false); assert.equal(node.gain.value, 0);
    feature.setParticipantVolume('A', 'appaudio', 160); assert.equal(node.gain.value, 0);
    feature.setTrackEnabled('a', true); assert.equal(node.gain.value, 1.6);
});

test('native audio fallback is audible only while listening is enabled', t => {
    const previous = globalThis.document; t.after(() => { globalThis.document = previous; });
    const audio = { dataset: { audioIdentity: 'A', audioSource: 'appaudio', audioTrackSid: 'a' }, muted: true };
    globalThis.document = { querySelectorAll: () => [audio] };
    const feature = createRemoteAudioFeature({ ensureParticipantVolumeState: () => ({ appaudio: .7 }), ensureAudioContext() {}, getRemoteAudioContext: () => null });
    feature.addRemoteGainNode('A', 'appaudio', {}, audio);
    assert.equal(audio.muted, false); assert.equal(audio.volume, .7);
    feature.setTrackEnabled('a', false); assert.equal(audio.muted, true);
});

test('leaving awaits program audio and video stop before disconnect and releases both PCM pipelines', async t => {
    const previous = globalThis.document; t.after(() => { globalThis.document = previous; });
    const elements = new Map();
    globalThis.document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { style: {} }); return elements.get(id); } };
    const calls = [];
    let room = { localParticipant: { setScreenShareEnabled: async value => { assert.equal(value, false); calls.push('screen'); } }, disconnect: async () => calls.push('disconnect') };
    const noop = () => {};
    const feature = createRoomConnectionFeature({
        presence: { leaveChannel: noop, disconnect: noop }, getRoom: () => room, setRoom: value => { room = value; },
        isTauriClient: false,
        rustMic: { getIsMicOn: () => false, setMicOn: noop },
        appAudio: { stopAppAudioShare: async () => { await Promise.resolve(); calls.push('audio'); }, setIsAppAudioSharing: noop, setLocalAppAudioPublication: noop, closeAppAudioModal: noop },
        screenShare: { getIsScreenOn: () => true, setIsScreenOn: noop, stopScreenBitrateMonitor: noop, hideLocalScreenPreview: noop },
        livekitEvents: { clearLocalScreenControls: () => calls.push('subscriptions') },
        remoteAudio: { clearRemoteGainNodes: () => calls.push('routes') },
        participants: { clearActiveSpeakers: noop },
        audioPipelines: { teardownLocalPcmPipeline: () => calls.push('program-pcm'), teardownRustMicPipeline: () => calls.push('mic-pcm') },
    });
    await feature.leaveRoom();
    assert.ok(calls.indexOf('audio') < calls.indexOf('disconnect'));
    assert.ok(calls.indexOf('screen') < calls.indexOf('disconnect'));
    assert.ok(calls.includes('program-pcm')); assert.ok(calls.includes('mic-pcm'));
    assert.equal(room, null); assert.equal(feature.getIsInLobby(), false); assert.equal(feature.getCurrentChannel(), null);
});
