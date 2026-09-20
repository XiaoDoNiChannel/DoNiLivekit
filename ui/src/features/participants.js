/** 创建成员列表模块；负责成员卡片渲染、音量滑块和说话高亮。 */
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

    /** 标记成员正在说话；用于 LiveKit active speaker 回调。 */
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

    /** 延迟关闭说话高亮，避免音量抖动导致 UI 闪烁。 */
    function scheduleParticipantActiveSpeakerOff(identity) {
        if (!identity || !activeSpeakerIdentities.has(identity)) return;
        if (activeSpeakerDebounceTimers[identity]) return;

        activeSpeakerDebounceTimers[identity] = setTimeout(() => {
            delete activeSpeakerDebounceTimers[identity];
            const changed = activeSpeakerIdentities.delete(identity);
            if (changed) updateParticipantList();
        }, context.activeSpeakerDebounceMs);
    }

    /** 从与频道列表相同的 LiveKit 派生成员集合渲染高级音量面板。 */
    function updateParticipantList() {
        const room = context.getRoom();
        const listEl = document.getElementById('participant-list');
        if (!listEl) return;

        const members = room ? (context.getAuthoritativeMembers?.() || []) : [];
        if (!room) {
            listEl.innerHTML = '<div style="font-size: 12px; color: #80848e; text-align: center; margin-top: 20px;">加入频道后显示在线人员</div>';
            const userCount = document.getElementById('user-count');
            if (userCount) userCount.innerText = '0';
            return;
        }

        const htmlParts = [];
        const renderUser = (p) => {
            const isSelf = p.isSelf === true;
            const name = p.displayName || p.identity;
            const initial = name ? name.charAt(0).toUpperCase() : '?';
            const displayName = isSelf ? `${name} (我)` : name;
            const isSpeaking = activeSpeakerIdentities.has(p.identity);
            const volumeIdentity = p.volumeIdentity || p.identity;
            const volumes = context.ensureParticipantVolumeState(volumeIdentity);

            let volumeControlsHTML = '';
            if (!isSelf) {
                const micVol = volumes.mic;
                volumeControlsHTML += `<div style="display: flex; align-items: center; gap: 5px; font-size: 12px;"><span title="麦克风音量">🎤</span><input type="range" class="volume-slider" min="0" max="300" step="1" value="${context.gainToPercent(micVol)}" oninput="setParticipantVolume('${volumeIdentity}', 'mic', this.value);this.nextElementSibling.innerText=this.value+'%'"><span style="width:38px; text-align:right; color:#b5bac1;">${context.gainToPercent(micVol)}%</span></div>`;

                if (p.hasScreenAudio) {
                    const screenVol = volumes.screen;
                    volumeControlsHTML += `<div style="display: flex; align-items: center; gap: 5px; font-size: 12px;"><span title="共享音量">💻</span><input type="range" class="volume-slider" min="0" max="300" step="1" value="${context.gainToPercent(screenVol)}" oninput="setParticipantVolume('${volumeIdentity}', 'screen', this.value);this.nextElementSibling.innerText=this.value+'%'"><span style="width:38px; text-align:right; color:#b5bac1;">${context.gainToPercent(screenVol)}%</span></div>`;
                }

                if (p.hasAppAudio) {
                    const appAudioVol = volumes.appaudio;
                    volumeControlsHTML += `<div style="display: flex; align-items: center; gap: 5px; font-size: 12px;"><span title="应用共享音量">🖥️</span><input type="range" class="volume-slider" min="0" max="300" step="1" value="${context.gainToPercent(appAudioVol)}" oninput="setParticipantVolume('${volumeIdentity}', 'appaudio', this.value);this.nextElementSibling.innerText=this.value+'%'"><span style="width:38px; text-align:right; color:#b5bac1;">${context.gainToPercent(appAudioVol)}%</span></div>`;
                }
            }

            const isMicMuted = !p.micOpen;
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

        members.forEach((member) => htmlParts.push(renderUser(member)));

        listEl.innerHTML = htmlParts.join('');
        const userCount = document.getElementById('user-count');
        if (userCount) userCount.innerText = String(members.length);
    }

    /** 只更新 active-speaker class，不重建整个成员列表。 */
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
