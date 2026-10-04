import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowCloseFeature, WINDOW_CLOSE_PREFERENCE_KEY } from '../src/features/windowClose.js';

function memoryStorage(saved) {
    const values = new Map(saved ? [[WINDOW_CLOSE_PREFERENCE_KEY, saved]] : []);
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function harness(overrides = {}) {
    const state = { open: false, busy: false, error: '' };
    const calls = [];
    let handler;
    const feature = createWindowCloseFeature({
        state, enabled: true,
        storage: memoryStorage(),
        onCloseRequested: async callback => { handler = callback; return () => calls.push('unlisten'); },
        minimize: async () => calls.push('minimize'),
        exit: async () => calls.push('exit'),
        ...overrides,
    });
    return { state, calls, feature, close: () => handler({ preventDefault: () => calls.push('prevent') }) };
}

test('close requests prompt without exiting; cancel and repeated requests are safe', async () => {
    const h = harness();
    await h.feature.start();
    h.close(); h.close();
    assert.equal(h.state.open, true);
    assert.deepEqual(h.calls, ['prevent', 'prevent']);
    h.feature.cancel();
    assert.equal(h.state.open, false);
    h.close();
    assert.equal(h.state.open, true);
});

test('minimize preserves the app and closes the prompt before the next close request', async () => {
    const h = harness();
    await h.feature.start(); h.close();
    await h.feature.choose('minimize');
    assert.deepEqual(h.calls, ['prevent', 'minimize']);
    assert.equal(h.state.open, false);
    assert.equal(h.state.busy, false);
    h.close();
    assert.equal(h.state.open, true);
});

test('exit executes once while pending and cannot be cancelled mid-operation', async () => {
    let complete;
    let exits = 0;
    const h = harness({ exit: () => { exits++; return new Promise(resolve => { complete = resolve; }); } });
    await h.feature.start(); h.close();
    const pending = h.feature.choose('exit');
    h.feature.cancel(); h.close();
    await h.feature.choose('exit');
    await h.feature.choose('minimize');
    assert.equal(h.state.open, true);
    assert.equal(h.state.busy, true);
    assert.equal(exits, 1);
    complete(); await pending;
    assert.equal(h.state.open, false);
});

test('failed native actions keep the prompt available for retry or cancel', async () => {
    for (const action of ['minimize', 'exit']) {
        const h = harness({ [action]: async () => { throw new Error('native failure'); } });
        await h.feature.start(); h.close();
        await h.feature.choose(action);
        assert.equal(h.state.open, true);
        assert.equal(h.state.busy, false);
        assert.match(h.state.error, /native failure/);
        h.feature.cancel();
        assert.equal(h.state.open, false);
    }
});

test('browser preview does not subscribe; late listeners are released after disposal', async () => {
    let subscribed = false;
    const browser = harness({ enabled: false, onCloseRequested: () => { subscribed = true; } });
    await browser.feature.start();
    assert.equal(subscribed, false);
    let ready;
    let released = 0;
    const h = harness({ onCloseRequested: () => new Promise(resolve => { ready = resolve; }) });
    const starting = h.feature.start();
    h.feature.dispose();
    ready(() => released++);
    await starting;
    assert.equal(released, 1);
});

test('remembered choices are saved before acting and reused after restarting without a prompt', async () => {
    for (const action of ['minimize', 'exit']) {
        const storage = memoryStorage();
        let actions = 0;
        const h = harness({ storage, [action]: async () => {
            assert.equal(storage.getItem(WINDOW_CLOSE_PREFERENCE_KEY), action);
            actions++;
        } });
        await h.feature.start(); h.close();
        h.state.remember = true;
        await h.feature.choose(action);
        assert.equal(actions, 1);
        assert.equal(h.state.preference, action);
        const restarted = harness({ storage });
        await restarted.feature.start(); await restarted.close();
        assert.equal(restarted.state.open, false);
        assert.deepEqual(restarted.calls, ['prevent', action]);
    }
});

test('cancel and unchecked one-time choices do not persist a preference', async () => {
    const storage = memoryStorage();
    const h = harness({ storage });
    await h.feature.start(); h.close();
    h.state.remember = true;
    h.feature.cancel(); h.close();
    assert.equal(h.state.remember, false);
    await h.feature.choose('minimize');
    assert.equal(storage.getItem(WINDOW_CLOSE_PREFERENCE_KEY), null);
    h.close();
    assert.equal(h.state.open, true);
});

test('settings can change either saved action and restore asking immediately and across restarts', async () => {
    const storage = memoryStorage('exit');
    const h = harness({ storage });
    await h.feature.start();
    assert.equal(h.feature.setPreference('minimize'), true);
    await h.close();
    assert.deepEqual(h.calls, ['prevent', 'minimize']);
    h.feature.setPreference('exit');
    await h.close();
    assert.equal(h.calls.at(-1), 'exit');
    assert.equal(h.feature.setPreference('ask'), true);
    h.close();
    assert.equal(h.state.open, true);
    const restarted = harness({ storage });
    await restarted.feature.start(); restarted.close();
    assert.equal(restarted.state.open, true);
    assert.deepEqual(restarted.calls, ['prevent']);
});

test('invalid or unreadable saved values fall back to asking', async () => {
    for (const storage of [memoryStorage('invalid'), { getItem() { throw new Error('unavailable'); } }]) {
        const h = harness({ storage });
        await h.feature.start(); h.close();
        assert.equal(h.state.preference, 'ask');
        assert.equal(h.state.open, true);
        assert.deepEqual(h.calls, ['prevent']);
    }
});

test('failed persistence keeps the previous setting and does not exit claiming the choice was saved', async () => {
    const h = harness({ storage: { getItem: () => 'ask', setItem() { throw new Error('full'); } } });
    assert.equal(h.feature.setPreference('minimize'), false);
    assert.equal(h.state.preference, 'ask');
    assert.match(h.state.preferenceError, /保存失败/);
    await h.feature.start(); h.close(); h.state.remember = true;
    await h.feature.choose('exit');
    assert.equal(h.state.open, true);
    assert.equal(h.state.busy, false);
    assert.match(h.state.error, /保存失败/);
    assert.deepEqual(h.calls, ['prevent']);
    h.state.remember = false;
    await h.feature.choose('exit');
    assert.equal(h.calls.at(-1), 'exit');
});

test('automatic actions reject duplicate closes while pending and reopen the prompt on failure', async () => {
    let rejectAction;
    let actions = 0;
    const h = harness({ storage: memoryStorage('minimize'), minimize: () => {
        actions++;
        return new Promise((resolve, reject) => { rejectAction = reject; });
    } });
    await h.feature.start();
    const pending = h.close();
    h.close();
    assert.equal(h.feature.setPreference('exit'), false);
    assert.equal(actions, 1);
    assert.equal(h.state.open, false);
    rejectAction(new Error('native failure'));
    await pending;
    assert.equal(h.state.open, true);
    assert.equal(h.state.busy, false);
    assert.match(h.state.error, /native failure/);
    await h.feature.choose('exit');
    assert.equal(h.calls.at(-1), 'exit');
});
