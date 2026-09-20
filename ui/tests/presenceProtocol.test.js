import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPresenceRecoveryMessages,
    createPresenceSyncState,
    reducePresenceProtocol,
} from '../src/features/presenceProtocol.js';
import {
    applyPresenceMessage,
    getAuthoritativeChannelMembers,
    presenceStore,
    resetPresenceStore,
    syncCurrentVoiceMembers,
} from '../src/stores/presenceStore.js';

const snapshot = (epoch, seq, members = []) => ({
    type: 'presence_snapshot',
    serverEpoch: epoch,
    seq,
    channels: [{ id: 'day0', name: 'day0', members }, { id: 'day1', name: 'day1', members: [] }],
    participants: {},
});

const moved = (epoch, seq, identity, to = 'day0') => ({
    type: 'participant_moved',
    serverEpoch: epoch,
    seq,
    identity,
    userId: identity,
    connectionId: `connection-${seq}`,
    displayName: identity,
    to,
});

test('snapshot 后按连续 seq 应用 diff，并忽略重复 seq', () => {
    let state = createPresenceSyncState();
    let result = reducePresenceProtocol(state, snapshot('epoch-a', 10));
    state = result.state;
    assert.deepEqual(result.applyMessages.map((item) => item.seq), [10]);

    result = reducePresenceProtocol(state, moved('epoch-a', 11, 'alice'));
    state = result.state;
    assert.deepEqual(result.applyMessages.map((item) => item.seq), [11]);

    result = reducePresenceProtocol(state, moved('epoch-a', 11, 'alice'));
    assert.equal(result.ignored, true);
    assert.equal(result.applyMessages.length, 0);
});

test('snapshot 前缓存 diff，snapshot 后重放更新的连续事件', () => {
    let state = createPresenceSyncState();
    let result = reducePresenceProtocol(state, moved('epoch-a', 3, 'alice'));
    state = result.state;
    assert.equal(result.requestSnapshot, true);
    assert.equal(result.applyMessages.length, 0);

    result = reducePresenceProtocol(state, snapshot('epoch-a', 2));
    assert.deepEqual(result.applyMessages.map((item) => item.seq), [2, 3]);
    assert.equal(result.state.lastSeq, 3);
});

test('seq 跳号触发重新同步，旧 snapshot 不能覆盖新事件', () => {
    let state = reducePresenceProtocol(createPresenceSyncState(), snapshot('epoch-a', 5)).state;
    let result = reducePresenceProtocol(state, moved('epoch-a', 7, 'alice'));
    state = result.state;
    assert.equal(result.requestSnapshot, true);
    assert.equal(result.applyMessages.length, 0);

    result = reducePresenceProtocol(state, snapshot('epoch-a', 6));
    state = result.state;
    assert.deepEqual(result.applyMessages.map((item) => item.seq), [6, 7]);

    result = reducePresenceProtocol(state, snapshot('epoch-a', 6));
    assert.equal(result.ignored, true);
});

test('server epoch 改变会清除旧同步状态并等待新快照', () => {
    let state = reducePresenceProtocol(createPresenceSyncState(), snapshot('epoch-a', 20)).state;
    const result = reducePresenceProtocol(state, moved('epoch-b', 1, 'bob'));
    assert.equal(result.epochChanged, true);
    assert.equal(result.state.lastEpoch, 'epoch-b');
    assert.equal(result.state.hasSnapshot, false);
    assert.equal(result.state.pendingDiffs.length, 1);
    assert.equal(result.requestSnapshot, true);
});

test('重连恢复只发送一次 join + snapshot，identity upsert 不产生重复成员', () => {
    assert.deepEqual(buildPresenceRecoveryMessages('day0'), [
        { type: 'join_channel', channelId: 'day0' },
        { type: 'request_snapshot' },
    ]);

    resetPresenceStore();
    applyPresenceMessage(snapshot('epoch-a', 1, [{ identity: 'alice', displayName: 'Alice' }]));
    applyPresenceMessage({
        type: 'participant_online',
        serverEpoch: 'epoch-a',
        seq: 2,
        participant: { identity: 'alice', userId: 'alice', connectionId: 'new', displayName: 'Alice' },
    });
    applyPresenceMessage(moved('epoch-a', 3, 'alice'));
    assert.equal(presenceStore.channels[0].members.length, 1);
    assert.equal(presenceStore.channels[0].members[0].identity, 'alice');
});

test('当前频道人数与高级面板共享 LiveKit 权威成员集合', () => {
    resetPresenceStore();
    applyPresenceMessage(snapshot('epoch-a', 1, [
        { identity: 'stale', displayName: 'Stale' },
        { identity: 'alice', displayName: 'Alice' },
    ]));
    syncCurrentVoiceMembers('day0', [
        { identity: 'alice', displayName: 'Alice', isSelf: true },
        { identity: 'bob', displayName: 'Bob' },
        { identity: 'carol', displayName: 'Carol' },
    ], true);

    const channelMembers = getAuthoritativeChannelMembers('day0');
    const advancedPanelMembers = getAuthoritativeChannelMembers('day0');
    assert.equal(channelMembers.length, 3);
    assert.strictEqual(channelMembers, advancedPanelMembers);
    assert.equal(getAuthoritativeChannelMembers('day1').length, 0);
});
