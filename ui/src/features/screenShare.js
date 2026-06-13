import { alertError, logError } from '../shared/errors.js';

/**
 * 屏幕共享模块。
 *
 * 负责：
 * - 屏幕共享开启/关闭
 * - 屏幕共享系统音频预检查与降级提示
 * - 本地屏幕预览
 * - 屏幕共享实际码率日志
 *
 * 这里通过 context 访问 room/isScreenOn，避免把 LiveKit 房间主状态搬离 client.js。
 */

export function createScreenShareFeature(context) {
    let screenBitrateMonitorTimer = null;
    let lastScreenOutboundStats = null;
    let currentScreenTargetBitrate = 0;
    let currentLocalScreenTrack = null;

    function getShareAudioErrorMessage(err) {
        const name = err?.name || 'UnknownError';
        if (name === 'NotAllowedError') return '你取消了系统音频授权，或未勾选“分享系统音频”。';
        if (name === 'NotReadableError') return '浏览器无法启动系统音频采集（常见于系统限制、驱动占用或浏览器能力限制）。';
        if (name === 'AbortError') return '共享窗口被关闭或共享流程被中断。';
        return `系统音频共享失败：${name}`;
    }

    function getSystemAudioPreflight() {
        const issues = [];
        const ua = navigator.userAgent || '';
        const isWindows = /Windows/i.test(ua);
        const isChromium = /Chrome|Edg/i.test(ua);
        const hasGetDisplayMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

        if (!hasGetDisplayMedia) issues.push('当前浏览器不支持屏幕共享 API（getDisplayMedia）。');
        if (!window.isSecureContext) issues.push('当前页面不是安全上下文（建议使用 HTTPS 或 localhost）。');
        if (!isWindows) issues.push('系统音频共享在非 Windows 平台上支持不稳定。');
        if (!isChromium) issues.push('建议使用最新版 Chrome 或 Edge 进行系统音频共享。');

        return { canTryAudio: hasGetDisplayMedia, issues };
    }

    function getDisplayMediaConstraints(withAudio = true) {
        const video = {
            frameRate: { ideal: 60, max: 60 },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            displaySurface: 'monitor',
        };
        if (!withAudio) return { video, audio: false };
        return {
            video,
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 2,
                sampleRate: 48000,
                sampleSize: 16,
                suppressLocalAudioPlayback: false,
                systemAudio: 'include',
            },
        };
    }

    function hasPublishedScreenAudioTrack() {
        const room = context.getRoom();
        if (!room || !room.localParticipant) return false;
        const pubs = Array.from(room.localParticipant.audioTrackPublications.values());
        return pubs.some(pub => {
            const source = pub?.source;
            return source === context.LivekitClient.Track.Source.ScreenShareAudio || source === 'screen_share_audio';
        });
    }

    function getLocalScreenPublication() {
        const room = context.getRoom();
        if (!room || !room.localParticipant) return null;
        const pubs = Array.from(room.localParticipant.videoTrackPublications.values());
        return pubs.find(pub => {
            const source = pub?.source;
            return source === context.LivekitClient.Track.Source.ScreenShare || source === 'screen_share';
        }) || null;
    }

    function showLocalScreenPreview(track) {
        const previewBox = document.getElementById('local-screen-preview-box');
        const previewVideo = document.getElementById('local-screen-preview');
        if (!previewBox || !previewVideo || !track) return;

        previewVideo.muted = true;

        if (currentLocalScreenTrack && currentLocalScreenTrack !== track) {
            currentLocalScreenTrack.detach(previewVideo);
        }

        track.attach(previewVideo);
        currentLocalScreenTrack = track;
        previewBox.style.display = 'block';
    }

    function hideLocalScreenPreview() {
        const previewBox = document.getElementById('local-screen-preview-box');
        const previewVideo = document.getElementById('local-screen-preview');
        if (!previewBox || !previewVideo) return;

        if (currentLocalScreenTrack) {
            currentLocalScreenTrack.detach(previewVideo);
            currentLocalScreenTrack = null;
        }

        previewVideo.srcObject = null;
        previewBox.style.display = 'none';
    }

    function stopScreenBitrateMonitor() {
        if (screenBitrateMonitorTimer) {
            clearInterval(screenBitrateMonitorTimer);
            screenBitrateMonitorTimer = null;
        }
        lastScreenOutboundStats = null;
        currentScreenTargetBitrate = 0;
    }

    async function logCurrentScreenBitrate() {
        const pub = getLocalScreenPublication();
        const targetText = currentScreenTargetBitrate > 0
            ? `${(currentScreenTargetBitrate / 1000000).toFixed(2)} Mbps`
            : '未设置';

        if (!pub || !pub.track) {
            console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=暂无（未找到屏幕视频轨道）`);
            return;
        }

        if (typeof pub.track.getRTCStatsReport !== 'function') {
            console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=暂无（SDK未暴露RTC stats接口）`);
            return;
        }

        try {
            const report = await pub.track.getRTCStatsReport();
            let outbound = null;

            const pickOutbound = (stat) => {
                if (!stat || stat.type !== 'outbound-rtp') return;
                const kind = stat.kind || stat.mediaType;
                if (kind !== 'video') return;
                if (!outbound || (stat.bytesSent || 0) > (outbound.bytesSent || 0)) outbound = stat;
            };

            if (Array.isArray(report)) report.forEach(pickOutbound);
            else if (report && typeof report.forEach === 'function') report.forEach(pickOutbound);

            if (!outbound) {
                console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=暂无（未抓到outbound-rtp/video）`);
                return;
            }

            const ts = outbound.timestamp instanceof Date ? outbound.timestamp.getTime() : Number(outbound.timestamp);
            const bytes = Number(outbound.bytesSent || 0);
            let actualBps = null;

            if (lastScreenOutboundStats && ts > lastScreenOutboundStats.ts && bytes >= lastScreenOutboundStats.bytes) {
                const deltaBytes = bytes - lastScreenOutboundStats.bytes;
                const deltaMs = ts - lastScreenOutboundStats.ts;
                if (deltaMs > 0) actualBps = (deltaBytes * 8 * 1000) / deltaMs;
            }

            lastScreenOutboundStats = { ts, bytes };

            if (actualBps === null) {
                console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=采集中...`);
            } else {
                console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=${(actualBps / 1000000).toFixed(2)} Mbps`);
            }
        } catch (err) {
            logError('screenShare/logCurrentScreenBitrate 读取 RTC stats 失败', err, 'warn');
        }
    }

    function startScreenBitrateMonitor(targetBitrate) {
        stopScreenBitrateMonitor();
        currentScreenTargetBitrate = targetBitrate;
        console.log(`[ScreenShare Stats] 开始监控，目标码率=${(targetBitrate / 1000000).toFixed(2)} Mbps`);
        logCurrentScreenBitrate();
        screenBitrateMonitorTimer = setInterval(logCurrentScreenBitrate, 2000);
    }

    async function toggleScreen() {
        const room = context.getRoom();
        if (!room) return;

        try {
            if (!context.getIsScreenOn()) {
                const resVal = document.getElementById('screen-res').value.split('x');
                const customWidth = parseInt(resVal[0]);
                const customHeight = parseInt(resVal[1]);
                const customFps = parseInt(document.getElementById('screen-fps').value);
                const customBitrate = parseInt(document.getElementById('screen-bitrate').value) * 1000;

                const captureOptions = {
                    audio: true,
                    captureOptions: getDisplayMediaConstraints(true),
                    resolution: { width: customWidth, height: customHeight, frameRate: customFps },
                };

                const publishOptions = {
                    screenShareEncoding: { maxBitrate: customBitrate, maxFramerate: customFps },
                    simulcast: false,
                    videoCodec: 'h264',
                    audioPreset: (context.LivekitClient.AudioPresets && (context.LivekitClient.AudioPresets.musicHighQuality || context.LivekitClient.AudioPresets.music)) || undefined,
                };

                let audioShareFailed = false;
                let audioShareError = null;
                const preflight = getSystemAudioPreflight();
                const shouldTryAudio = preflight.canTryAudio && window.isSecureContext;

                try {
                    await room.localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions);
                } catch (err) {
                    logError('screenShare/toggleScreen 抓取屏幕音视频流失败，准备降级为仅画面共享', err);
                    audioShareFailed = true;
                    audioShareError = err;

                    const fallbackCaptureOptions = {
                        audio: false,
                        captureOptions: getDisplayMediaConstraints(false),
                        resolution: { width: customWidth, height: customHeight, frameRate: customFps },
                    };

                    await room.localParticipant.setScreenShareEnabled(true, fallbackCaptureOptions, publishOptions);
                }

                const tracks = Array.from(room.localParticipant.videoTrackPublications.values());
                tracks.forEach(pub => {
                    if (pub.source === context.LivekitClient.Track.Source.ScreenShare && pub.track) {
                        pub.track.mediaStreamTrack.contentHint = 'motion';
                    }
                });

                const localScreenPub = getLocalScreenPublication();
                if (localScreenPub && localScreenPub.track) showLocalScreenPreview(localScreenPub.track);

                context.setIsScreenOn(true);
                const btn = document.getElementById('btn-screen');
                btn.classList.add('active');
                btn.innerHTML = '🛑';
                btn.setAttribute('data-tooltip', '停止共享');
                startScreenBitrateMonitor(customBitrate);

                document.getElementById('screen-res').disabled = true;
                document.getElementById('screen-fps').disabled = true;
                document.getElementById('screen-bitrate').disabled = true;

                if (shouldTryAudio && !audioShareFailed && !hasPublishedScreenAudioTrack()) {
                    audioShareFailed = true;
                    audioShareError = { name: 'NotReadableError', message: 'Screen share started but no system-audio track was published' };
                }

                if (!shouldTryAudio && preflight.issues.length > 0) {
                    alert('已开启屏幕共享（仅画面）。\n\n' +
                        '当前环境不满足系统音频共享条件：\n- ' + preflight.issues.join('\n- ') +
                        '\n\n推荐方案：\n' +
                        '1. 用 HTTPS 打开此页面（不要用 http://内网IP）；\n' +
                        '2. 使用最新版 Chrome/Edge；\n' +
                        '3. 重新共享时选择“整个屏幕”并勾选“分享系统音频”。');
                } else if (audioShareFailed) {
                    alert('已开启屏幕共享（仅画面）。\n\n' +
                        getShareAudioErrorMessage(audioShareError) +
                        '\n\n如需共享系统声音，请确认：\n' +
                        '1. 选择“整个屏幕”而不是“窗口”；\n' +
                        '2. 勾选“分享系统音频”；\n' +
                        '3. 关闭可能独占音频设备的软件后重试；\n' +
                        '4. Windows 声音设置中关闭播放设备“独占模式”；\n' +
                        '5. 尽量改为 HTTPS 访问页面（http://内网IP 常见失败）。');
                }
            } else {
                await room.localParticipant.setScreenShareEnabled(false);
                context.setIsScreenOn(false);
                const btn = document.getElementById('btn-screen');
                btn.classList.remove('active');
                btn.innerHTML = '💻';
                btn.setAttribute('data-tooltip', '共享屏幕');
                stopScreenBitrateMonitor();
                hideLocalScreenPreview();

                document.getElementById('screen-res').disabled = false;
                document.getElementById('screen-fps').disabled = false;
                document.getElementById('screen-bitrate').disabled = false;
            }
        } catch (e) {
            logError('screenShare/toggleScreen 屏幕共享流程失败', e);
            context.setIsScreenOn(false);
            stopScreenBitrateMonitor();
            hideLocalScreenPreview();
            document.getElementById('screen-res').disabled = false;
            document.getElementById('screen-fps').disabled = false;
            document.getElementById('screen-bitrate').disabled = false;
            alertError('屏幕共享失败', e, '请检查屏幕共享权限、浏览器能力和 LiveKit 连接状态。');
        }
    }

    return {
        toggleScreen,
        stopScreenBitrateMonitor,
        hideLocalScreenPreview,
        showLocalScreenPreview,
        getLocalScreenPublication,
        hasPublishedScreenAudioTrack,
    };
}
