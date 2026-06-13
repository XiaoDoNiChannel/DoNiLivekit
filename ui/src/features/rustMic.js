import { alertError, formatError, logError } from '../shared/errors.js';

/**
 * Rust microphone publish module.
 *
 * 负责 9002 Rust 麦克风“发布到 LiveKit”的这一层：
 * - 查询 Rust 侧麦克风采样率；
 * - 启停 Rust 麦克风采集；
 * - 使用 audioPipelines.js 创建 MediaStreamTrack；
 * - publishTrack/unpublishTrack；
 * - 开关按钮、耳返按钮显示、mic_error 监听。
 *
 * 注意：这里不直接处理 PCM WebSocket 和 AudioWorklet，那部分已经在 audioPipelines.js。
 */

export function createRustMicFeature(context) {
    let isMicOn = false;
    let currentMicSource = context.isTauriClient ? 'rust' : 'browser';
    let isRustMicOn = false;
    let localRustMicPublication = null;
    let hasRegisteredRustMicErrorListener = false;
    let lastRustMicErrorAt = 0;

    function getMicCaptureOptions() {
        return {
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

    function updateMicSourceButton() {
        const btn = document.getElementById('btn-mic');
        if (!btn) return;

        if (isMicOn) {
            btn.classList.add('active');
            btn.innerHTML = '🔇';
            btn.setAttribute('data-tooltip', currentMicSource === 'rust' ? '关闭 Rust 麦克风' : '关闭浏览器麦克风');
        } else {
            btn.classList.remove('active');
            btn.innerHTML = '🎤';
            btn.setAttribute('data-tooltip', currentMicSource === 'rust' ? '开启 Rust 麦克风' : '开启浏览器麦克风');
        }
    }

    function switchMicSource(source) {
        if (source !== 'browser' && source !== 'rust') return;
        if (currentMicSource === source) return;
        currentMicSource = source;

        const room = context.getRoom();
        const micSelect = document.getElementById('mic-select');
        if (micSelect) {
            micSelect.disabled = !(room && room.localParticipant);
        }

        updateMicSourceButton();

        if (!room || !room.localParticipant) return;
        if (!isMicOn) return;

        if (source === 'browser') {
            stopRustMicShare().then(() => {
                room.localParticipant.setMicrophoneEnabled(true, getMicCaptureOptions()).catch((e) => {
                    logError('rustMic/switchMicSource 切换到浏览器麦克风失败', e);
                });
            }).catch((error) => logError('rustMic/switchMicSource 停止 Rust 麦克风失败', error));
        } else {
            room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
            startRustMicShare().catch((e) => {
                logError('rustMic/switchMicSource 切换到 Rust 麦克风失败', e);
            });
        }
    }

    async function startRustMicShare() {
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

    async function stopRustMicShare() {
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

    async function toggleRustMicShare() {
        const btn = document.getElementById('btn-rust-mic');
        if (!isRustMicOn) {
            try {
                await startRustMicShare();
                if (btn) {
                    btn.classList.add('active');
                    btn.innerHTML = '🔇 <span>关闭麦克风</span>';
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
                btn.innerHTML = '🎙️ <span>开启麦克风</span>';
            }
        }
    }

    async function toggleMic() {
        const btn = document.getElementById('btn-mic');
        const room = context.getRoom();

        if (!isMicOn) {
            try {
                if (context.isTauriClient) {
                    await startRustMicShare();
                    showRustMicUi();
                } else {
                    await room.localParticipant.setMicrophoneEnabled(true, getMicCaptureOptions());
                    hideRustMicUi();
                }

                isMicOn = true;
                if (btn) {
                    btn.classList.add('active');
                    btn.innerHTML = '🔇';
                    btn.setAttribute('data-tooltip', context.isTauriClient ? '关闭 Rust 麦克风' : '关闭浏览器麦克风');
                }
            } catch (e) {
                logError('rustMic/toggleMic 开麦失败', e);
                alertError('麦克风启动失败', e);
            }
        } else {
            try {
                if (context.isTauriClient) {
                    await stopRustMicShare();
                    hideRustMicUi();
                } else {
                    await room.localParticipant.setMicrophoneEnabled(false);
                }

                isMicOn = false;
                if (btn) {
                    btn.classList.remove('active');
                    btn.innerHTML = '🎤';
                    btn.setAttribute('data-tooltip', context.isTauriClient ? '开启 Rust 麦克风' : '开启浏览器麦克风');
                }
            } catch (e) {
                logError('rustMic/toggleMic 关麦失败', e);
            }
        }
        await context.updateMicList();
    }

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
