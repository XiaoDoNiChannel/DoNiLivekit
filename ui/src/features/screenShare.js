import { alertError, logError } from '../shared/errors.js';

/** Screen capture is video-only. Program audio is published independently by Rust. */
export function createScreenShareFeature(context) {
    let currentLocalScreenTrack = null;
    let busy = false;
    function getLocalScreenPublication() {
        return [...(context.getRoom()?.localParticipant?.videoTrackPublications?.values() || [])]
            .find(pub => pub.source === 'screen_share') || null;
    }
    function showLocalScreenPreview(track) {
        const video = document.getElementById('local-screen-preview');
        const box = document.getElementById('local-screen-preview-box');
        if (!video || !box || !track) return;
        if (currentLocalScreenTrack && currentLocalScreenTrack !== track) currentLocalScreenTrack.detach(video);
        video.muted = true; track.attach(video); currentLocalScreenTrack = track;
        box.style.display = 'block';
    }
    function hideLocalScreenPreview() {
        const video = document.getElementById('local-screen-preview');
        if (video) { currentLocalScreenTrack?.detach(video); video.srcObject = null; }
        currentLocalScreenTrack = null;
        const box = document.getElementById('local-screen-preview-box');
        if (box) box.style.display = 'none';
    }
    function stopScreenBitrateMonitor() { context.onTargetChanged?.(null); }
    function syncStopped() {
        context.setIsScreenOn(false); hideLocalScreenPreview(); stopScreenBitrateMonitor();
        for (const id of ['screen-res', 'screen-fps', 'screen-bitrate']) {
            const el = document.getElementById(id); if (el) el.disabled = false;
        }
    }
    async function toggleScreen() {
        const room = context.getRoom();
        if (!room || busy) return;
        busy = true;
        try {
            if (context.getIsScreenOn()) {
                await room.localParticipant.setScreenShareEnabled(false); syncStopped(); return;
            }
            const [width, height] = (document.getElementById('screen-res')?.value || '1920x1080').split('x').map(Number);
            const fps = Number(document.getElementById('screen-fps')?.value || 30);
            const bitrateKbps = Number(document.getElementById('screen-bitrate')?.value || 5000);
            await room.localParticipant.setScreenShareEnabled(true, {
                audio: false, systemAudio: 'exclude',
                resolution: { width, height, frameRate: fps },
            }, {
                screenShareEncoding: { maxBitrate: bitrateKbps * 1000, maxFramerate: fps },
                simulcast: false, videoCodec: 'h264',
            });
            if (context.getRoom() !== room) {
                await room.localParticipant.setScreenShareEnabled(false); return;
            }
            const pub = getLocalScreenPublication();
            if (pub?.track) {
                pub.track.mediaStreamTrack.contentHint = 'motion';
                showLocalScreenPreview(pub.track);
            }
            context.setIsScreenOn(true);
            context.onTargetChanged?.({ trackSid: pub?.trackSid, width, height, fps, bitrateKbps });
            for (const id of ['screen-res', 'screen-fps', 'screen-bitrate']) {
                const el = document.getElementById(id); if (el) el.disabled = true;
            }
        } catch (error) {
            syncStopped();
            if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
                logError('screenShare/toggleScreen', error);
                alertError('屏幕共享失败', error, '请检查屏幕录制权限和连接状态。');
            }
        } finally { busy = false; }
    }
    return { toggleScreen, stopScreenBitrateMonitor, hideLocalScreenPreview, showLocalScreenPreview,
        getLocalScreenPublication, syncStopped, hasPublishedScreenAudioTrack: () => false };
}
