import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceFeature, onlineInterests, workspaceLayout } from '../src/features/workspace.js';

test('watch → cards → chat always restores the chat slot without stopping the screen', () => {
    for (const panel of ['chat', 'cards', 'chat', 'cards', 'chat']) {
        const layout = workspaceLayout({ watching: true, sameVoice: true, panel });
        assert.equal(layout.watch, true);
        assert.equal(layout.chat, panel === 'chat');
        assert.equal(layout.cards, panel === 'cards');
        assert.equal(layout.sideChat, panel === 'chat');
    }
    assert.deepEqual(workspaceLayout({ watching: true, sameVoice: false, panel: 'cards' }), { watch: false, chat: true, cards: true, sideChat: false });
    assert.equal(workspaceLayout({ watching: false, sameVoice: true, panel: '' }).chat, true);
});

test('intent counts include only online identities, not voice members or same-name bystanders', () => {
    const card = { interests: [{ userId: 'one', displayName: '旧名' }, { userId: 'offline', displayName: '同名' }] };
    assert.deepEqual(onlineInterests(card, { a: { userId: 'one', displayName: '新名' }, b: { userId: 'other', displayName: '同名' } }), [{ userId: 'one', displayName: '新名' }]);
});

test('commands wait for acknowledgement; snapshots are the only card state source', async () => {
    const store = { supported: true, cards: [{ id: 'old' }], busy: false }, sent = [];
    const feature = createWorkspaceFeature({ store, send: payload => { sent.push(payload); return true; } });
    const action = feature.run('card_delete', { id: 'old', revision: 1 });
    assert.equal(store.busy, true); assert.equal(store.cards.length, 1);
    assert.equal(await feature.run('card_create', {}), null);
    feature.receive({ type: 'workspace_result', requestId: 'unrelated', ok: true });
    assert.equal(store.busy, true);
    feature.receive({ type: 'presence_snapshot', workspaceVersion: 1, partyCards: [] });
    feature.receive({ type: 'workspace_result', requestId: sent[0].requestId, ok: true, value: 'old' });
    assert.equal(await action, 'old'); assert.equal(store.busy, false); assert.deepEqual(store.cards, []);
});

test('failed deletes preserve state and surface the backend reason', async () => {
    const store = { supported: true, cards: [{ id: 'card' }] }; let sent;
    const feature = createWorkspaceFeature({ store, send: payload => { sent = payload; return true; } });
    const action = feature.run('channel_delete', { name: 'room' });
    feature.receive({ type: 'workspace_result', requestId: sent.requestId, ok: false, error: '频道仍有成员' });
    assert.equal(await action, null); assert.equal(store.error, '频道仍有成员'); assert.equal(store.cards.length, 1);
});

test('disconnect or timeout releases busy state and never silently replays writes', async () => {
    const store = { supported: true }; let timer, writes = 0;
    const feature = createWorkspaceFeature({ store, send: () => { writes++; return true; }, schedule: fn => { timer = fn; return 1; }, unschedule() {} });
    const first = feature.run('card_create', { game: 'CS2' }); timer();
    assert.equal(await first, null); assert.match(store.error, /未确认/); assert.equal(writes, 1);
    const second = feature.run('card_create', { game: 'CS2' }); feature.disconnect();
    assert.equal(await second, null); assert.equal(store.busy, false); assert.deepEqual(store.cards, []);
    assert.equal(await feature.run('card_create', {}), null); assert.equal(writes, 2);
});

test('old server and closed socket degrade with a visible error', async () => {
    const store = { supported: true, cards: [{ id: 1 }] };
    const feature = createWorkspaceFeature({ store, send: () => false });
    assert.equal(await feature.run('card_create', {}), null); assert.match(store.error, /连接已断开/);
    feature.receive({ type: 'presence_snapshot' });
    assert.equal(store.supported, false); assert.deepEqual(store.cards, []);
    assert.equal(await feature.run('card_create', {}), null); assert.match(store.error, /更新后的服务端/);
});
