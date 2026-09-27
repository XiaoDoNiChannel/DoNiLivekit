import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareSubscriptions, publicationKind } from '../src/features/shareSubscriptions.js';

function setup(t) {
    const store = { shares: [], notices: [], watchingId: '', view: 'chat' };
    const controller = createShareSubscriptions({ store });
    const room = { localParticipant: { identity: 'self' }, remoteParticipants: new Map() };
    controller.attach(room); t.after(() => controller.reset());
    const owner = (identity) => {
        const participant = { identity, name: identity, trackPublications: new Map() };
        room.remoteParticipants.set(identity, participant); return participant;
    };
    const pub = (person, sid, kind, trackName) => {
        const publication = { trackSid: sid, kind: kind === 'screen' ? 'video' : 'audio',
            source: kind === 'screen' ? 'screen_share' : kind === 'native' ? 'screen_share_audio' : 'microphone',
            trackName: trackName || (kind === 'appaudio' ? 'app-audio:game.exe' : kind), calls: [],
            setSubscribed(value) { this.calls.push(value); this.requested = value; } };
        person.trackPublications.set(sid, publication); controller.discover(publication, person);
        return publication;
    };
    return { controller, store, room, owner, pub };
}

test('only voice auto-subscribes; screen and Rust audio require distinct opt-ins', t => {
    const { controller: c, store, owner, pub } = setup(t); const a = owner('A');
    const mic = pub(a, 'mic', 'mic'), screen = pub(a, 'screen', 'screen'), audio = pub(a, 'audio', 'appaudio'), native = pub(a, 'native', 'native');
    assert.equal(mic.requested, true); assert.equal(screen.requested, false); assert.equal(audio.requested, false); assert.equal(native.requested, false);
    assert.equal(store.shares.length, 2);
    c.watchScreen('A:screen'); assert.equal(screen.requested, true); assert.equal(audio.requested, false);
    c.toggleListening('A:audio'); assert.equal(audio.requested, true);
    c.backToChat(); assert.equal(store.view, 'chat'); assert.equal(audio.requested, true);
    c.stopWatching(); assert.equal(screen.requested, false); assert.equal(audio.requested, true);
    c.toggleListening('A:audio'); assert.equal(audio.requested, false); assert.equal(mic.requested, true);
});

test('switching screens leaves independently chosen audio intact and a late old video is rejected', t => {
    const { controller: c, store, owner, pub } = setup(t); const a = owner('A'), b = owner('B');
    const aScreen = pub(a, 's', 'screen'), audio = pub(a, 'a', 'appaudio'), bScreen = pub(b, 's', 'screen');
    c.watchScreen('A:s'); c.toggleListening('A:a'); c.watchScreen('B:s');
    assert.equal(aScreen.requested, false); assert.equal(bScreen.requested, true); assert.equal(audio.requested, true);
    assert.equal(c.allowTrack(aScreen, a), false); assert.equal(c.allowTrack(bScreen, b), true);
    c.remove(bScreen, b); assert.equal(store.watchingId, ''); assert.equal(store.endedName, 'B'); assert.equal(store.view, 'watch');
    assert.equal(aScreen.requested, false);
});

test('dismissed prompts do not recur during repeated snapshots or reconnect with replacement SIDs', t => {
    const { controller: c, store, owner, pub } = setup(t); const a = owner('A');
    const audio = pub(a, 'old', 'appaudio'); c.toggleListening('A:old');
    assert.equal(store.notices.length, 0); c.sync(); assert.equal(store.notices.length, 0);
    c.reconnecting(); c.remove(audio, a); assert.equal(store.shares.length, 1);
    a.trackPublications.clear(); const replacement = { ...audio, trackSid: 'new', calls: [] };
    a.trackPublications.set('new', replacement); c.reconnected();
    assert.equal(store.shares.length, 1); assert.equal(store.shares[0].id, 'A:new');
    assert.equal(replacement.requested, true); assert.equal(store.notices.length, 0);
});

test('stopping publication and starting a genuinely new session requires a new listening choice', t => {
    const { controller: c, store, owner, pub } = setup(t); const a = owner('A');
    const first = pub(a, 'a', 'appaudio'); c.toggleListening('A:a'); c.remove(first, a);
    const second = pub(a, 'b', 'appaudio'); assert.equal(second.requested, false);
    assert.equal(store.notices.length, 1); assert.equal(store.notices[0].id, 'A:b');
});

test('publications arriving before the reconnected event preserve opt-in without new prompts', t => {
    const { controller: c, store, owner, pub } = setup(t); const a = owner('A');
    pub(a, 'old', 'appaudio'); c.toggleListening('A:old'); c.reconnecting();
    a.trackPublications.clear(); const replacement = pub(a, 'new', 'appaudio');
    assert.equal(replacement.requested, true); assert.equal(store.notices.length, 0);
    c.reconnected(); assert.equal(store.shares.length, 1); assert.equal(store.shares[0].wanted, true);
});

test('leaving clears all selections, subscriptions and notices; old room is no longer current', t => {
    const { controller: c, store, room, owner, pub } = setup(t); const a = owner('A');
    const audio = pub(a, 'a', 'appaudio'); c.toggleListening('A:a');
    c.reset(); assert.equal(audio.requested, false); assert.equal(c.isCurrentRoom(room), false);
    assert.deepEqual(store.shares, []); assert.deepEqual(store.notices, []); assert.equal(store.view, 'chat');
});

test('subscription failure permits retry without changing another audio selection', t => {
    const { controller: c, store, owner, pub } = setup(t); const a = owner('A');
    const audio = pub(a, 'a', 'appaudio'); c.toggleListening('A:a'); c.failed('a');
    assert.equal(audio.requested, false); assert.match(store.error, /失败/);
    c.toggleListening('A:a'); assert.equal(audio.requested, true);
});

test('Rust named publications remain program audio even with microphone source', () => {
    assert.equal(publicationKind({ kind: 'audio', source: 'microphone', trackName: 'app-audio:游戏、音乐' }), 'appaudio');
    assert.equal(publicationKind({ kind: 'audio', source: 'screen_share_audio', trackName: 'screen-audio' }), 'unsupported');
});
