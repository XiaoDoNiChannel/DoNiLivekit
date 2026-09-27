import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverlaySnapshot, createOverlayOwner, acceptOverlayPacket } from '../src/features/overlayProtocol.js';
import { createOverlayClient } from '../src/features/overlayClient.js';

function snapshotInput() {
    return { app: { connection: { currentChannel: 'room-a' }, media: { micOn: true, screenOn: true, appAudioSharing: false } },
        presence: { channels: [{ id: 'room-a', name: 'day0' }], voiceMembers: Array.from({ length: 5 }, (_, i) => ({ identity: `u${i}`, displayName: `User ${i}` })),
            voiceStates: { u4: { micOpen: false } }, speakingIdentities: { u0: true, u1: true, u2: true, u3: true, u4: true, otherRoom: true } },
        diagnostics: { issues: [] }, theme: 'doni-dark', session: 'session-a', connectionState: 'connected' };
}
test('overlay only exposes current room speakers, excludes known muted users, and bounds visible names', () => {
    const input = snapshotInput(); const snapshot = buildOverlaySnapshot(input);
    assert.equal(snapshot.channel, 'day0'); assert.equal(snapshot.speakerCount, 4);
    assert.deepEqual(snapshot.speakers, ['User 0', 'User 1', 'User 2']);
    assert.equal(snapshot.micOn, true); assert.equal(snapshot.screenOn, true);
    assert.ok(!JSON.stringify(snapshot).includes('voiceStates'));
});
test('disconnect or reconnect cannot leave old microphone, share or speaker indicators active', () => {
    for (const connectionState of ['disconnected', 'reconnecting', 'signalReconnecting']) {
        const snapshot = buildOverlaySnapshot({ ...snapshotInput(), connectionState });
        assert.equal(snapshot.connected, false); assert.equal(snapshot.micOn, false); assert.equal(snapshot.screenOn, false);
        assert.deepEqual(snapshot.speakers, []); assert.equal(snapshot.speakerCount, 0);
        assert.equal(snapshot.reconnecting, connectionState !== 'disconnected');
    }
});
test('long names are bounded without breaking Unicode and network warning uses existing evidence', () => {
    const input = snapshotInput(); input.presence.voiceMembers[0].displayName = '🎮'.repeat(100);
    input.diagnostics.issues = [{ title: '持续丢包' }];
    const state = buildOverlaySnapshot(input);
    assert.equal(Array.from(state.speakers[0]).length, 60);
    assert.equal(state.networkWarning, true); assert.equal(state.networkText, '持续丢包');
});
test('out-of-order snapshots are ignored; native stale replies invalidate the same sequence', () => {
    const current = { sequence: 5, fresh: true, snapshot: { micOn: true } };
    assert.equal(acceptOverlayPacket(current, { sequence: 4, snapshot: { micOn: false } }), current);
    assert.equal(acceptOverlayPacket(current, null), current);
    assert.equal(acceptOverlayPacket(current, { ...current, fresh: false }).fresh, false);
});

function ownerHarness(overrides = {}) {
    let state = { session: 'a', connected: true, reconnecting: false, micOn: false }, toggles = 0, scheduled = null;
    const calls = [], handlers = new Map();
    const owner = createOverlayOwner({
        invoke: async (command, args) => { calls.push({ command, args }); },
        listen: async (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); },
        getSnapshot: () => ({ ...state }), toggleMic: async () => { toggles++; state.micOn = !state.micOn; },
        now: () => 1000, schedule: fn => { scheduled = fn; return 1; }, unschedule: () => { scheduled = null; }, ...overrides,
    });
    return { owner, calls, handlers, get state() { return state; }, set state(value) { state = value; }, toggles: () => toggles,
        flush: () => { const fn = scheduled; scheduled = null; fn?.(); } };
}
const request = (values = {}) => ({ id: 1, session: 'a', enabled: true, deadline: 5000, ...values });

