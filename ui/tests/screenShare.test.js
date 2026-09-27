import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenShareFeature } from '../src/features/screenShare.js';

test('screen capture never requests or publishes WebView audio and stop does not touch Rust program audio', async t => {
    const oldDocument = globalThis.document; t.after(() => { globalThis.document = oldDocument; });
    const elements = new Map(['screen-res', 'screen-fps', 'screen-bitrate'].map(id => [id, { value: id === 'screen-res' ? '1920x1080' : id === 'screen-fps' ? '30' : '5000' }]));
    globalThis.document = { getElementById: id => elements.get(id) };
    let enabled = false;
    const calls = [];
    const room = { localParticipant: { videoTrackPublications: new Map(), setScreenShareEnabled: async (...args) => calls.push(args) } };
    const feature = createScreenShareFeature({ getRoom: () => room, getIsScreenOn: () => enabled, setIsScreenOn: value => { enabled = value; } });
    await feature.toggleScreen();
    assert.equal(enabled, true); assert.equal(calls[0][1].audio, false); assert.equal(calls[0][1].systemAudio, 'exclude');
    assert.equal('audioPreset' in calls[0][2], false);
    await feature.toggleScreen(); assert.deepEqual(calls[1], [false]); assert.equal(enabled, false);
});
