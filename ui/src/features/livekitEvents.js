import { alertError, logError } from '../shared/errors.js';

/**
 * LiveKit event binding module.
 *
 * 负责把 LiveKit RoomEvent 绑定到 DOM：
 * - 远端视频挂载、屏幕分享包装盒、单击聚焦、双击全屏；
 * - 远端音频挂载，并交给 remoteAudio.js 的 GainNode 做音量控制；
 * - 成员加入/离开、静音状态、Track 发布/取消发布、活跃说话者；
 * - DataReceived 聊天消息分发。
 *
 * 这里不创建 Room、不连接服务器、不发布本地麦克风，只处理“已经连接后的事件响应”。
 */

export function createLivekitEventsFeature(context) {
    const localScreenControls = {};
    let clickTimer = null;

    function isScreenShareSource(source) {
        return source === context.LivekitClient.Track.Source.ScreenShare || source === 'screen_share';
    }

    function isAppAudioPublication(track, publication) {
        const trackName = publication?.trackName || publication?.name || track?.name || '';
        return trackName === 'app-audio';
    }

    function removeLocalScreenRestoreCard(identity) {
        const card = document.getElementById(`screen-restore-${identity}`);
        if (card) card.remove();
    }

    function upsertLocalScreenRestoreCard(identity, displayName) {
        let card = document.getElementById(`screen-restore-${identity}`);
        if (!card) {
            card = document.createElement('div');
            card.className = 'screen-restore-card';
            card.id = `screen-restore-${identity}`;
            document.getElementById('video-container')?.appendChild(card);
        }

        card.innerHTML = `
            <div>${displayName} 的屏幕已在本地屏蔽</div>
            <button onclick="toggleLocalScreenSubscription('${identity}')">恢复屏幕</button>
        `;
    }

    async function toggleLocalScreenSubscription(identity) {
        const state = localScreenControls[identity];
        if (!state || !state.publication) return;

        try {
            if (!state.isBlocked) {
                await state.publication.setSubscribed(false);
                state.isBlocked = true;
                upsertLocalScreenRestoreCard(identity, state.displayName || identity);
            } else {
                await state.publication.setSubscribed(true);
                state.isBlocked = false;
                removeLocalScreenRestoreCard(identity);
            }
        } catch (e) {
            logError('livekitEvents/toggleLocalScreenSubscription 切换本地屏幕订阅状态失败', e);
            alertError('切换本地屏幕订阅状态失败', e);
        }
    }

    function clearLocalScreenControls() {
        Object.keys(localScreenControls).forEach((identity) => {
            removeLocalScreenRestoreCard(identity);
            delete localScreenControls[identity];
        });
    }

    function registerRoomEvents(room) {
        if (!room) return;

        room.on(context.LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
                const isRemoteScreen = isScreenShareSource(publication?.source) && participant?.identity !== room.localParticipant?.identity;
                const videoEl = track.attach();

                const wrapper = document.createElement('div');
                wrapper.className = 'video-wrapper';
                wrapper.id = 'video-wrapper-' + track.sid;
                wrapper.dataset.videoIdentity = participant.identity;
                wrapper.title = '双击全屏放大观看';

                const displayName = participant.name || participant.identity || '未知成员';

                const nameLabel = document.createElement('div');
                nameLabel.className = 'video-name-label';
                nameLabel.innerText = `${displayName} 的屏幕`;

                if (isRemoteScreen) {
                    localScreenControls[participant.identity] = {
                        publication,
                        displayName,
                        isBlocked: false,
                    };

                    removeLocalScreenRestoreCard(participant.identity);

                    const toggleBtn = document.createElement('button');
                    toggleBtn.className = 'screen-local-toggle-btn';
                    toggleBtn.innerText = '屏蔽屏幕';
                    toggleBtn.onclick = async (event) => {
                        event.stopPropagation();
                        await toggleLocalScreenSubscription(participant.identity);
                    };
                    wrapper.appendChild(toggleBtn);
                }

                wrapper.onclick = (e) => {
                    if (e.target.tagName.toLowerCase() === 'button') return;
                    if (clickTimer) clearTimeout(clickTimer);

                    clickTimer = setTimeout(() => {
                        const container = document.getElementById('video-container');
                        const isAlreadyFocused = wrapper.classList.contains('focused');

                        document.querySelectorAll('.video-wrapper.focused').forEach(el => {
                            el.classList.remove('focused');
                        });

                        if (!isAlreadyFocused) {
                            wrapper.classList.add('focused');
                            container?.classList.add('has-focus');
                        } else {
                            container?.classList.remove('has-focus');
                        }
                    }, 250);
                };

                wrapper.ondblclick = () => {
                    if (clickTimer) clearTimeout(clickTimer);

                    if (!document.fullscreenElement) {
                        if (wrapper.requestFullscreen) wrapper.requestFullscreen();
                        else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen();
                    } else {
                        if (document.exitFullscreen) document.exitFullscreen();
                    }
                };

                wrapper.appendChild(videoEl);
                wrapper.appendChild(nameLabel);
                document.getElementById('video-container')?.appendChild(wrapper);
                return;
            }

            if (track.kind === 'audio') {
                const audioEl = track.attach();
                audioEl.muted = true;
                audioEl.volume = 0;
                audioEl.dataset.audioIdentity = participant.identity;

                const source = isAppAudioPublication(track, publication)
                    ? 'appaudio'
                    : ((track.source === context.LivekitClient.Track.Source.ScreenShareAudio || track.source === 'screen_share_audio') ? 'screen' : 'mic');
                audioEl.dataset.audioSource = source;

                context.ensureParticipantVolumeState(participant.identity);
                context.addRemoteGainNode(participant.identity, source, track, audioEl);

                document.getElementById('audio-container')?.appendChild(audioEl);
                if (typeof audioEl.setSinkId === 'function') {
                    audioEl.setSinkId(context.getSelectedAudioOutputId()).catch((e) => {
                        logError('livekitEvents/TrackSubscribed 新音频轨道切换输出设备失败', e, 'warn');
                    });
                }
            }
        });

        room.on(context.LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(element => element.remove());
            context.removeRemoteAudioRouteByTrackSid(track.sid);

            const wrapper = document.getElementById('video-wrapper-' + track.sid);
            if (wrapper) wrapper.remove();
        });

        room.on(context.LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            document.querySelectorAll(`[data-video-identity="${participant.identity}"]`).forEach(el => el.remove());
            document.querySelectorAll(`[data-audio-identity="${participant.identity}"]`).forEach(el => el.remove());
            removeLocalScreenRestoreCard(participant.identity);
            delete localScreenControls[participant.identity];
            context.updateParticipantList();
        });

        room.on(context.LivekitClient.RoomEvent.ParticipantConnected, context.updateParticipantList);

        room.on(context.LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
            const nextActiveIdentities = new Set();
            (speakers || []).forEach((participant) => {
                if (!participant || !participant.identity) return;
                const audioLevel = Number(participant.audioLevel || 0);
                if (audioLevel >= context.activeSpeakerLevelThreshold) {
                    nextActiveIdentities.add(participant.identity);
                }
            });

            let hasImmediateChange = false;
            nextActiveIdentities.forEach((identity) => {
                if (context.markParticipantAsActiveSpeaker(identity)) {
                    hasImmediateChange = true;
                }
            });

            Array.from(context.getActiveSpeakerIdentities()).forEach((identity) => {
                if (!nextActiveIdentities.has(identity)) {
                    context.scheduleParticipantActiveSpeakerOff(identity);
                }
            });

            if (hasImmediateChange) context.updateActiveSpeakerUI();
        });

        room.on(context.LivekitClient.RoomEvent.TrackMuted, (pub) => { if (pub.kind === 'audio') context.updateParticipantList(); });
        room.on(context.LivekitClient.RoomEvent.TrackUnmuted, (pub) => { if (pub.kind === 'audio') context.updateParticipantList(); });
        room.on(context.LivekitClient.RoomEvent.LocalTrackMuted, (pub) => { if (pub.kind === 'audio') context.updateParticipantList(); });
        room.on(context.LivekitClient.RoomEvent.LocalTrackUnmuted, (pub) => { if (pub.kind === 'audio') context.updateParticipantList(); });

        room.on(context.LivekitClient.RoomEvent.LocalTrackPublished, (pub) => {
            if (isScreenShareSource(pub?.source) && pub.track) {
                context.showLocalScreenPreview(pub.track);
            }
        });

        room.on(context.LivekitClient.RoomEvent.LocalTrackUnpublished, (pub) => {
            if (isScreenShareSource(pub?.source)) {
                context.hideLocalScreenPreview();
            }
        });

        room.on(context.LivekitClient.RoomEvent.TrackPublished, (pub) => { if (pub.kind === 'audio') context.updateParticipantList(); });
        room.on(context.LivekitClient.RoomEvent.TrackUnpublished, (pub, participant) => {
            if (pub.kind === 'audio') context.updateParticipantList();

            if (isScreenShareSource(pub?.source)) {
                const identity = participant?.identity || Object.keys(localScreenControls).find(key => {
                    return localScreenControls[key]?.publication?.trackSid === pub?.trackSid;
                });

                if (identity) {
                    removeLocalScreenRestoreCard(identity);
                    delete localScreenControls[identity];
                }
            }
        });

        room.on(context.LivekitClient.RoomEvent.DataReceived, (payload, participant) => {
            try {
                const text = new TextDecoder().decode(payload);
                const data = JSON.parse(text);
                if (data.msg) {
                    context.renderChatMessage(participant ? (participant.name || participant.identity) : '未知', data.msg, false);
                }
            } catch (e) {
                logError('livekitEvents/DataReceived 解析聊天消息失败', e);
            }
        });
    }

    return {
        registerRoomEvents,
        toggleLocalScreenSubscription,
        clearLocalScreenControls,
        isScreenShareSource,
        isAppAudioPublication,
    };
}
