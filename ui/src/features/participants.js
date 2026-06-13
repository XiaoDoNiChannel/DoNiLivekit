/**
 * Participants module.
 *
 * 负责成员列表和“正在说话”状态：
 * - 渲染左侧成员列表；
 * - 渲染每个远端用户的麦克风/屏幕/应用音频音量滑块；
 * - 根据 LiveKit ActiveSpeakersChanged 事件维护 active-speaker 高亮；
 * - 保存和读取用户音量的具体逻辑仍由 participantVolumes.js 提供。
 *
 * 这个模块不连接 LiveKit，也不发布/订阅音轨，只做 UI 渲染和轻量状态维护。
 */

export function createParticipantsFeature(context) {
    const activeSpeakerIdentities = new Set();
    const activeSpeakerDebounceTimers = {};

    function clearActiveSpeakerDebounceTimers() {
        Object.keys(activeSpeakerDebounceTimers).forEach((identity) => {
            clearTimeout(activeSpeakerDebounceTimers[identity]);
            delete activeSpeakerDebounceTimers[identity];
        });
    }

    function clearActiveSpeakers() {
        clearActiveSpeakerDebounceTimers();
        activeSpeakerIdentities.clear();
    }

    function markParticipantAsActiveSpeaker(identity) {
        if (!identity) return false;
        if (activeSpeakerDebounceTimers[identity]) {
            clearTimeout(activeSpeakerDebounceTimers[identity]);
            delete activeSpeakerDebounceTimers[identity];
        }
        if (activeSpeakerIdentities.has(identity)) return false;
        activeSpeakerIdentities.add(identity);
        return true;
    }

    function scheduleParticipantActiveSpeakerOff(identity) {
        if (!identity || !activeSpeakerIdentities.has(identity)) return;
        if (activeSpeakerDebounceTimers[identity]) return;

        activeSpeakerDebounceTimers[identity] = setTimeout(() => {
            delete activeSpeakerDebounceTimers[identity];
            const changed = activeSpeakerIdentities.delete(identity);
            if (changed) updateParticipantList();
        }, context.activeSpeakerDebounceMs);
    }

    function updateParticipantList() {
        const room = context.getRoom();
        const listEl = document.getElementById('participant-list');
        if (!listEl) return;

        if (!room) {
            listEl.innerHTML = '<div style="font-size: 12px; color: #80848e; text-align: center; margin-top: 20px;">加入频道后显示在线人员</div>';
            const userCount = document.getElementById('user-count');
            if (userCount) userCount.innerText = '0';
            return;
        }

        const htmlParts = [];
        let count = 0;

        const renderUser = (p, isSelf) => {
            count++;
            const name = p.name || p.identity;
            const initial = name ? name.charAt(0).toUpperCase() : '?';
            const displayName = isSelf ? `${name} (我)` : name;
            const isSpeaking = activeSpeakerIdentities.has(p.identity);

            const volumes = context.ensureParticipantVolumeState(p.identity);

            let volumeControlsHTML = '';
            if (!isSelf) {
                const micVol = volumes.mic;
                volumeControlsHTML += `<div style="display: flex; align-items: center; gap: 5px; font-size: 12px;"><span title="麦克风音量">🎤</span><input type="range" class="volume-slider" min="0" max="300" step="1" value="${context.gainToPercent(micVol)}" oninput="setParticipantVolume('${p.identity}', 'mic', this.value);this.nextElementSibling.innerText=this.value+'%'"><span style="width:38px; text-align:right; color:#b5bac1;">${context.gainToPercent(micVol)}%</span></div>`;

                const hasScreenAudio = Array.from(p.audioTrackPublications.values()).some(pub => pub.source === context.LivekitClient.Track.Source.ScreenShareAudio || pub.source === 'screen_share_audio');
                if (hasScreenAudio) {
                    const screenVol = volumes.screen;
                    volumeControlsHTML += `<div style="display: flex; align-items: center; gap: 5px; font-size: 12px;"><span title="共享音量">💻</span><input type="range" class="volume-slider" min="0" max="300" step="1" value="${context.gainToPercent(screenVol)}" oninput="setParticipantVolume('${p.identity}', 'screen', this.value);this.nextElementSibling.innerText=this.value+'%'"><span style="width:38px; text-align:right; color:#b5bac1;">${context.gainToPercent(screenVol)}%</span></div>`;
                }

                const hasAppAudio = Array.from(p.audioTrackPublications.values()).some(pub => {
                    const pubName = pub?.trackName || pub?.name || '';
                    return pubName === 'app-audio';
                });
                if (hasAppAudio) {
                    const appAudioVol = volumes.appaudio;
                    volumeControlsHTML += `<div style="display: flex; align-items: center; gap: 5px; font-size: 12px;"><span title="应用共享音量">🖥️</span><input type="range" class="volume-slider" min="0" max="300" step="1" value="${context.gainToPercent(appAudioVol)}" oninput="setParticipantVolume('${p.identity}', 'appaudio', this.value);this.nextElementSibling.innerText=this.value+'%'"><span style="width:38px; text-align:right; color:#b5bac1;">${context.gainToPercent(appAudioVol)}%</span></div>`;
                }
            }

            const isMicMuted = !p.isMicrophoneEnabled;
            const statusIcon = isMicMuted
                ? '<span style="color: #f23f42; font-size: 16px;" title="已闭麦">🔇</span>'
                : '<span style="color: #23a559; font-size: 16px;" title="已开麦">🎙️</span>';
            const userBottomHTML = volumeControlsHTML ? `<div class="user-bottom">${volumeControlsHTML}</div>` : '';

            return `
                <div id="user-item-${p.identity}" class="user-item${isSpeaking ? ' active-speaker' : ''}">
                    <div class="user-avatar">${initial}</div>
                    <div class="user-info">
                        <div class="user-top">
                            <div class="user-name" title="${displayName}">${displayName} ${statusIcon}</div>
                            <div class="user-status"></div>
                        </div>
                        ${userBottomHTML}
                    </div>
                </div>
            `;
        };

        if (room.localParticipant) htmlParts.push(renderUser(room.localParticipant, true));
        if (room.remoteParticipants) room.remoteParticipants.forEach(p => htmlParts.push(renderUser(p, false)));

        listEl.innerHTML = htmlParts.join('');
        const userCount = document.getElementById('user-count');
        if (userCount) userCount.innerText = count;
    }

    function updateActiveSpeakerUI() {
        document.querySelectorAll('.user-item').forEach(el => {
            const identity = el.id.replace('user-item-', '');
            if (activeSpeakerIdentities.has(identity)) {
                el.classList.add('active-speaker');
            } else {
                el.classList.remove('active-speaker');
            }
        });
    }

    return {
        clearActiveSpeakerDebounceTimers,
        clearActiveSpeakers,
        markParticipantAsActiveSpeaker,
        scheduleParticipantActiveSpeakerOff,
        updateParticipantList,
        updateActiveSpeakerUI,
        getActiveSpeakerIdentities: () => activeSpeakerIdentities,
    };
}
