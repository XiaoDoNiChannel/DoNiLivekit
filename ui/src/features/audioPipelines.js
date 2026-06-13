import { formatError, logError } from '../shared/errors.js';

/**
 * Audio pipeline module.
 *
 * 这个模块只负责“PCM WebSocket -> AudioWorklet -> MediaStreamTrack”的底层管线：
 * - 9001：应用音频共享管线，给 appAudio.js 发布 app-audio track 使用；
 * - 9002：Rust 麦克风管线，给 client.js 的 startRustMicShare() 发布 microphone track 使用；
 * - Rust 麦克风耳返监听开关。
 *
 * 这里刻意不处理 LiveKit 房间连接、不处理 publishTrack、不处理切频道。
 * 这样可以把高风险音频底层状态从 legacy/client.js 拆出去，同时保持 LiveKit 发布逻辑不变。
 */

function resolveSampleRate(sampleRate, fallback = 48000) {
    const targetSampleRate = Number(sampleRate);
    return Number.isFinite(targetSampleRate) && targetSampleRate >= 8000
        ? Math.round(targetSampleRate)
        : fallback;
}

function closeSocket(socket) {
    if (!socket) return;

    try {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;

        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close();
        }
    } catch (error) {
        logError('audioPipelines/closeSocket 关闭 WebSocket 失败', error, 'warn');
    }
}

async function waitForWebSocketOpen(socket, wsUrl, label) {
    await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`${label} WebSocket 连接超时：${wsUrl}。请检查 Rust 后端对应端口是否已启动。`));
        }, 2000);

        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };

        socket.onopen = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            console.log(`[${label} WS] 已连接`, wsUrl);
            resolve();
        };

        socket.onerror = () => {
            fail(new Error(`${label} WebSocket 连接失败：${wsUrl}。请检查 9001/9002 端口是否被占用或未启动。`));
        };

        socket.onclose = () => {
            fail(new Error(`${label} WebSocket 在初始化阶段被关闭：${wsUrl}。请检查 Rust 推流线程是否异常退出。`));
        };
    });
}

function bindPcmSocketToWorklet(socket, workletNode, label) {
    socket.onmessage = async (event) => {
        if (!workletNode) return;
        if (event.data instanceof ArrayBuffer) {
            workletNode.port.postMessage(event.data, [event.data]);
            return;
        }
        if (event.data instanceof Blob) {
            const arr = await event.data.arrayBuffer();
            workletNode.port.postMessage(arr, [arr]);
        }
    };

    socket.onerror = (err) => {
        logError(`audioPipelines/${label} WebSocket 运行中错误`, err);
    };

    socket.onclose = () => {
        console.warn(`[audioPipelines/${label}] WebSocket 已关闭`);
    };
}

