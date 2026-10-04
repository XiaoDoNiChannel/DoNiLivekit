import test from 'node:test';
import assert from 'node:assert/strict';

import { createAutoUpdateFeature } from '../src/features/autoUpdate.js';
import { createUpdateState } from '../src/stores/updateStore.js';

test('非 Tauri 环境静默跳过更新检查', async () => {
    const state = createUpdateState();
    let calls = 0;
    const feature = createAutoUpdateFeature({
        invoke: async () => { calls += 1; },
        isTauriClient: false,
        patchState: (values) => Object.assign(state, values),
    });
    const result = await feature.checkSilently();
    assert.equal(result.skipped, true);
    assert.equal(state.status, 'skipped');
    assert.equal(calls, 0);
});

test('更新检查结果和网络失败都会落入可观察状态', async () => {
    const state = createUpdateState();
    const calls = [];
    const feature = createAutoUpdateFeature({
        invoke: async (...args) => {
            calls.push(args);
            return { available: true, version: '0.2.0', currentVersion: '0.1.0', notes: 'P1' };
        },
        isTauriClient: true,
        patchState: (values) => Object.assign(state, values),
    });
    await feature.checkSilently();
    assert.equal(state.status, 'available');
    assert.equal(state.version, '0.2.0');
    assert.deepEqual(calls[0], ['check_for_update']);

    const unavailable = createAutoUpdateFeature({
        invoke: async () => { throw new Error('offline'); },
        isTauriClient: true,
        patchState: (values) => Object.assign(state, values),
        logger: { debug() {} },
    });
    await unavailable.checkSilently();
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

test('安装更新直接使用 Tauri 配置的 GitHub endpoint', async () => {
    const state = createUpdateState();
    const calls = [];
    const feature = createAutoUpdateFeature({
        invoke: async (...args) => {
            calls.push(args);
            return true;
        },
        isTauriClient: true,
        patchState: (values) => Object.assign(state, values),
    });

    const installed = await feature.installAvailable();
    assert.equal(installed, true);
    assert.deepEqual(calls, [['install_update']]);
    assert.equal(state.status, 'installed');
});

test('后台检查不会覆盖更新进度，重复更新只执行一次', async () => {
    const state = createUpdateState();
    const calls = [];
    let resolveCheck;
    let resolveInstall;
    const feature = createAutoUpdateFeature({
        invoke: (command) => {
            calls.push(command);
            return new Promise((resolve) => {
                if (command === 'check_for_update') resolveCheck = resolve;
                else resolveInstall = resolve;
            });
        },
        isTauriClient: true,
        patchState: (values) => Object.assign(state, values),
    });
    const check = feature.checkSilently();
    const install = feature.installAvailable();
    const duplicate = feature.installAvailable();
    resolveCheck({ available: true, version: '0.1.6' });
    await check;
    await Promise.resolve();
    assert.equal(state.status, 'downloading');
    assert.deepEqual(await feature.checkSilently(), { skipped: true });
    assert.deepEqual(calls, ['check_for_update', 'install_update']);
    resolveInstall(true);
    assert.deepEqual(await Promise.all([install, duplicate]), [true, true]);
});
