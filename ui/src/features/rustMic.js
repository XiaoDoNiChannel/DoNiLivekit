import { alertError, formatError, logError } from '../shared/errors.js';

/** 创建 Rust 麦克风发布模块；负责把 9002 产生的 track 发布成 LiveKit microphone。 */
export function createRustMicFeature(context) {
    const MIC_SOURCE_STORAGE_KEY = 'lk_mic_source';
    let isMicOn = false;
    const savedMicSource = localStorage.getItem(MIC_SOURCE_STORAGE_KEY);
    let currentMicSource = context.isTauriClient && savedMicSource === 'browser' ? 'browser' : (context.isTauriClient ? 'rust' : 'browser');
    let isRustMicOn = false;
    let localRustMicPublication = null;
    let hasRegisteredRustMicErrorListener = false;
    let lastRustMicErrorAt = 0;
    let micLifecycleChain = Promise.resolve();

    function enqueueMicLifecycle(action) {
        const next = micLifecycleChain.then(action, action);
        micLifecycleChain = next.catch(() => {});
        return next;
    }

    /** 浏览器麦克风 fallback 的约束配置，Rust 麦克风不使用这组参数。 */
    function getMicCaptureOptions() {
        const savedDeviceId = localStorage.getItem('lk_mic') || undefined;
        return {
            deviceId: savedDeviceId,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        };
    }

    function showRustMicUi() {
        const vadModule = document.getElementById('vad-module');
        const monitorBtn = document.getElementById('btn-mic-monitor');
        if (vadModule) vadModule.style.display = 'block';
        if (monitorBtn) monitorBtn.style.display = 'flex';
    }

    function hideRustMicUi() {
        const vadModule = document.getElementById('vad-module');
        const monitorBtn = document.getElementById('btn-mic-monitor');
        if (vadModule) vadModule.style.display = 'none';
        if (monitorBtn) monitorBtn.style.display = 'none';
    }

    /** 根据当前麦克风来源和开关状态刷新左下角麦克风按钮。 */
    function updateMicSourceButton() {
        const btn = document.getElementById('btn-mic');
        if (!btn) return;

        if (isMicOn) {
            btn.classList.add('active');

            btn.setAttribute('data-tooltip', currentMicSource === 'rust' ? '关闭 Rust 麦克风' : '关闭浏览器麦克风');
        } else {
            btn.classList.remove('active');

            btn.setAttribute('data-tooltip', currentMicSource === 'rust' ? '开启 Rust 麦克风' : '开启浏览器麦克风');
        }
    }

    /** 在浏览器麦克风和 Rust 麦克风之间切换；已开麦时会自动切换发布源。 */
    async function switchMicSource(source) {
        if (source !== 'browser' && source !== 'rust') return;
        if (!context.isTauriClient && source === 'rust') return;
        if (currentMicSource === source) return;

        const room = context.getRoom();
        const wasMicOn = isMicOn;
        const previousSource = currentMicSource;
        const micSelect = document.getElementById('mic-select');
        if (micSelect) {
            micSelect.disabled = !(room && room.localParticipant);
        }

        try {
            if (room?.localParticipant && wasMicOn) {
                if (previousSource === 'rust') {
                    await stopRustMicShare();
                } else {
                    await room.localParticipant.setMicrophoneEnabled(false);
                    isMicOn = false;
                }
            }

            currentMicSource = source;
            localStorage.setItem(MIC_SOURCE_STORAGE_KEY, source);

            if (room?.localParticipant && wasMicOn) {
                if (source === 'rust') {
                    await startRustMicShare();
                    isRustMicOn = true;
                    showRustMicUi();
                } else {
                    await room.localParticipant.setMicrophoneEnabled(true, getMicCaptureOptions());
                    isRustMicOn = false;
                    hideRustMicUi();
                }
                isMicOn = true;
            } else if (source === 'rust') {
                showRustMicUi();
            } else {
                hideRustMicUi();
            }
        } catch (error) {
            isMicOn = false;
            isRustMicOn = false;
            logError('rustMic/switchMicSource 切换麦克风处理模式失败', error);
            alertError('切换麦克风处理模式失败', error);
        }

        updateMicSourceButton();
        await context.updateMicList();
    }

    /** 启动 Rust 采集、初始化 9002 管线，并 publish 为 LiveKit microphone track。 */
    async function startRustMicShareNow() {
        const room = context.getRoom();
        if (!room || !room.localParticipant) {
            throw new Error('无法启动 Rust 麦克风：当前没有连接到 LiveKit 房间。');
        }

        let track = null;

        try {
            const sampleRate = await context.invoke('query_mic_sample_rate');
            await context.invoke('toggle_rust_mic', { enable: true });

            track = await context.initRustMicPipeline(sampleRate, 'ws://127.0.0.1:9002');
            if (!track) {
                throw new Error('Rust 麦克风启动失败：9002 管线没有返回可发布的 MediaStreamTrack。');
            }

            if (track.readyState !== 'live') {
                throw new Error(`Rust 麦克风 track 状态异常：${track.readyState}，预期应为 live。`);
            }

            track.enabled = true;
            console.log('[Rust Mic] 准备发布到当前频道', {
                channel: context.getCurrentChannel(),
                trackId: track.id,
                readyState: track.readyState,
                enabled: track.enabled,
                muted: track.muted,
            });

            if (localRustMicPublication) {
                try {
                    await room.localParticipant.unpublishTrack(localRustMicPublication.track);
                } catch (e) {
                    logError('rustMic/startRustMicShare 取消旧 Rust 麦克风发布失败', e, 'warn');
                }
                localRustMicPublication = null;
            }

            localRustMicPublication = await room.localParticipant.publishTrack(track, {
                name: 'microphone',
                source: context.LivekitClient.Track.Source.Microphone,
            });

            console.log('[Rust Mic] 已发布到当前频道', {
                channel: context.getCurrentChannel(),
                publicationSid: localRustMicPublication?.sid,
                trackSid: localRustMicPublication?.trackSid,
                source: localRustMicPublication?.source,
                isMuted: localRustMicPublication?.isMuted,
            });

            isRustMicOn = true;
            return localRustMicPublication;
        } catch (error) {
            logError('rustMic/startRustMicShare 启动 Rust 麦克风失败', error);

            await context.invoke('toggle_rust_mic', { enable: false }).catch((toggleError) => {
                logError('rustMic/startRustMicShare 回滚 Rust 麦克风运行状态失败', toggleError, 'warn');
            });
            context.teardownRustMicPipeline();

            localRustMicPublication = null;
            isRustMicOn = false;

            throw new Error(formatError('启动 Rust 麦克风失败', error));
        }
    }

    /** 停止 Rust 麦克风发布并释放 9002 管线。 */
    async function stopRustMicShareNow() {
        await context.invoke('toggle_rust_mic', { enable: false }).catch((error) => {
            logError('rustMic/stopRustMicShare 关闭 Rust 采集状态失败', error, 'warn');
        });

        const room = context.getRoom();
        try {
            if (localRustMicPublication && room && room.localParticipant) {
                await room.localParticipant.unpublishTrack(localRustMicPublication.track);
            }
        } catch (e) {
            logError('rustMic/stopRustMicShare 取消发布 Rust 麦克风失败', e, 'warn');
        } finally {
            localRustMicPublication = null;
            context.teardownRustMicPipeline();
            isRustMicOn = false;
            isMicOn = false;
        }
    }

    function startRustMicShare() {
        return enqueueMicLifecycle(() => startRustMicShareNow());
    }

    function stopRustMicShare() {
        return enqueueMicLifecycle(() => stopRustMicShareNow());
    }

    /** 旧按钮兼容入口：只切换 Rust 麦克风，不处理浏览器麦克风。 */
    async function toggleRustMicShare() {
        const btn = document.getElementById('btn-rust-mic');
        if (!isRustMicOn) {
            try {
                await startRustMicShare();
                if (btn) {
                    btn.classList.add('active');

                }
            } catch (error) {
                logError('rustMic/toggleRustMicShare 启动麦克风失败', error);
                alertError('启动麦克风失败', error);
                isRustMicOn = false;
            }
        } else {
            await stopRustMicShare();
            if (btn) {
                btn.classList.remove('active');

            }
        }
    }

    /** 主麦克风按钮入口：按当前选择使用 Rust 管线或浏览器 AEC 管线。 */
    async function toggleMic() {
        const btn = document.getElementById('btn-mic');
        const room = context.getRoom();
        const useRustMic = context.isTauriClient && currentMicSource === 'rust';

        if (!room?.localParticipant) {
            alertError('麦克风启动失败', new Error('当前没有连接到语音频道'));
            return;
        }

        if (!isMicOn) {
            try {
                if (useRustMic) {
                    await startRustMicShare();
                    showRustMicUi();
                } else {
                    await room.localParticipant.setMicrophoneEnabled(true, getMicCaptureOptions());
                    hideRustMicUi();
                }

                isMicOn = true;
                if (btn) {
                    btn.classList.add('active');

                    btn.setAttribute('data-tooltip', useRustMic ? '关闭 Rust 麦克风' : '关闭浏览器麦克风');
                }
            } catch (e) {
                logError('rustMic/toggleMic 开麦失败', e);
                alertError('麦克风启动失败', e);
            }
        } else {
            try {
                if (useRustMic) {
                    await stopRustMicShare();
                    hideRustMicUi();
                } else {
                    await room.localParticipant.setMicrophoneEnabled(false);
                }

                isMicOn = false;
                if (btn) {
                    btn.classList.remove('active');

                    btn.setAttribute('data-tooltip', useRustMic ? '开启 Rust 麦克风' : '开启浏览器麦克风');
                }
            } catch (e) {
                logError('rustMic/toggleMic 关麦失败', e);
            }
        }
        await context.updateMicList();
    }

    /** 监听 Rust 后端 mic_error，避免同一秒内重复弹窗。 */
    function registerRustMicErrorListener() {
        if (hasRegisteredRustMicErrorListener) return;
        hasRegisteredRustMicErrorListener = true;

        context.listen('mic_error', (event) => {
            const now = Date.now();
            if (now - lastRustMicErrorAt < 1500) return;
            lastRustMicErrorAt = now;

            const message = event && event.payload ? String(event.payload) : '未知麦克风错误';
            console.error('[rustMic/mic_error]', message);

            const fillBar = document.getElementById('vad-fill-bar');
            if (fillBar) fillBar.style.width = '0%';

            hideRustMicUi();
            isRustMicOn = false;
            isMicOn = false;
            updateMicSourceButton();

            alert(`Rust 麦克风捕获失败：${message}`);
        });
    }

    function setMicOn(value) {
        isMicOn = !!value;
    }

    function setRustMicOn(value) {
        isRustMicOn = !!value;
    }

    return {
        getMicCaptureOptions,
        updateMicSourceButton,
        switchMicSource,
        startRustMicShare,
        stopRustMicShare,
        toggleRustMicShare,
        toggleMic,
        registerRustMicErrorListener,
        showRustMicUi,
        hideRustMicUi,
        getIsMicOn: () => isMicOn,
        setMicOn,
        getCurrentMicSource: () => currentMicSource,
        getIsRustMicOn: () => isRustMicOn,
        setRustMicOn,
        getLocalRustMicPublication: () => localRustMicPublication,
        hasLocalRustMicPublication: () => !!localRustMicPublication,
    };
}