export function createAudioPipelinesFeature() {
    // 9001 应用音频共享管线状态。
    let localPcmAudioContext = null;
    let localPcmWorkletNode = null;
    let localPcmDestination = null;
    let localPcmTrack = null;
    let localPcmSocket = null;
    let isLocalPcmPipelineReady = false;

    // 9002 Rust 麦克风管线状态。
    let localRustMicAudioContext = null;
    let localRustMicWorkletNode = null;
    let localRustMicDestination = null;
    let localRustMicTrack = null;
    let localRustMicSocket = null;
    let isRustMicPipelineReady = false;

    // Rust 麦克风耳返监听状态。
    let rustMicMonitorGain = null;
    let isMicMonitorOn = false;

    function getLocalPcmTrack() {
        return localPcmTrack;
    }

    function getLocalRustMicAudioContext() {
        return localRustMicAudioContext;
    }

    async function resumeLocalPcmAudioContext() {
        if (localPcmAudioContext && localPcmAudioContext.state === 'suspended') {
            await localPcmAudioContext.resume().catch(() => {});
        }
    }

    /**
     * 初始化 Rust 麦克风 9002 管线。
     * Rust 端通过 ws://127.0.0.1:9002 推送 Float32 PCM，
     * 前端 AudioWorklet 把它转成 MediaStreamTrack，再由 client.js 发布给 LiveKit。
     */
    async function initRustMicPipeline(sampleRate, wsUrl = 'ws://127.0.0.1:9002') {
        const resolvedSampleRate = resolveSampleRate(sampleRate);

        if (isRustMicPipelineReady && localRustMicAudioContext) {
            const currentRate = Number(localRustMicAudioContext.sampleRate || 0);
            if (Math.round(currentRate) === resolvedSampleRate) {
                return localRustMicTrack;
            }
            teardownRustMicPipeline();
        }

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
            console.warn('[audioPipelines/rustMic] 当前环境不支持 AudioContext，无法初始化 Rust 麦克风管线');
            return null;
        }

        try {
            localRustMicAudioContext = new Ctx({ sampleRate: resolvedSampleRate });
            await localRustMicAudioContext.audioWorklet.addModule('./pcm-worker.js');

            localRustMicWorkletNode = new AudioWorkletNode(localRustMicAudioContext, 'pcm-ring-buffer-processor', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: {
                    capacityFrames: resolvedSampleRate * 0.2 // Rust 麦克风使用 200ms 缓冲，优先低延迟。
                }
            });

            localRustMicDestination = localRustMicAudioContext.createMediaStreamDestination();

            // 主路：发送给 LiveKit。
            localRustMicWorkletNode.connect(localRustMicDestination);

            // 旁路：耳返监听，默认关闭；按钮只控制 gain，不重建管线。
            rustMicMonitorGain = localRustMicAudioContext.createGain();
            rustMicMonitorGain.gain.value = isMicMonitorOn ? 1.0 : 0.0;
            localRustMicWorkletNode.connect(rustMicMonitorGain);
            rustMicMonitorGain.connect(localRustMicAudioContext.destination);

            const tracks = localRustMicDestination.stream.getAudioTracks();
            localRustMicTrack = tracks.length > 0 ? tracks[0] : null;

            localRustMicSocket = new WebSocket(wsUrl);
            localRustMicSocket.binaryType = 'arraybuffer';

            try {
                await waitForWebSocketOpen(localRustMicSocket, wsUrl, 'Rust PCM');
            } catch (error) {
                logError('audioPipelines/rustMic WebSocket 初始化失败', error);
                teardownRustMicPipeline();
                throw new Error(formatError('Rust 麦克风 9002 管线初始化失败', error));
            }

            bindPcmSocketToWorklet(localRustMicSocket, localRustMicWorkletNode, 'Rust PCM');

            if (localRustMicAudioContext && localRustMicAudioContext.state === 'suspended') {
                await localRustMicAudioContext.resume();
            }

            if (!localRustMicTrack) {
                teardownRustMicPipeline();
                throw new Error('Rust 麦克风管线初始化失败：AudioWorklet 已启动，但没有生成可发布的 MediaStreamTrack。');
            }

            window.getRustMicTrack = () => localRustMicTrack;
            isRustMicPipelineReady = true;
            console.log(`[Rust PCM] 管线已初始化(sampleRate=${resolvedSampleRate})，可通过 window.getRustMicTrack() 获取 MediaStreamTrack`);

            return localRustMicTrack;
        } catch (error) {
            logError('audioPipelines/initRustMicPipeline 管线初始化失败', error);
            teardownRustMicPipeline();
            throw error;
        }
    }

    function teardownRustMicPipeline() {
        closeSocket(localRustMicSocket);
        localRustMicSocket = null;

        if (localRustMicTrack) {
            try { localRustMicTrack.stop(); } catch (_) {}
            localRustMicTrack = null;
        }

        if (rustMicMonitorGain) {
            try { rustMicMonitorGain.disconnect(); } catch (_) {}
            rustMicMonitorGain = null;
        }

        if (localRustMicWorkletNode) {
            try { localRustMicWorkletNode.disconnect(); } catch (_) {}
            localRustMicWorkletNode = null;
        }

        localRustMicDestination = null;

        if (localRustMicAudioContext) {
            localRustMicAudioContext.close().catch(() => {});
            localRustMicAudioContext = null;
        }

        isRustMicPipelineReady = false;
    }

    /**
     * 初始化应用音频 9001 管线。
     * Rust 端根据用户选择的进程推送 Float32 PCM，
     * appAudio.js 再把这里返回的 MediaStreamTrack 发布成 app-audio。
     */
    async function initLocalPcmPipeline(sampleRate, wsUrl = 'ws://127.0.0.1:9001') {
        const resolvedSampleRate = resolveSampleRate(sampleRate);

        if (isLocalPcmPipelineReady && localPcmAudioContext) {
            const currentRate = Number(localPcmAudioContext.sampleRate || 0);
            if (Math.round(currentRate) === resolvedSampleRate) {
                return localPcmTrack;
            }
            teardownLocalPcmPipeline();
        }

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
            console.warn('[audioPipelines/appAudio] 当前环境不支持 AudioContext，无法初始化应用音频 PCM 管线');
            return null;
        }

        try {
            localPcmAudioContext = new Ctx({ sampleRate: resolvedSampleRate });
            await localPcmAudioContext.audioWorklet.addModule('./pcm-worker.js');

            localPcmWorkletNode = new AudioWorkletNode(localPcmAudioContext, 'pcm-ring-buffer-processor', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                processorOptions: {
                    capacityFrames: resolvedSampleRate * 0.4 // 应用音频使用 400ms 缓冲，优先抗抖动。
                }
            });

            localPcmDestination = localPcmAudioContext.createMediaStreamDestination();
            localPcmWorkletNode.connect(localPcmDestination);
            // 调试监听可临时打开：localPcmWorkletNode.connect(localPcmAudioContext.destination);

            const tracks = localPcmDestination.stream.getAudioTracks();
            localPcmTrack = tracks.length > 0 ? tracks[0] : null;

            localPcmSocket = new WebSocket(wsUrl);
            localPcmSocket.binaryType = 'arraybuffer';

            try {
                await waitForWebSocketOpen(localPcmSocket, wsUrl, 'PCM');
            } catch (error) {
                logError('audioPipelines/appAudio WebSocket 初始化失败', error);
                teardownLocalPcmPipeline();
                throw new Error(formatError('应用音频 9001 管线初始化失败', error));
            }

            bindPcmSocketToWorklet(localPcmSocket, localPcmWorkletNode, 'PCM');

            if (localPcmAudioContext && localPcmAudioContext.state === 'suspended') {
                await localPcmAudioContext.resume();
            }

            if (!localPcmTrack) {
                teardownLocalPcmPipeline();
                throw new Error('应用音频管线初始化失败：AudioWorklet 已启动，但没有生成可发布的 MediaStreamTrack。');
            }

            window.getLocalPcmTrack = getLocalPcmTrack;
            isLocalPcmPipelineReady = true;
            console.log(`[PCM] 管线已初始化(sampleRate=${resolvedSampleRate})，可通过 window.getLocalPcmTrack() 获取 MediaStreamTrack`);

            return localPcmTrack;
        } catch (error) {
            logError('audioPipelines/initLocalPcmPipeline 管线初始化失败', error);
            teardownLocalPcmPipeline();
            throw error;
        }
    }

    function teardownLocalPcmPipeline() {
        closeSocket(localPcmSocket);
        localPcmSocket = null;

        if (localPcmTrack) {
            try { localPcmTrack.stop(); } catch (_) {}
            localPcmTrack = null;
        }

        if (localPcmWorkletNode) {
            try { localPcmWorkletNode.disconnect(); } catch (_) {}
            localPcmWorkletNode = null;
        }

        localPcmDestination = null;

        if (localPcmAudioContext) {
            localPcmAudioContext.close().catch(() => {});
            localPcmAudioContext = null;
        }

        isLocalPcmPipelineReady = false;
    }

    function toggleMicMonitor() {
        isMicMonitorOn = !isMicMonitorOn;
        const btn = document.getElementById('btn-mic-monitor');

        if (rustMicMonitorGain) {
            rustMicMonitorGain.gain.value = isMicMonitorOn ? 1.0 : 0.0;
        }

        if (btn) {
            btn.classList.toggle('active', isMicMonitorOn);
            btn.setAttribute('data-tooltip', isMicMonitorOn ? '监听开' : '监听关');
        }
    }

    return {
        initRustMicPipeline,
        teardownRustMicPipeline,
        initLocalPcmPipeline,
        teardownLocalPcmPipeline,
        getLocalPcmTrack,
        getLocalRustMicAudioContext,
        resumeLocalPcmAudioContext,
        toggleMicMonitor,
        getIsMicMonitorOn: () => isMicMonitorOn,
    };
}
