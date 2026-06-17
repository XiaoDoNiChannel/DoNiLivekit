import { alertError, logError } from '../shared/errors.js';

/** 创建 LiveKit 事件模块；集中绑定远端 Track、成员和 DataChannel 事件。 */
export function createLivekitEventsFeature(context) {
    const localScreenControls = {};
    let clickTimer = null;

    /** 判断 publication 是否为屏幕共享视频源。 */
    function isScreenShareSource(source) {
        return source === context.LivekitClient.Track.Source.ScreenShare || source === 'screen_share';
    }

    /** 判断音频 track 是否为 Rust 9001 发布的应用/进程音频。 */
    function isAppAudioPublication(track, publication) {
        const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
        const text = [
            publication?.trackName,
            publication?.name,
            publication?.track?.name,
            publication?.track?.mediaStreamTrack?.label,
            track?.name,
            track?.mediaStreamTrack?.label,
            publication?.source,
        ].map(normalize).filter(Boolean).join('|');

        return [
            'app-audio',
            'appaudio',
            'application-audio',
            'system-audio',
            'process-audio',
            'window-audio',
        ].some((keyword) => text.includes(keyword));
    }

    function getAudioPublicationSource(track, publication) {
        if (isAppAudioPublication(track, publication)) return 'appaudio';
        if (track?.source === context.LivekitClient.Track.Source.ScreenShareAudio
            || track?.source === 'screen_share_audio'
            || publication?.source === context.LivekitClient.Track.Source.ScreenShareAudio
            || publication?.source === 'screen_share_audio') {
            return 'screen';
        }
        return 'mic';
    }

    function removeAudioElementsForPublication(publication, participant) {
        const identity = participant?.identity || publication?.participant?.identity || '';
        const source = getAudioPublicationSource(publication?.track, publication);
        const trackSid = publication?.trackSid || publication?.sid || publication?.track?.sid || '';

        document.querySelectorAll('[data-audio-identity]').forEach((el) => {
            const sameIdentity = !identity || el?.dataset?.audioIdentity === identity;
            const sameSource = !source || el?.dataset?.audioSource === source;
            const sameTrack = !trackSid || el?.dataset?.audioTrackSid === trackSid;
            if (sameIdentity && (sameTrack || sameSource)) el.remove();
        });
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

    /** 本地屏蔽/恢复某个远端屏幕共享，不影响其他成员订阅。 */
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

    function getUniqueRoomEvents(...eventNames) {
        return Array.from(new Set(eventNames.filter(Boolean)));
    }

    function onRoomEvents(room, eventNames, handler) {
        getUniqueRoomEvents(...eventNames).forEach((eventName) => {
            try {
                room.on(eventName, handler);
            } catch (error) {
                logError(`livekitEvents/registerRoomEvents 绑定事件失败: ${eventName}`, error, 'warn');
            }
        });
    }

    function notifyLiveKitStable(room, reason, detail = {}) {
        try {
            context.updateParticipantList?.();
        } catch (error) {
            logError(`livekitEvents/${reason} 刷新成员列表失败`, error, 'warn');
        }

        context.onLivekitConnectionStable?.({
            reason,
            room,
            ...detail,
        });
    }

    function notifyLiveKitUnstable(room, reason, detail = {}) {
        try {
            context.updateParticipantList?.();
        } catch (error) {
            logError(`livekitEvents/${reason} 刷新成员列表失败`, error, 'warn');
        }

        context.onLivekitConnectionUnstable?.({
            reason,
            room,
            ...detail,
        });
    }

    function normalizeConnectionState(state) {
        return String(state || '').toLowerCase();
    }

    /** 给当前 LiveKit Room 绑定事件；每次新建 Room 后必须调用一次。 */
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

                const source = getAudioPublicationSource(track, publication);
                audioEl.dataset.audioSource = source;
                audioEl.dataset.audioTrackSid = track.sid || publication?.trackSid || '';

                context.ensureParticipantVolumeState(participant.identity);
                context.addRemoteGainNode(participant.identity, source, track, audioEl);

                // 音频共享 / 屏幕共享音频订阅成功后立即刷新成员列表，
                // 让对应的音量滑块不需要等下一次成员事件才出现。
                context.updateParticipantList();

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

            if (track.kind === 'audio') {
                context.updateParticipantList();
            }

            const wrapper = document.getElementById('video-wrapper-' + track.sid);
            if (wrapper) wrapper.remove();
        });

        room.on(context.LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            document.querySelectorAll(`[data-video-identity="${participant.identity}"]`).forEach(el => el.remove());
            document.querySelectorAll(`[data-audio-identity="${participant.identity}"]`).forEach(el => el.remove());
            removeLocalScreenRestoreCard(participant.identity);
            delete localScreenControls[participant.identity];
            context.updateParticipantList();
            context.onLivekitParticipantsChanged?.({ reason: 'participant_disconnected', participant, room });
        });

        room.on(context.LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
            context.updateParticipantList();
            context.onLivekitParticipantsChanged?.({ reason: 'participant_connected', participant, room });
        });

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
            if (pub?.kind === 'audio') {
                context.updateParticipantList();
                setTimeout(() => context.updateParticipantList(), 80);
            }
        });

        room.on(context.LivekitClient.RoomEvent.TrackPublished, (pub) => { if (pub.kind === 'audio') context.updateParticipantList(); });
        room.on(context.LivekitClient.RoomEvent.TrackUnpublished, (pub, participant) => {
            if (pub.kind === 'audio') {
                removeAudioElementsForPublication(pub, participant);
                context.removeRemoteAudioRouteByTrackSid(pub?.trackSid || pub?.track?.sid);
                context.updateParticipantList();
                setTimeout(() => context.updateParticipantList(), 80);
            }

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
                // 聊天消息已全部通过 Presence WebSocket (chat_message) 传输并处理
                // 此处不再处理 data.msg 避免重复和产生假 ID 导致无法点赞
            } catch (e) {
                logError('livekitEvents/DataReceived 解析数据失败', e);
            }
        });

        // LiveKit 信令/网络恢复后，LiveKit Room 里的成员可能已经恢复，
        // 但 Presence 频道成员状态不一定会自动重新 join。
        // 这里把“LiveKit 已稳定”通知 runtime，让 runtime 用当前频道重新校准 Presence。
        const RoomEvent = context.LivekitClient.RoomEvent || {};
        onRoomEvents(room, [RoomEvent.Reconnected, 'reconnected'], () => {
            notifyLiveKitStable(room, 'reconnected');
        });
        onRoomEvents(room, [RoomEvent.Connected, 'connected'], () => {
            notifyLiveKitStable(room, 'connected');
        });
        onRoomEvents(room, [RoomEvent.Reconnecting, 'reconnecting'], () => {
            notifyLiveKitUnstable(room, 'reconnecting');
        });
        onRoomEvents(room, [RoomEvent.Disconnected, 'disconnected'], (reason) => {
            notifyLiveKitUnstable(room, 'disconnected', { disconnectReason: reason });
        });
        onRoomEvents(room, [RoomEvent.ConnectionStateChanged, 'connectionStateChanged'], (state) => {
            const normalized = normalizeConnectionState(state || room.state || room.connectionState);
            if (normalized === 'connected') {
                notifyLiveKitStable(room, 'connection_state_connected', { state });
            } else if (normalized === 'reconnecting') {
                notifyLiveKitUnstable(room, 'connection_state_reconnecting', { state });
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
