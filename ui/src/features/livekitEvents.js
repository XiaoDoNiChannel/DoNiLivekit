import { publicationKind } from './shareSubscriptions.js';
import { logError } from '../shared/errors.js';

/** 创建 LiveKit 事件模块；集中绑定远端 Track、成员和 DataChannel 事件。 */
export function createLivekitEventsFeature(context) {
    const isScreenShareSource = source => source === 'screen_share';
    const isAppAudioPublication = (track, pub) => publicationKind(pub, track) === 'appaudio';
    const getAudioPublicationSource = (track, pub) => publicationKind(pub, track);
    const clearLocalScreenControls = () => context.shares.reset();
    function removeAudioElementsForPublication(pub, participant) {
        document.querySelectorAll('[data-audio-track-sid]').forEach(el => {
            if (el.dataset.audioTrackSid === pub.trackSid && el.dataset.audioIdentity === participant.identity) el.remove();
        });
    }
    function toggleLocalScreenSubscription(identity) {
        const share = context.shares;
        share.stopWatching();
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
        context.shares.attach(room);

        room.on(context.LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (!context.shares.isCurrentRoom(room)) return;
            if (!context.shares.allowTrack(publication, participant, track)) {
                publication.setSubscribed(false);
                return;
            }
            context.shares.subscribed(publication, participant, true);
            if (track.kind === 'video') {
                const wrapper = document.createElement('div');
                wrapper.className = 'video-wrapper';
                wrapper.id = 'video-wrapper-' + track.sid;
                wrapper.dataset.videoIdentity = participant.identity;
                wrapper.dataset.shareId = `${participant.identity}:${publication.trackSid}`;
                const video = track.attach();
                video.muted = true;
                wrapper.appendChild(video);
                wrapper.ondblclick = () => {
                    if (document.fullscreenElement) document.exitFullscreen?.();
                    else wrapper.requestFullscreen?.();
                };
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

        room.on(context.LivekitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            if (!context.shares.isCurrentRoom(room)) return;
            context.shares.subscribed(publication, participant, false);
            track.detach().forEach(element => element.remove());
            context.removeRemoteAudioRouteByTrackSid(track.sid);

            if (track.kind === 'audio') {
                context.updateParticipantList();
            }

            const wrapper = document.getElementById('video-wrapper-' + track.sid);
            if (wrapper) wrapper.remove();
        });

        room.on(context.LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            if (!context.shares.isCurrentRoom(room)) return;
            document.querySelectorAll('[data-video-identity], [data-audio-identity]').forEach(el => {
                if (el.dataset.videoIdentity === participant.identity || el.dataset.audioIdentity === participant.identity) {
                    context.removeRemoteAudioRouteByTrackSid(el.dataset.audioTrackSid);
                    el.remove();
                }
            });
            context.shares.participantLeft(participant);
            context.updateParticipantList();
            context.onLivekitParticipantsChanged?.({ reason: 'participant_disconnected', participant, room });
        });

        room.on(context.LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
            if (!context.shares.isCurrentRoom(room)) return;
            participant.trackPublications?.forEach(pub => context.shares.discover(pub, participant));
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

            // 通知 Vue 侧语音频道成员列表同步说话状态。
            // 旧 DOM 高亮由 updateActiveSpeakerUI 处理；ChannelList/BaseAvatar 依赖这个回调。
            context.onActiveSpeakersChanged?.(context.getActiveSpeakerIdentities());
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
            if (!context.shares.isCurrentRoom(room)) return;
            if (isScreenShareSource(pub?.source)) {
                context.onLocalScreenStopped?.();
            }
            if (pub?.kind === 'audio') {
                context.updateParticipantList();
                setTimeout(() => context.updateParticipantList(), 80);
            }
        });

        room.on(context.LivekitClient.RoomEvent.TrackPublished, (pub, participant) => {
            if (!context.shares.isCurrentRoom(room)) return;
            context.shares.discover(pub, participant);
            context.updateParticipantList();
        });
        room.on(context.LivekitClient.RoomEvent.TrackUnpublished, (pub, participant) => {
            if (!context.shares.isCurrentRoom(room)) return;
            if (pub.kind === 'audio') {
                removeAudioElementsForPublication(pub, participant);
                context.removeRemoteAudioRouteByTrackSid(pub?.trackSid || pub?.track?.sid);
                context.updateParticipantList();
                setTimeout(() => context.updateParticipantList(), 80);
            }

            context.shares.remove(pub, participant);
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
        onRoomEvents(room, [RoomEvent.TrackSubscriptionFailed], sid => context.shares.failed(sid));
        onRoomEvents(room, [RoomEvent.Reconnected, 'reconnected'], () => {
            if (!context.shares.isCurrentRoom(room)) return;
            context.shares.reconnected();
            notifyLiveKitStable(room, 'reconnected');
        });
        onRoomEvents(room, [RoomEvent.Connected, 'connected'], () => {
            if (!context.shares.isCurrentRoom(room)) return;
            context.shares.sync();
            notifyLiveKitStable(room, 'connected');
        });
        onRoomEvents(room, [RoomEvent.Reconnecting, 'reconnecting'], () => {
            if (!context.shares.isCurrentRoom(room)) return;
            context.shares.reconnecting();
            notifyLiveKitUnstable(room, 'reconnecting');
        });
        onRoomEvents(room, [RoomEvent.Disconnected, 'disconnected'], (reason) => {
            if (!context.shares.isCurrentRoom(room)) return;
            context.shares.reset();
            context.clearRemoteAudio?.();
            context.onLocalScreenStopped?.();
            notifyLiveKitUnstable(room, 'disconnected', { disconnectReason: reason });
        });
        onRoomEvents(room, [RoomEvent.ConnectionStateChanged, 'connectionStateChanged'], (state) => {
            if (!context.shares.isCurrentRoom(room)) return;
            const normalized = normalizeConnectionState(state || room.state || room.connectionState);
            if (normalized === 'connected') {
                notifyLiveKitStable(room, 'connection_state_connected', { state });
            } else if (normalized === 'reconnecting') {
                notifyLiveKitUnstable(room, 'connection_state_reconnecting', { state });
            } else if (normalized === 'disconnected') {
                notifyLiveKitUnstable(room, 'connection_state_disconnected', { state });
            }
        });
    }

    return {
        registerRoomEvents,
        syncSubscriptions: () => context.shares.sync(),
        toggleLocalScreenSubscription,
        clearLocalScreenControls,
        isScreenShareSource,
        isAppAudioPublication,
    };
}
