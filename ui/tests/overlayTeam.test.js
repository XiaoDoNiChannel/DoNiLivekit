import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamPanel, createTeamActivity, validateTeamAction } from '../src/features/overlayTeam.js';
import { createOverlayOwner } from '../src/features/overlayProtocol.js';

function panelInput() {
    return { app: { connection: { isConnected: true }, media: { micOn: true, micSource: 'rust', micLevel: 22 } },
        presence: { channels: [{ id: 'chat-a', displayName: '文字频道' }], voiceMembers: [{ identity: 'u1', displayName: '队友' }], voiceStates: { u1: { volumeIdentity: 'u1', micVolumePercent: 85 } } },
        diagnostics: { rttMs: null, voice: { lossPercent: 0, jitterMs: 3 }, updatedAt: 1000 },
        chat: { currentChannelId: 'chat-a', messages: [], notifications: { 'chat-a': { unread: 2, mentions: 1 } } }, chatConnected: true };
}
test('team messages are scoped to the viewed chat channel, bounded and serialized without avatars', () => {
    const input = panelInput();
    input.chat.messages = Array.from({ length: 35 }, (_, i) => ({ id: String(i), channelId: 'chat-a', content: '🎮'.repeat(2001), senderName: '队友', senderAvatarUrl: 'private' }));
    input.chat.messages.push({ id: 'other', channelId: 'chat-b', content: 'other channel' });
    const panel = buildTeamPanel(input);
    assert.equal(panel.chatChannel, '文字频道'); assert.equal(panel.messages.length, 30);
    assert.equal(Array.from(panel.messages[0].content).length, 2000);
    assert.ok(!JSON.stringify(panel).includes('private')); assert.ok(!panel.messages.some(row => row.id === 'other'));
    assert.equal(panel.unread, 2); assert.equal(panel.mentions, 1);
    assert.equal(panel.rttMs, null); assert.equal(panel.lossPercent, 0); assert.equal(panel.micLevel, 22);
    input.app.connection.isConnected = false;
    const disconnected = buildTeamPanel(input);
    assert.deepEqual(disconnected.members, []); assert.equal(disconnected.micLevel, null);
    assert.equal(disconnected.messages.length, 30, 'chat remains independent of voice');
});

function state() { return { session: 's1', channel: '语音频道', connected: true, reconnecting: false, panel: buildTeamPanel(panelInput()) }; }
test('activity groups arrivals, records sharing, and ignores initial/reconnected member baselines', () => {
    let now = 100;
    const tracker = createTeamActivity({ now: () => now++ }), snapshot = state();
    assert.deepEqual(tracker.update(snapshot), []);
    snapshot.panel.members.push({ identity: 'u2', name: '小二' }, { identity: 'u3', name: '小三' });
    let events = tracker.update(snapshot);
    assert.equal(events.length, 1); assert.equal(events[0].text, '小二、小三 加入频道');
    snapshot.panel.shares = [{ id: 'u2:screen', name: '小二', kind: 'screen' }];
    events = tracker.update(snapshot); assert.equal(events.at(-1).text, '小二 开始共享屏幕');
    assert.deepEqual(tracker.update(snapshot), events, 'polls never duplicate events');
    snapshot.reconnecting = true; snapshot.connected = false; snapshot.panel.members = [];
    assert.deepEqual(tracker.update(snapshot), events);
    snapshot.reconnecting = false; snapshot.connected = true; snapshot.panel.members = [{ identity: 'u4', name: '小四' }]; snapshot.panel.shares = [];
    assert.deepEqual(tracker.update(snapshot), events, 'reconnect does not fabricate leave/share-end events');
    snapshot.session = 's2'; assert.deepEqual(tracker.update(snapshot), []);
    snapshot.panel.members = []; assert.equal(tracker.update(snapshot).at(-1).text, '小四 离开频道');
});
test('activity log is bounded to the most recent 30 events', () => {
    const tracker = createTeamActivity(), snapshot = state(); tracker.update(snapshot);
    let events;
    for (let i = 0; i < 40; i++) { snapshot.panel.members = [{ identity: String(i), name: String(i) }]; events = tracker.update(snapshot); }
    assert.equal(events.length, 30); assert.match(events.at(-1).text, /离开/);
});
const request = (extra = {}) => ({ id: 1, kind: 'chat', session: 's1', channelId: 'chat-a', content: '你好', deadline: 5000, ...extra });
test('actions reject stale sessions, wrong channels, offline chat, invalid volume and self adjustment', () => {
    const snapshot = state();
    assert.doesNotThrow(() => validateTeamAction(snapshot, request(), 1000));
    for (const row of [request({ session: 'old' }), request({ channelId: 'wrong' }), request({ deadline: 500 }), request({ content: ' ' }), request({ kind: 'unknown' })]) assert.throws(() => validateTeamAction(snapshot, row, 1000));
    const volume = request({ kind: 'volume', identity: 'u1', source: 'mic', value: 0 });
    assert.doesNotThrow(() => validateTeamAction(snapshot, volume, 1000));
    for (const patch of [{ value: 301 }, { value: NaN }, { identity: 'gone' }, { source: 'screen' }]) assert.throws(() => validateTeamAction(snapshot, { ...volume, ...patch }, 1000));
    snapshot.panel.members[0].self = true; assert.throws(() => validateTeamAction(snapshot, volume, 1000));
    snapshot.panel.chatConnected = false; assert.throws(() => validateTeamAction(snapshot, request(), 1000));
    snapshot.connected = false; snapshot.panel.chatConnected = true;
    assert.doesNotThrow(() => validateTeamAction(snapshot, request(), 1000), 'voice disconnect does not block connected chat');
});
test('owner routes actions through existing operations, acknowledges failures, and serializes with mic', async () => {
    const snapshot = state(), calls = [], sent = [];
    let finish;
    const owner = createOverlayOwner({ invoke: async (name, args) => calls.push({ name, args }), listen: async () => () => {}, getSnapshot: () => snapshot,
        now: () => 1000, toggleMic: async () => { throw Error('must not run'); },
        sendChat: async (...args) => { sent.push(args); return await new Promise(resolve => { finish = resolve; }); }, markRead: id => sent.push(id), setVolume: (...args) => sent.push(args) });
    await owner.start();
    const pending = owner.handleAction(request());
    await owner.handleMic({ id: 2, session: 's1', deadline: 5000, enabled: true });
    assert.match(calls.at(-1).args.error, /尚未完成/);
    finish(true); await pending;
    assert.deepEqual(sent[0], ['你好', 'chat-a']); assert.equal(calls.at(-1).name, 'overlay_action_result'); assert.equal(calls.at(-1).args.error, null);
    const failed = owner.handleAction(request({ id: 3 })); finish(false); await failed;
    assert.match(calls.at(-1).args.error, /未发送/);
    await owner.handleAction(request({ id: 4, kind: 'read' })); assert.equal(sent.at(-1), 'chat-a');
    await owner.handleAction(request({ id: 5, kind: 'volume', identity: 'u1', source: 'mic', value: 125 })); assert.deepEqual(sent.at(-1), ['u1', 'mic', 125]);
    owner.dispose(); const length = calls.length; await owner.handleAction(request()); assert.equal(calls.length, length);
});
