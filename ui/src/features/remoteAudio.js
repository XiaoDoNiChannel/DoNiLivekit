import { logError } from '../shared/errors.js';

/**
 * 远端音频路由与音量模块。
 *
 * 负责把 LiveKit 远端音频轨道接入 AudioContext + GainNode，
 * 并把每个用户、每种音源（麦克风/屏幕/应用音频）的音量保存到 localStorage。
 */

export function createRemoteAudioFeature(context) {
    const remoteAudioGainNodes = {};

    function addRemoteGainNode(identity, source, track, audioEl) {
        const volumes = context.ensureParticipantVolumeState(identity);
        const gain = volumes[source] !== undefined ? volumes[source] : 1;
        context.ensureAudioContext();

        const remoteAudioContext = context.getRemoteAudioContext();
        if (!remoteAudioContext) {
            audioEl.volume = Math.max(0, Math.min(gain, 1));
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
            gainNode.gain.value = gain;
        } catch (e) {
            logError('remoteAudio/addRemoteGainNode 创建 GainNode 路由失败，回退到 audio.volume', e, 'warn');
            audioEl.volume = Math.max(0, Math.min(gain, 1));
            return;
        }

        const key = `${identity}:${source}`;
        if (!remoteAudioGainNodes[key]) remoteAudioGainNodes[key] = [];
        remoteAudioGainNodes[key].push(audioEl);
    }

    function clearRemoteGainNodes() {
        Object.keys(remoteAudioGainNodes).forEach(key => {
            remoteAudioGainNodes[key].forEach((audioEl) => {
                try { audioEl.__streamSource && audioEl.__streamSource.disconnect(); } catch (_) {}
                try { audioEl.__gainNode && audioEl.__gainNode.disconnect(); } catch (_) {}
            });
            delete remoteAudioGainNodes[key];
        });
    }

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
            if (audioEl.__gainNode) audioEl.__gainNode.gain.value = gain;
        });

        // 兜底：如果 GainNode 路由不可用，仍然修改原生 audio 元素音量。
        document.querySelectorAll('[data-audio-identity][data-audio-source]').forEach((audioEl) => {
            if (audioEl.dataset.audioIdentity === String(identity) && audioEl.dataset.audioSource === source && !audioEl.__gainAttached) {
                audioEl.volume = Math.max(0, Math.min(gain, 1));
            }
        });
    }

    return {
        addRemoteGainNode,
        clearRemoteGainNodes,
        removeRemoteAudioRouteByTrackSid,
        setParticipantVolume,
    };
}
