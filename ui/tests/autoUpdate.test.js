import test from 'node:test';
import assert from 'node:assert/strict';

import { createAutoUpdateFeature, normalizeServerBaseUrl } from '../src/features/autoUpdate.js';
import { createUpdateState } from '../src/stores/updateStore.js';

test('更新地址使用已保存服务器而不拼接安装包 URL', () => {
    assert.equal(normalizeServerBaseUrl('192.168.1.8:5000'), 'http://192.168.1.8:5000');
    assert.equal(normalizeServerBaseUrl('https://lan.example/'), 'https://lan.example');
    assert.equal(normalizeServerBaseUrl(''), null);
});

test('无服务器配置时静默跳过更新检查', async () => {
    const state = createUpdateState();
    let calls = 0;
    const feature = createAutoUpdateFeature({
        invoke: async () => { calls += 1; },
        isTauriClient: true,
        patchState: (values) => Object.assign(state, values),
    });
    const result = await feature.checkSilently('');
    assert.equal(result.skipped, true);
    assert.equal(state.status, 'skipped');
    assert.equal(calls, 0);
});

test('更新检查结果和网络失败都会落入可观察状态', async () => {
    const state = createUpdateState();
    const calls = [];
    const feature = createAutoUpdateFeature({
        invoke: async (command, payload) => {
            calls.push({ command, payload });
            return { available: true, version: '0.2.0', currentVersion: '0.1.0', notes: 'P1' };
        },
        isTauriClient: true,
        patchState: (values) => Object.assign(state, values),
    });
    await feature.checkSilently('10.0.0.2:5000');
    assert.equal(state.status, 'available');
    assert.equal(state.version, '0.2.0');
    assert.deepEqual(calls[0], {
        command: 'check_for_update',
        payload: { serverBaseUrl: 'http://10.0.0.2:5000' },
    });

    const unavailable = createAutoUpdateFeature({
        invoke: async () => { throw new Error('offline'); },
        isTauriClient: true,
        patchState: (values) => Object.assign(state, values),
        logger: { debug() {} },
    });
    await unavailable.checkSilently('10.0.0.2:5000');
    assert.equal(state.status, 'unavailable');
    assert.match(state.error, /offline/);
});

test('安装进度事件会更新下载状态', async () => {
    const state = createUpdateState();
    let progressHandler = null;
    const feature = createAutoUpdateFeature({
        invoke: async () => ({ available: false }),
        isTauriClient: true,
        patchState: (values) => Object.assign(state, values),
    });

    await feature.attachProgressListener(async (eventName, handler) => {
        assert.equal(eventName, 'update-download-progress');
        progressHandler = handler;
        return () => {};
    });

    progressHandler({
        payload: {
            phase: 'downloading',
            downloadedBytes: 50,
            totalBytes: 100,
            progressPercent: 50,
        },
    });
    assert.equal(state.status, 'downloading');
    assert.equal(state.progressPercent, 50);

    progressHandler({
        payload: {
            phase: 'installing',
            downloadedBytes: 100,
            totalBytes: 100,
            progressPercent: 100,
        },
    });
    assert.equal(state.status, 'installing');
    assert.equal(state.progressPercent, 100);
});