test('overlay microphone request is acknowledged only after owner confirms actual state', async () => {
    const h = ownerHarness(); await h.owner.start(); await h.owner.handleMic(request());
    assert.equal(h.toggles(), 1);
    assert.equal(h.calls.at(-1).command, 'overlay_mic_result'); assert.equal(h.calls.at(-1).args.error, null);
    assert.equal(h.calls.at(-2).args.snapshot.micOn, true);
    await h.owner.handleMic(request({ id: 2 })); assert.equal(h.toggles(), 1, 'desired state is idempotent');
    h.owner.dispose();
});
test('old session, disconnected, expired and malformed microphone requests do not change audio', async () => {
    const cases = [request({ session: 'old' }), request({ deadline: 900 }), request({ enabled: 'true' })];
    const h = ownerHarness(); await h.owner.start();
    for (const value of cases) { await h.owner.handleMic(value); assert.ok(h.calls.at(-1).args.error); }
    h.state.connected = false; await h.owner.handleMic(request()); assert.ok(h.calls.at(-1).args.error);
    assert.equal(h.toggles(), 0); h.owner.dispose();
});
test('a swallowed media error or channel change during capture never gets success acknowledgement', async () => {
    const noChange = ownerHarness({ toggleMic: async () => {} }); await noChange.owner.start();
    await noChange.owner.handleMic(request()); assert.match(noChange.calls.at(-1).args.error, /未确认/); noChange.owner.dispose();
    const moved = ownerHarness({ toggleMic: async () => { moved.state = { ...moved.state, session: 'b', micOn: true }; } });
    await moved.owner.start(); await moved.owner.handleMic(request()); assert.match(moved.calls.at(-1).args.error, /未确认/); moved.owner.dispose();
});
test('concurrent mic requests stay serialized even while the first operation awaits capture', async () => {
    let resolve, count = 0;
    const h = ownerHarness({ toggleMic: async () => { count++; await new Promise(done => { resolve = done; }); h.state.micOn = true; } });
    await h.owner.start(); const pending = h.owner.handleMic(request());
    await h.owner.handleMic(request({ id: 2 })); assert.match(h.calls.at(-1).args.error, /尚未完成/);
    resolve(); await pending; assert.equal(count, 1); h.owner.dispose();
});
test('native poll refreshes state without relying on a foreground-only UI interval', async () => {
    const h = ownerHarness(); await h.owner.start();
    h.state.micOn = true; h.handlers.get('overlay-poll')();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.at(-1).args.snapshot.micOn, true);
    h.owner.dispose(); assert.equal(h.handlers.size, 0);
});
test('rapid speaker updates coalesce and disposed owner ignores queued work', async () => {
    const h = ownerHarness(); await h.owner.start();
    h.owner.changed(); h.owner.changed(); h.owner.changed(); h.flush();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.filter(call => call.command === 'overlay_publish').length, 2);
    h.owner.changed(); h.owner.dispose(); h.flush();
    assert.equal(h.handlers.size, 0); assert.equal(h.calls.length, 2);
});
test('late listener initialization is cleaned up after owner disposal', async () => {
    let resolve, cleaned = 0;
    const h = ownerHarness({ listen: () => new Promise(done => { resolve = done; }) });
    const pending = h.owner.start(); h.owner.dispose(); resolve(() => cleaned++); await pending;
    assert.equal(cleaned, 1); assert.equal(h.calls.length, 0);
});

function clientStore() { return { status: { version: -1 }, available: false, busy: false, ready: false, error: '' }; }
test('client installs listeners before fetching initial state and keeps newer status', async () => {
    const store = clientStore(), handlers = new Map();
    const client = createOverlayClient({ store, available: true, listen: async (name, callback) => { handlers.set(name, callback); return () => handlers.delete(name); },
        invoke: async () => { assert.equal(handlers.size, 3); handlers.get('overlay-status')({ payload: { version: 2, interactive: false } }); return { status: { version: 1, interactive: true } }; },
    });
    await client.start(); assert.equal(store.status.interactive, false); assert.equal(store.ready, true);
    client.dispose(); assert.equal(handlers.size, 0);
});
test('shortcut conflicts and failed native controls remain visible, without optimistic mode updates', async () => {
    const store = clientStore(); store.status = { version: 1, interactive: true };
    const client = createOverlayClient({ store, available: true, listen: async () => () => {}, invoke: async () => { throw Error('快捷键已占用'); } });
    assert.equal(await client.control('game'), false); assert.match(store.error, /已占用/);
    assert.equal(store.status.interactive, true); assert.equal(store.busy, false); client.dispose();
});
test('ordinary browser never calls native commands or starts a second media owner', async () => {
    const store = clientStore(); let calls = 0;
    const client = createOverlayClient({ store, available: false, invoke: async () => calls++, listen: async () => calls++ });
    await client.start(); await client.control('show'); assert.equal(calls, 0); assert.equal(store.available, false); client.dispose();
});
