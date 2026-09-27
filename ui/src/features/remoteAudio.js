import { logError } from '../shared/errors.js';

/** 创建远端音频路由模块；优先用 GainNode 控制每个成员/音源音量。 */
export function createRemoteAudioFeature(context) {
    const remoteAudioGainNodes = {};

    /** 为远端 track 建立 GainNode 路由，并套用该成员已保存的音量。 */
    function addRemoteGainNode(identity, source, track, audioEl) {
        const volumes = context.ensureParticipantVolumeState(identity);
        const gain = volumes[source] !== undefined ? volumes[source] : 1;
        context.ensureAudioContext();

        const remoteAudioContext = context.getRemoteAudioContext();
        if (!remoteAudioContext) {
            audioEl.volume = Math.max(0, Math.min(gain, 1));
            audioEl.muted = false;
            return;
        }

        const mediaTrack = track && track.mediaStreamTrack;
        if (!mediaTrack) return;

        try {
            const streamSource = remoteAudioContext.createMediaStreamSource(new MediaStream([mediaTrack]));
            const gainNode = remoteAudioContext.createGain();
            streamSource.connect(gainNode);
            gainNode.connect(remoteAudioContext.destination);

            audioEl.__gainAttached = true;
            audioEl.__gainNode = gainNode;
            audioEl.__streamSource = streamSource;
            audioEl.__trackSid = track.sid;
            audioEl.__playbackEnabled = true;
            gainNode.gain.value = gain;
        } catch (e) {
            logError('remoteAudio/addRemoteGainNode 创建 GainNode 路由失败，回退到 audio.volume', e, 'warn');
            audioEl.volume = Math.max(0, Math.min(gain, 1));
            audioEl.muted = false;
            return;
        }

        const key = `${identity}:${source}`;
        if (!remoteAudioGainNodes[key]) remoteAudioGainNodes[key] = [];
        remoteAudioGainNodes[key].push(audioEl);
    }

    /** 断开所有远端音频 GainNode，通常在离开房间或重连时调用。 */
    function clearRemoteGainNodes() {
        Object.keys(remoteAudioGainNodes).forEach(key => {
            remoteAudioGainNodes[key].forEach((audioEl) => {
                try { audioEl.__streamSource && audioEl.__streamSource.disconnect(); } catch (_) {}
                try { audioEl.__gainNode && audioEl.__gainNode.disconnect(); } catch (_) {}
            });
            delete remoteAudioGainNodes[key];
        });
    }

    /** 按 trackSid 清理某一路远端音频，避免 TrackUnsubscribed 后残留播放链路。 */
    function removeRemoteAudioRouteByTrackSid(trackSid) {
        if (!trackSid) return;
        Object.keys(remoteAudioGainNodes).forEach((key) => {
            remoteAudioGainNodes[key] = remoteAudioGainNodes[key].filter((audioEl) => {
                if (audioEl.__trackSid !== trackSid) return true;
                try { audioEl.__streamSource && audioEl.__streamSource.disconnect(); } catch (_) {}
                try { audioEl.__gainNode && audioEl.__gainNode.disconnect(); } catch (_) {}
                return false;
            });
            if (remoteAudioGainNodes[key].length === 0) delete remoteAudioGainNodes[key];
        });
    }

    /** 更新某个成员某类音源的音量，并立即写入 GainNode 与 localStorage。 */
    function setParticipantVolume(identity, source, volumeValue) {
        context.ensureAudioContext();
        const volumes = context.ensureParticipantVolumeState(identity);
        if (!['mic', 'screen', 'appaudio'].includes(source)) return;

        volumes[source] = context.normalizeGainValue(volumeValue);
        context.saveUserVolumesToStorage();

        const key = `${identity}:${source}`;
        const gain = volumes[source];
        const gains = remoteAudioGainNodes[key] || [];
        gains.forEach((audioEl) => {
            if (audioEl.__gainNode) audioEl.__gainNode.gain.value = audioEl.__playbackEnabled === false ? 0 : gain;
        });

        // 兜底：如果 GainNode 路由不可用，仍然修改原生 audio 元素音量。
        document.querySelectorAll('[data-audio-identity][data-audio-source]').forEach((audioEl) => {
            if (audioEl.dataset.audioIdentity === String(identity) && audioEl.dataset.audioSource === source && !audioEl.__gainAttached) {
                audioEl.volume = Math.max(0, Math.min(gain, 1));
            }
        });
    }

    return {
        setTrackEnabled(trackSid, enabled) {
            document.querySelectorAll('[data-audio-track-sid]').forEach(el => {
                if (el.dataset.audioTrackSid !== trackSid) return;
                el.__playbackEnabled = enabled;
                const volumes = context.ensureParticipantVolumeState(el.dataset.audioIdentity);
                if (el.__gainNode) el.__gainNode.gain.value = enabled ? (volumes[el.dataset.audioSource] ?? 1) : 0;
                else el.muted = !enabled;
            });
        },
        addRemoteGainNode,
        clearRemoteGainNodes,
        removeRemoteAudioRouteByTrackSid,
        setParticipantVolume,
    };
}
