import { invoke, listen, isTauriClient } from '../shared/tauri.js';
import {
    DEFAULT_SERVER_IP,
    AUTO_JOIN_FIRST_CHANNEL_AFTER_LOBBY,
    ACTIVE_SPEAKER_LEVEL_THRESHOLD,
    ACTIVE_SPEAKER_DEBOUNCE_MS,
} from '../shared/constants.js';
import { sanitizeText } from '../shared/text.js';
import { logError } from '../shared/errors.js';
import { appStore, markAppBooted, syncFromRuntimeSnapshot, setLastError } from '../stores/appStore.js';
import { profileStore, getConnectionId, syncProfileToServer } from '../stores/profileStore.js';
import { syncSpeakingIdentities, clearSpeakingIdentities, syncVoiceMemberAudioStates, clearVoiceMemberAudioStates, patchVoiceMemberAudioState } from '../stores/presenceStore.js';
import { watch } from 'vue';
import { chatStore, switchChatChannel, loadServerHistory, addChatMessage, markMessageSent, markMessageFailed, applyServerChatMessage, applyServerReactionUpdate, updateChatAvatars } from '../stores/chatStore.js';
import { setApiBase } from '../shared/apiClient.js';
import {
    updateMicList as updateMicListFromModule,
    switchMic as switchMicFromModule,
    updateAudioOutputList as updateAudioOutputListFromModule,
    switchAudioOutput as switchAudioOutputFromModule,
} from '../features/devices.js';
import {
    normalizeGainValue,
    gainToPercent,
    loadUserVolumesFromStorage,
    saveUserVolumesToStorage as persistUserVolumesToStorage,
    ensureParticipantVolumeState as ensureParticipantVolumeStateFromStore,
} from '../features/participantVolumes.js';
import { createAppAudioFeature } from '../features/appAudio.js';
import { createScreenShareFeature } from '../features/screenShare.js';
import { createChatFeature } from '../features/chat.js';
import { createRemoteAudioFeature } from '../features/remoteAudio.js';
import { createAudioPipelinesFeature } from '../features/audioPipelines.js';
import { createParticipantsFeature } from '../features/participants.js';
import { createLivekitEventsFeature } from '../features/livekitEvents.js';
import { createRustMicFeature } from '../features/rustMic.js';
import { createRoomConnectionFeature } from '../features/roomConnection.js';
import { createPresenceClient } from '../features/presenceClient.js';
import { createChatClient } from '../features/chatClient.js';

// 运行时装配层。
// 只负责创建 feature、注入依赖、同步 appStore、暴露给 Vue/旧 onclick 的动作。
// 不在这里直接写新的业务逻辑；新功能应落到 stores + features + components。

let room = null;
let isScreenOn = false;
let remoteAudioContext = null;
let localAppAudioPublication = null;
let isAppAudioSharing = false;
let selectedAudioOutputId = localStorage.getItem('lk_audio_output') || 'default';
const VAD_THRESHOLD_STORAGE_KEY = 'lk_vad_threshold';
const MIC_BOOST_STORAGE_KEY = 'lk_mic_boost';

const userVolumes = loadUserVolumesFromStorage();
const audioPipelinesFeature = createAudioPipelinesFeature();
let roomConnectionFeature;

const presenceClient = createPresenceClient({
    logError,
    onMessage: (message) => {
        roomConnectionFeature?.applyPresenceMessage?.(message);

        // Phase 3：Presence 不再处理聊天消息和 Reaction。
        // 聊天与 Reaction 的实时同步统一由 Chat WebSocket 处理。

        // 有人更新了 profile
        if (message.type === 'profile_updated') {
            updateChatAvatars(message.userId || message.identity, message.avatarColor, message.avatarPreset, message.avatarUrl);
            if (message.identity && message.identity !== message.userId) {
                updateChatAvatars(message.identity, message.avatarColor, message.avatarPreset, message.avatarUrl);
            }
        }

        // 收到快照时，全量更新在线用户的头像到本地聊天记录缓存
        if (message.type === 'presence_snapshot' && message.participants) {
            for (const p of Object.values(message.participants)) {
                updateChatAvatars(p.userId || p.identity, p.avatarColor, p.avatarPreset, p.avatarUrl);
                if (p.identity && p.identity !== p.userId) {
                    updateChatAvatars(p.identity, p.avatarColor, p.avatarPreset, p.avatarUrl);
                }
            }
        }

        requestStoreSync();
    },
    onConnectionChange: (state = {}) => {
        if (state.connected) {
            schedulePresenceChannelSync('presence_connected', { delayMs: 50, snapshotDelayMs: 250 });
        }
        requestStoreSync();
    },
});



const chatClient = createChatClient({
    logError,
    onMessage: (message) => {
        console.log('[Chat WS]', message.type, message);

        if (message.type === 'message_ack') {
            if (message.status === 'ok') {
                markMessageSent({
                    clientMessageId: message.clientMessageId,
                    serverMessageId: message.serverMessageId,
                    messageId: message.messageId,
                });
            } else if (message.clientMessageId) {
                markMessageFailed(message.clientMessageId);
                logError('runtime/chatClient message_ack 发送失败: ' + (message.message || ''), null, 'warn');
            }
        }

        if (message.type === 'message_created' && message.message) {
            applyServerChatMessage(message.message, chatClient.getUserId?.() || profileStore.userId);
        }

        if (message.type === 'reaction_updated') {
            applyServerReactionUpdate(message);
        }

        if (message.type === 'reaction_ack' && message.status === 'error') {
            logError('runtime/chatClient reaction_ack 失败: ' + (message.message || ''), null, 'warn');
        }

        if (message.type === 'chat_subscribed' && message.channelId) {
            handleChatSubscribed(message.channelId);
        }

        requestStoreSync();
    },
    onConnectionChange: (state = {}) => {
        // Chat WS 重连成功后，chatClient 会自动恢复订阅；这里额外触发一次历史补偿。
        const current = roomConnectionFeature?.getCurrentChannel?.() || chatStore.currentChannelId;
        if (state.connected && current) {
            scheduleChatHistoryRefresh(current, 'chat_reconnected', { force: true, delayMs: 300 });
        }
        requestStoreSync();
    },
});

// Phase 2.2：历史补偿触发合并。
// runtime 只负责把 focus / reconnect / subscribe 等连续触发合并成一次调度；
// 真正的 3 秒节流和 in-flight Promise 复用统一由 chatStore.loadServerHistory 兜底。
const CHAT_HISTORY_DEBOUNCE_MS = 250;
const chatHistoryTimers = new Map();

function scheduleChatHistoryRefresh(channelId, reason = 'unknown', options = {}) {
    const cleanId = String(channelId || '').trim();
    if (!cleanId) return;

    const delayMs = options.delayMs ?? CHAT_HISTORY_DEBOUNCE_MS;
    const nextForce = !!options.force;
    const pending = chatHistoryTimers.get(cleanId);

    // 已经排队了关键场景强制刷新时，不允许 focus/visibility 这类普通刷新把它降级覆盖。
    if (pending?.force && !nextForce) return;
    if (pending?.timer) clearTimeout(pending.timer);

    const timer = setTimeout(async () => {
        chatHistoryTimers.delete(cleanId);
        try {
            const refreshed = await loadServerHistory(cleanId, { force: nextForce, limit: options.limit || 80 });
            if (refreshed) {
                console.log('[Chat History] refreshed', { channelId: cleanId, reason, force: nextForce });
            } else {
                console.debug?.('[Chat History] skipped by store throttle', { channelId: cleanId, reason, force: nextForce });
            }
        } catch (error) {
            logError('runtime/scheduleChatHistoryRefresh 加载聊天历史失败', error, 'warn');
        }
    }, delayMs);

    chatHistoryTimers.set(cleanId, { timer, force: nextForce });
}

function handleChatSubscribed(channelId) {
    const cleanId = String(channelId || '').trim();
    if (!cleanId) return;

    // 如果自动进入频道时 chatStore 还没切到对应频道，这里补齐，避免“进频道看不到历史，切一下才显示”。
    if (chatStore.currentChannelId !== cleanId) {
        switchChatChannel(cleanId);
    }

    scheduleChatHistoryRefresh(cleanId, 'chat_subscribed', { force: true, delayMs: 80 });
}

// Phase 3：历史补偿。
// 即使 Chat WebSocket 独立后，仍需要历史补偿：用于启动初次加载、重连漏消息、窗口休眠恢复等场景。
function refreshCurrentChatHistory(reason = 'manual', options = {}) {
    const current = roomConnectionFeature?.getCurrentChannel?.() || chatStore.currentChannelId;
    if (!current) return;
    scheduleChatHistoryRefresh(current, reason, options);
}

// Presence / LiveKit 重连成功后，用当前运行时频道重新校准后端成员状态。
// 这里故意把 joinChannel 放在 requestSnapshot 前面：先告诉后端“我还在这个频道”，
// 再拉一次快照，避免快照先返回旧状态导致频道底下少人。
const PRESENCE_SYNC_DEBOUNCE_MS = 150;
let presenceSyncTimer = null;
let presenceSnapshotTimer = null;

function getCurrentPresenceChannel() {
    return roomConnectionFeature?.getCurrentChannel?.() || chatStore.currentChannelId || presenceClient.getCurrentChannel?.() || '';
}

function schedulePresenceSnapshot(reason = 'unknown', delayMs = 250) {
    clearTimeout(presenceSnapshotTimer);
    presenceSnapshotTimer = setTimeout(() => {
        presenceSnapshotTimer = null;
        if (!presenceClient.isConnected?.()) return;

        try {
            presenceClient.requestSnapshot?.();
        } catch (error) {
            logError(`runtime/schedulePresenceSnapshot requestSnapshot 失败 reason=${reason}`, error, 'warn');
        }
    }, delayMs);
}

function schedulePresenceChannelSync(reason = 'unknown', options = {}) {
    const delayMs = options.delayMs ?? PRESENCE_SYNC_DEBOUNCE_MS;
    clearTimeout(presenceSyncTimer);
    presenceSyncTimer = setTimeout(() => {
        presenceSyncTimer = null;
        syncPresenceChannel(reason, options);
    }, delayMs);
}

function syncPresenceChannel(reason = 'unknown', options = {}) {
    if (!presenceClient.isConnected?.()) return;

    const current = getCurrentPresenceChannel();

    if (current) {
        try {
            const joined = presenceClient.joinChannel?.(current);
            if (!joined) {
                logError(`runtime/syncPresenceChannel joinChannel 未发送 reason=${reason} channel=${current}`, null, 'warn');
            }
        } catch (error) {
            logError(`runtime/syncPresenceChannel joinChannel 失败 reason=${reason} channel=${current}`, error, 'warn');
        }
    }

    // join_channel 会广播 participant_moved；再延迟拉一次完整快照，兜底修正漏事件/乱序。
    schedulePresenceSnapshot(reason, options.snapshotDelayMs ?? 250);
}

if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
        refreshCurrentChatHistory('window_focus', { delayMs: 120 });
    });
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            refreshCurrentChatHistory('visibility_resume', { delayMs: 120 });
        }
    });
}

watch(
    () => [profileStore.displayName, profileStore.avatarColor, profileStore.avatarPreset, profileStore.avatarUrl, profileStore.statusText],
    ([displayName, avatarColor, avatarPreset, avatarUrl, statusText]) => {
        if (presenceClient.isConnected()) {
            presenceClient.updateProfile({ displayName, avatarColor, avatarPreset, avatarUrl, statusText });
        }
        // 当自己更新资料时，也需要同步更新本地聊天记录中的自己发送的消息头像。
        updateChatAvatars(profileStore.userId, avatarColor, avatarPreset, avatarUrl);
        const identity = presenceClient.getIdentity?.();
        if (identity && identity !== profileStore.userId) {
            updateChatAvatars(identity, avatarColor, avatarPreset, avatarUrl);
        }
        syncProfileToServer({ silent: true });
    }
);

/** 将远端成员音量偏好写回 localStorage。 */
function saveUserVolumesToStorage() {
    persistUserVolumesToStorage(userVolumes);
}

/** 确保某个成员拥有 mic/screen/appaudio 三类音量配置。 */
function ensureParticipantVolumeState(identity) {
    return ensureParticipantVolumeStateFromStore(userVolumes, identity);
}

/** 延迟创建远端音频 AudioContext；用于 GainNode 音量控制和输出设备切换。 */
function ensureAudioContext() {
    if (!remoteAudioContext) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) remoteAudioContext = new Ctx();
    }
    if (remoteAudioContext && remoteAudioContext.state === 'suspended') {
        remoteAudioContext.resume().catch(() => {});
    }
    return !!remoteAudioContext;
}

function getParticipantAudioPublications(participant) {
    try {
        return Array.from(participant?.audioTrackPublications?.values?.() || []);
    } catch (_) {
        return [];
    }
}

function normalizeTrackText(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function getPublicationText(publication) {
    return [
        publication?.trackName,
        publication?.name,
        publication?.track?.name,
        publication?.track?.mediaStreamTrack?.label,
        publication?.source,
    ].map(normalizeTrackText).filter(Boolean).join('|');
}

function isRuntimeScreenAudioPublication(publication) {
    const source = publication?.source;
    const screenAudioSource = LivekitClient?.Track?.Source?.ScreenShareAudio;
    if (source === screenAudioSource || source === 'screen_share_audio' || source === 'screen-share-audio') return true;
    const text = getPublicationText(publication);
    return text.includes('screen-share-audio') || text.includes('screenshare-audio');
}

function isRuntimeAppAudioPublication(publication) {
    const text = getPublicationText(publication);
    return [
        'app-audio',
        'appaudio',
        'application-audio',
        'system-audio',
        'process-audio',
        'window-audio',
    ].some((keyword) => text.includes(keyword));
}

function isRuntimeMicAudioPublication(publication) {
    if (!publication) return false;
    if (isRuntimeScreenAudioPublication(publication) || isRuntimeAppAudioPublication(publication)) return false;

    const source = publication?.source;
    const micSource = LivekitClient?.Track?.Source?.Microphone;
    if (source === micSource || source === 'microphone' || source === 'mic') return true;

    // 没有 source 的普通 audio publication，排除特殊音源后兜底视为麦克风。
    return true;
}

function isRuntimePublicationMuted(publication) {
    return !!(
        publication?.isMuted
        || publication?.muted
        || publication?.track?.isMuted
        || publication?.track?.muted
        || publication?.track?.mediaStreamTrack?.muted
    );
}

function hasLiveRuntimePublicationTrack(publication) {
    const track = publication?.track;
    const mediaTrack = track?.mediaStreamTrack;
    if (!track && !mediaTrack) return false;
    if (mediaTrack?.readyState === 'ended') return false;
    return true;
}

function hasActiveRuntimePublication(publication) {
    if (!publication) return false;
    // 停止共享后，某些 LiveKit 版本会短暂保留 publication，但 track 会变空或 ended。
    // 频道成员列表只应该显示当前仍有真实音轨的共享音量。
    return hasLiveRuntimePublicationTrack(publication);
}

function hasAttachedRuntimeAudioSource(identity, source) {
    const cleanIdentity = String(identity || '');
    if (!cleanIdentity || typeof document === 'undefined') return false;
    return Array.from(document.querySelectorAll('[data-audio-identity]')).some((el) => {
        if (!el?.isConnected) return false;
        if (el?.dataset?.audioIdentity !== cleanIdentity || el?.dataset?.audioSource !== source) return false;
        const media = el?.srcObject instanceof MediaStream ? el.srcObject.getAudioTracks?.()[0] : null;
        if (media && media.readyState === 'ended') return false;
        return true;
    });
}

function buildVoiceMemberAudioState(participant, { isSelf = false } = {}) {
    const identity = String(participant?.identity || '').trim();
    const displayName = String(participant?.name || participant?.identity || '').trim();
    const connectionId = isSelf ? getConnectionId() : '';
    const stableUserId = isSelf ? String(profileStore.userId || '').trim() : '';
    const stableName = isSelf ? String(profileStore.displayName || '').trim() : '';
    const wsIdentity = isSelf ? String(presenceClient.getIdentity?.() || '').trim() : '';

    const publications = getParticipantAudioPublications(participant);
    const micPublications = publications.filter((publication) => isRuntimeMicAudioPublication(publication) && hasActiveRuntimePublication(publication));
    const hasMicPublication = micPublications.length > 0;
    const anyMicPublicationOpen = hasMicPublication && micPublications.some((publication) => !isRuntimePublicationMuted(publication));
    const livekitSaysMicEnabled = participant?.isMicrophoneEnabled === true;
    const rustSaysMicEnabled = isSelf && !!rustMicFeature.getIsMicOn?.();

    // 根源修复：开麦状态只用于显示“能不能听到这个人的麦克风”。
    // 本地用户优先合并 Rust 麦克风状态、LiveKit isMicrophoneEnabled、实际 audio publication；
    // 避免只看某一个状态导致“我明明开麦却显示闭麦”。
    const micOpen = !!(rustSaysMicEnabled || livekitSaysMicEnabled || anyMicPublicationOpen);

    const hasLocalAppAudioTrack = !!(
        localAppAudioPublication
        && hasActiveRuntimePublication(localAppAudioPublication)
    );
    const hasAppAudio = isSelf
        ? !!(isAppAudioSharing && hasLocalAppAudioTrack)
        : publications.some((publication) => isRuntimeAppAudioPublication(publication) && hasActiveRuntimePublication(publication));

    const stateKeys = [
        identity,
        displayName,
        stableUserId,
        stableName,
        wsIdentity,
        connectionId,
    ].filter(Boolean);

    // 音量控制必须使用真实 LiveKit participant.identity，因为 remoteAudioFeature 的 GainNode
    // 是在 TrackSubscribed 时按 participant.identity 注册的。
    const volumeIdentity = identity || displayName || stableUserId || stableName || 'unknown';

    return {
        keys: stateKeys,
        identity: identity || stableUserId || displayName,
        userId: stableUserId || identity || displayName,
        displayName: displayName || stableName || identity,
        volumeIdentity,
        isSelf,
        micOpen,
        hasAppAudio,
        micVolumePercent: getParticipantVolumePercent(volumeIdentity, 'mic'),
        appAudioVolumePercent: getParticipantVolumePercent(volumeIdentity, 'appaudio'),
        updatedAt: Date.now(),
    };
}

function syncVoiceMemberAudioStatesFromRoom(reason = 'unknown') {
    if (!room) {
        clearVoiceMemberAudioStates();
        return;
    }

    const states = [];
    if (room.localParticipant) {
        states.push(buildVoiceMemberAudioState(room.localParticipant, { isSelf: true }));
    }

    try {
        Array.from(room.remoteParticipants?.values?.() || []).forEach((participant) => {
            states.push(buildVoiceMemberAudioState(participant, { isSelf: false }));
        });
    } catch (error) {
        logError(`runtime/syncVoiceMemberAudioStatesFromRoom 读取远端成员失败 reason=${reason}`, error, 'warn');
    }

    syncVoiceMemberAudioStates(states);
}

// 创建业务模块，并通过 context 注入它们需要的状态读写函数。
const appAudioFeature = createAppAudioFeature({
    invoke,
    sanitizeText,
    getRoom: () => room,
    getIsAppAudioSharing: () => isAppAudioSharing,
    setIsAppAudioSharing: (value) => { isAppAudioSharing = value; syncVoiceMemberAudioStatesFromRoom('app_audio_sharing_changed'); requestStoreSync(); },
    getLocalAppAudioPublication: () => localAppAudioPublication,
    setLocalAppAudioPublication: (value) => { localAppAudioPublication = value; syncVoiceMemberAudioStatesFromRoom('app_audio_publication_changed'); },
    initLocalPcmPipeline: (...args) => audioPipelinesFeature.initLocalPcmPipeline(...args),
    teardownLocalPcmPipeline: () => audioPipelinesFeature.teardownLocalPcmPipeline(),
});

const screenShareFeature = createScreenShareFeature({
    LivekitClient,
    getRoom: () => room,
    getIsScreenOn: () => isScreenOn,
    setIsScreenOn: (value) => { isScreenOn = value; requestStoreSync(); },
});

const chatFeature = createChatFeature({
    getRoom: () => room,
    sanitizeText,
});

const remoteAudioFeature = createRemoteAudioFeature({
    ensureAudioContext,
    getRemoteAudioContext: () => remoteAudioContext,
    ensureParticipantVolumeState,
    normalizeGainValue,
    saveUserVolumesToStorage,
});

const participantsFeature = createParticipantsFeature({
    LivekitClient,
    getRoom: () => room,
    ensureParticipantVolumeState,
    gainToPercent,
    activeSpeakerDebounceMs: ACTIVE_SPEAKER_DEBOUNCE_MS,
});

const livekitEventsFeature = createLivekitEventsFeature({
    LivekitClient,
    getRoom: () => room,
    getSelectedAudioOutputId: () => selectedAudioOutputId,
    ensureParticipantVolumeState,
    addRemoteGainNode: (...args) => remoteAudioFeature.addRemoteGainNode(...args),
    removeRemoteAudioRouteByTrackSid: (...args) => remoteAudioFeature.removeRemoteAudioRouteByTrackSid(...args),
    updateParticipantList: (...args) => updateParticipantList(...args),
    updateActiveSpeakerUI: (...args) => updateActiveSpeakerUI(...args),
    markParticipantAsActiveSpeaker: (...args) => participantsFeature.markParticipantAsActiveSpeaker(...args),
    scheduleParticipantActiveSpeakerOff: (identity) => {
        const result = participantsFeature.scheduleParticipantActiveSpeakerOff(identity);
        // 频道成员头像高亮由 presenceStore.speakingIdentities 驱动。
        // participantsFeature 内部有延迟关闭高亮的防抖，这里在防抖结束后再同步一次，
        // 避免“头像绿光打开后不关闭”或 Vue 区域完全收不到关闭状态。
        setTimeout(() => {
            try {
                syncSpeakingIdentities(participantsFeature.getActiveSpeakerIdentities());
            } catch (error) {
                logError('runtime/scheduleParticipantActiveSpeakerOff 同步说话状态失败', error, 'warn');
            }
        }, ACTIVE_SPEAKER_DEBOUNCE_MS + 30);
        return result;
    },
    getActiveSpeakerIdentities: () => participantsFeature.getActiveSpeakerIdentities(),
    activeSpeakerLevelThreshold: ACTIVE_SPEAKER_LEVEL_THRESHOLD,
    showLocalScreenPreview: (...args) => screenShareFeature.showLocalScreenPreview(...args),
    hideLocalScreenPreview: (...args) => screenShareFeature.hideLocalScreenPreview(...args),
    renderChatMessage: (...args) => chatFeature.renderChatMessage(...args),
    onLivekitConnectionStable: ({ reason } = {}) => {
        schedulePresenceChannelSync(`livekit_${reason || 'stable'}`, { delayMs: 120, snapshotDelayMs: 350 });
        requestStoreSync();
    },
    onLivekitConnectionUnstable: ({ reason } = {}) => {
        console.debug?.('[LiveKit] connection unstable', reason || 'unknown');
        requestStoreSync();
    },
    onLivekitParticipantsChanged: ({ reason } = {}) => {
        schedulePresenceChannelSync(`livekit_participants_${reason || 'changed'}`, { delayMs: 250, snapshotDelayMs: 450 });
        requestStoreSync();
    },
    onActiveSpeakersChanged: (activeIdentities) => {
        syncSpeakingIdentities(activeIdentities);
    },
});

const rustMicFeature = createRustMicFeature({
    LivekitClient,
    invoke,
    listen,
    isTauriClient,
    getRoom: () => room,
    getCurrentChannel: () => roomConnectionFeature?.getCurrentChannel?.() || null,
    initRustMicPipeline: (...args) => audioPipelinesFeature.initRustMicPipeline(...args),
    teardownRustMicPipeline: () => audioPipelinesFeature.teardownRustMicPipeline(),
    updateMicList: () => updateMicList(),
});

roomConnectionFeature = createRoomConnectionFeature({
    LivekitClient,
    isTauriClient,
    presence: presenceClient,
    defaultServerIp: DEFAULT_SERVER_IP,
    autoJoinFirstChannelAfterLobby: AUTO_JOIN_FIRST_CHANNEL_AFTER_LOBBY,
    sanitizeText,
    getRoom: () => room,
    setRoom: (value) => { room = value; if (!value) clearVoiceMemberAudioStates(); else syncVoiceMemberAudioStatesFromRoom('set_room'); requestStoreSync(); },
    ensureAudioContext,
    audioPipelines: audioPipelinesFeature,
    rustMic: rustMicFeature,
    appAudio: {
        getIsAppAudioSharing: () => isAppAudioSharing,
        setIsAppAudioSharing: (value) => { isAppAudioSharing = value; syncVoiceMemberAudioStatesFromRoom('app_audio_sharing_changed'); requestStoreSync(); },
        setLocalAppAudioPublication: (value) => { localAppAudioPublication = value; syncVoiceMemberAudioStatesFromRoom('app_audio_publication_changed'); },
        stopAppAudioShare: (...args) => appAudioFeature.stopAppAudioShare(...args),
        updateAppAudioButtons: (...args) => appAudioFeature.updateAppAudioButtons(...args),
        closeAppAudioModal: (...args) => appAudioFeature.closeAppAudioModal(...args),
    },
    screenShare: {
        getIsScreenOn: () => isScreenOn,
        setIsScreenOn: (value) => { isScreenOn = value; requestStoreSync(); },
        stopScreenBitrateMonitor: (...args) => screenShareFeature.stopScreenBitrateMonitor(...args),
        hideLocalScreenPreview: (...args) => screenShareFeature.hideLocalScreenPreview(...args),
    },
    participants: {
        ...participantsFeature,
        clearActiveSpeakers: () => {
            participantsFeature.clearActiveSpeakers();
            clearSpeakingIdentities();
            clearVoiceMemberAudioStates();
        },
    },
    remoteAudio: remoteAudioFeature,
    livekitEvents: livekitEventsFeature,
    updateMicList: () => updateMicList(),
    updateAudioOutputList: () => updateAudioOutputList(),
    switchAudioOutput: (deviceId) => switchAudioOutput(deviceId),
    getSelectedAudioOutputId: () => selectedAudioOutputId,
});


// appStore 同步桥。
// 旧 DOM 渲染仍然存在，因此这里从运行时状态生成快照，供新 Vue 组件逐步迁移使用。
let __syncScheduled = false;

function getInputValue(id, fallback = '') {
    return document.getElementById(id)?.value ?? fallback;
}

/** 汇总当前运行时状态，供 appStore 和后续 Vue 响应式 UI 使用。 */
function getRuntimeSnapshot() {
    return {
        serverIp: getInputValue('server-ip', localStorage.getItem('lk_server_ip') || DEFAULT_SERVER_IP),
        username: getInputValue('username', localStorage.getItem('lk_username') || ''),
        isInLobby: roomConnectionFeature?.getIsInLobby?.() || false,
        isConnected: !!(room && room.localParticipant),
        currentChannel: roomConnectionFeature?.getCurrentChannel?.() || null,
        channels: roomConnectionFeature?.getChannels?.() || [],
        micOn: rustMicFeature.getIsMicOn(),
        rustMicOn: rustMicFeature.getIsRustMicOn(),
        micSource: rustMicFeature.getCurrentMicSource?.() || (isTauriClient ? 'rust' : 'browser'),
        micMonitorOn: audioPipelinesFeature.getIsMicMonitorOn?.() || false,
        screenOn: isScreenOn,
        appAudioSharing: isAppAudioSharing,
        selectedAudioOutputId,
        selectedRustMicId: localStorage.getItem('lk_rust_mic_device_id') || '',
        selectedBrowserMicId: localStorage.getItem('lk_mic') || '',
    };
}

/** 立即把运行时状态同步到轻量 store；失败只记录日志，不中断音频链路。 */
function syncAppStore() {
    try {
        syncFromRuntimeSnapshot(getRuntimeSnapshot());
    } catch (error) {
        logError('runtime/syncAppStore 同步 appStore 失败', error, 'warn');
        setLastError(error);
    }
}

/** 合并同一轮事件循环内的多次状态更新，减少重复 store 写入。 */
function requestStoreSync() {
    if (__syncScheduled) return;
    __syncScheduled = true;
    queueMicrotask(() => {
        __syncScheduled = false;
        syncAppStore();
    });
}

/** 包装异步动作：动作完成后统一同步 store，保证按钮状态和业务状态一致。 */
function syncAfterRuntimeAction(reason = 'after_action') {
    syncAppStore();
    syncVoiceMemberAudioStatesFromRoom(reason);
}

function afterAction(result) {
    if (result && typeof result.finally === 'function') {
        return result.finally(() => syncAfterRuntimeAction('after_action'));
    }
    syncAfterRuntimeAction('after_action');
    return result;
}

// 兼容层封装：保持 App.vue 和少量旧 onclick 仍可调用原函数名。
function initRustMicPipeline(sampleRate, wsUrl) { return audioPipelinesFeature.initRustMicPipeline(sampleRate, wsUrl); }
function teardownRustMicPipeline() { return audioPipelinesFeature.teardownRustMicPipeline(); }
function initLocalPcmPipeline(sampleRate, wsUrl) { return audioPipelinesFeature.initLocalPcmPipeline(sampleRate, wsUrl); }
function teardownLocalPcmPipeline() { return audioPipelinesFeature.teardownLocalPcmPipeline(); }
function getLocalPcmTrack() { return audioPipelinesFeature.getLocalPcmTrack(); }
function toggleMicMonitor() { return afterAction(audioPipelinesFeature.toggleMicMonitor()); }

function updateAppAudioButtons() { return appAudioFeature.updateAppAudioButtons(); }
function closeAppAudioModal(event) { return appAudioFeature.closeAppAudioModal(event); }
function handleAppAudioClick() { return afterAction(appAudioFeature.handleAppAudioClick()); }
function openAppAudioModal() { return afterAction(appAudioFeature.openAppAudioModal()); }
function toggleAppAudioProcessSelection(pid) { return appAudioFeature.toggleAppAudioProcessSelection(pid); }
function confirmAppAudioSelection() { return afterAction(appAudioFeature.confirmAppAudioSelection()); }
function stopAppAudioShare() { return afterAction(appAudioFeature.stopAppAudioShare()); }

function toggleScreen() { return afterAction(screenShareFeature.toggleScreen()); }
function stopScreenBitrateMonitor() { return screenShareFeature.stopScreenBitrateMonitor(); }
function hideLocalScreenPreview() { return screenShareFeature.hideLocalScreenPreview(); }
function showLocalScreenPreview(track) { return screenShareFeature.showLocalScreenPreview(track); }
function getLocalScreenPublication() { return screenShareFeature.getLocalScreenPublication(); }
function hasPublishedScreenAudioTrack() { return screenShareFeature.hasPublishedScreenAudioTrack(); }

function createClientMessageId() {
    return 'local_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function sendChatMessage(text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return false;

    const currentChannel = roomConnectionFeature?.getCurrentChannel?.();
    if (!currentChannel) {
        logError('runtime/sendChatMessage 当前未加入频道，无法发送聊天消息', null, 'warn');
        return false;
    }

    const clientMessageId = createClientMessageId();
    const senderUserId = chatClient.getUserId?.() || profileStore.userId;
    const senderIdentity = chatClient.getIdentity?.() || presenceClient.getIdentity?.() || senderUserId;
    const senderName = profileStore.displayName || getInputValue('username', localStorage.getItem('lk_username') || '') || '访客';

    const localMessage = addChatMessage({
        id: clientMessageId,
        clientMessageId,
        channelId: currentChannel,
        senderId: senderUserId,
        senderUserId,
        senderIdentity,
        senderName,
        senderColor: profileStore.avatarColor,
        senderPreset: profileStore.avatarPreset,
        senderAvatarUrl: profileStore.avatarUrl || '',
        content: cleanText,
        timestamp: Date.now(),
        isSelf: true,
        status: 'sending',
    });

    // Phase 2.1：发送前确保 Chat WebSocket 处于 OPEN，并补订阅当前频道。
    await ensureChatSocketConnected(3000);
    if (currentChannel) chatClient.subscribeChannel(currentChannel);

    let sent = chatClient.sendMessage({
        clientMessageId: localMessage.clientMessageId || clientMessageId,
        channelId: currentChannel,
        content: cleanText,
        senderColor: profileStore.avatarColor,
        senderPreset: profileStore.avatarPreset,
        senderAvatarUrl: profileStore.avatarUrl || '',
    });

    // 临界状态兜底：如果第一次发送失败，等待/重连后再重试一次。
    if (!sent) {
        await ensureChatSocketConnected(2000);
        if (currentChannel) chatClient.subscribeChannel(currentChannel);
        sent = chatClient.sendMessage({
            clientMessageId: localMessage.clientMessageId || clientMessageId,
            channelId: currentChannel,
            content: cleanText,
            senderColor: profileStore.avatarColor,
            senderPreset: profileStore.avatarPreset,
            senderAvatarUrl: profileStore.avatarUrl || '',
        });
    }

    if (!sent) {
        markMessageFailed(clientMessageId);
        const debug = chatClient.getDebugState?.() || {};
        logError(
            `runtime/sendChatMessage Chat WebSocket 发送失败 channel=${currentChannel} state=${debug.readyStateText || debug.readyState || 'unknown'} connected=${debug.connected} apiBase=${getCurrentApiBase()}`,
            null,
            'warn'
        );
    }

    requestStoreSync();
    return sent;
}
function renderChatMessage(msgDataOrSender, text, isSelf) { return chatFeature.renderChatMessage(msgDataOrSender, text, isSelf); }

function addRemoteGainNode(identity, source, track, audioEl) { return remoteAudioFeature.addRemoteGainNode(identity, source, track, audioEl); }
function clearRemoteGainNodes() { return remoteAudioFeature.clearRemoteGainNodes(); }
function removeRemoteAudioRouteByTrackSid(trackSid) { return remoteAudioFeature.removeRemoteAudioRouteByTrackSid(trackSid); }
function setParticipantVolume(identity, source, volumeValue) {
    const cleanIdentity = String(identity || '').trim();
    const cleanSource = String(source || 'mic').trim() || 'mic';
    const result = remoteAudioFeature.setParticipantVolume(cleanIdentity, cleanSource, volumeValue);

    if (cleanIdentity) {
        const patch = { volumeIdentity: cleanIdentity };
        if (cleanSource === 'mic') {
            patch.micVolumePercent = getParticipantVolumePercent(cleanIdentity, 'mic');
        }
        if (cleanSource === 'appaudio') {
            patch.appAudioVolumePercent = getParticipantVolumePercent(cleanIdentity, 'appaudio');
        }
        patchVoiceMemberAudioState(cleanIdentity, patch);
    }

    return result;
}

/** 返回某个成员某类音源的界面百分比，范围 0~300。 */
function getParticipantVolumePercent(identity, source = 'mic') {
    const volumes = ensureParticipantVolumeState(identity);
    const gain = volumes[source] !== undefined ? volumes[source] : 1;
    return gainToPercent(gain);
}

function updateParticipantList() {
    const result = participantsFeature.updateParticipantList();
    syncVoiceMemberAudioStatesFromRoom('update_participant_list');
    return result;
}
function updateActiveSpeakerUI() {
    const result = participantsFeature.updateActiveSpeakerUI();
    // 旧 DOM 成员列表由 participantsFeature 自己更新；
    // Vue 语音频道成员列表需要同步到 presenceStore 才能触发 BaseAvatar 说话绿光。
    try {
        syncSpeakingIdentities(participantsFeature.getActiveSpeakerIdentities());
    } catch (error) {
        logError('runtime/updateActiveSpeakerUI 同步说话状态失败', error, 'warn');
    }
    return result;
}
function toggleLocalScreenSubscription(identity) { return livekitEventsFeature.toggleLocalScreenSubscription(identity); }

function getMicCaptureOptions() { return rustMicFeature.getMicCaptureOptions(); }
function updateMicSourceButton() { return rustMicFeature.updateMicSourceButton(); }
function switchMicSource(source) { return rustMicFeature.switchMicSource(source); }
function startRustMicShare() { return afterAction(rustMicFeature.startRustMicShare()); }
function stopRustMicShare() { return afterAction(rustMicFeature.stopRustMicShare()); }
function toggleRustMicShare() { return afterAction(rustMicFeature.toggleRustMicShare()); }
function toggleMic() { return afterAction(rustMicFeature.toggleMic()); }

function getServerConfig() { return roomConnectionFeature.getServerConfig(); }
function renderChannelList() { return roomConnectionFeature.renderChannelList(); }
function refreshRoomsFromServer() { return roomConnectionFeature.refreshRoomsFromServer(); }
function startRoomPolling() { return roomConnectionFeature.startRoomPolling(); }
function stopRoomPolling() { return roomConnectionFeature.stopRoomPolling(); }
function createChannel() { return roomConnectionFeature.createChannel(); }
function resetRoomUIAfterDisconnect() { return roomConnectionFeature.resetRoomUIAfterDisconnect(); }

function getCurrentApiBase() {
    try {
        const cfg = roomConnectionFeature?.getServerConfig?.();
        const base = cfg?.apiBase || (() => {
            const ip = appStore.connection.serverIp || DEFAULT_SERVER_IP;
            const host = ip.includes(':') ? ip.split(':')[0] : ip;
            const port = ip.includes(':') ? ip.split(':')[1] : '5000';
            return `http://${host}:${port}`;
        })();
        if (base) setApiBase(base);
        return base;
    } catch (_) {
        return '';
    }
}

async function ensureChatSocketConnected(timeoutMs = 3000) {
    const apiBase = getCurrentApiBase();
    if (!apiBase) {
        logError('runtime/ensureChatSocketConnected 缺少 apiBase，无法连接 Chat WebSocket', null, 'warn');
        return false;
    }

    const options = {
        apiBase,
        userId: profileStore.userId,
        connectionId: getConnectionId(),
        identity: presenceClient.getIdentity?.() || profileStore.userId,
        displayName: profileStore.displayName || getInputValue('username', localStorage.getItem('lk_username') || '') || '访客',
        avatarColor: profileStore.avatarColor,
        avatarPreset: profileStore.avatarPreset,
        avatarUrl: profileStore.avatarUrl,
        statusText: profileStore.statusText || '在线',
    };

    try {
        if (chatClient.ensureConnected) {
            await chatClient.ensureConnected(options, timeoutMs);
        } else {
            await chatClient.connect(options);
        }
    } catch (error) {
        logError('runtime/ensureChatSocketConnected 连接 Chat WebSocket 失败', error, 'warn');
    }

    const connected = chatClient.isConnected?.() || false;
    const current = roomConnectionFeature?.getCurrentChannel?.();
    if (connected && current) chatClient.subscribeChannel(current);
    return connected;
}

function joinRoom(options) {
    // 进入大厅时记录 apiBase，供 REST 和 Chat WebSocket 使用
    getCurrentApiBase();
    syncProfileToServer({ silent: true });
    return afterAction(
        Promise.resolve(roomConnectionFeature.joinRoom(options)).then(async (result) => {
            await ensureChatSocketConnected().catch((error) => {
                logError('runtime/joinRoom 连接 Chat WebSocket 失败', error, 'warn');
            });
            return result;
        })
    );
}
function switchChannel(roomName) {
    // 切换频道时先切换本地频道记录；历史加载交给 chat_subscribed 后的稳定时机触发。
    if (roomName) {
        switchChatChannel(roomName);
        scheduleChatHistoryRefresh(roomName, 'switch_channel', { force: true, delayMs: 350 });
    }
    return afterAction(
        Promise.resolve(roomConnectionFeature.switchChannel(roomName)).then((result) => {
            if (roomName) {
                chatClient.subscribeChannel(roomName);
                schedulePresenceChannelSync('switch_channel', { delayMs: 120, snapshotDelayMs: 350 });
            }
            return result;
        })
    );
}
function connectToChannel(targetRoomName, options) {
    if (targetRoomName) {
        switchChatChannel(targetRoomName);
        scheduleChatHistoryRefresh(targetRoomName, 'connect_to_channel', { force: true, delayMs: 350 });
    }
    return afterAction(
        Promise.resolve(roomConnectionFeature.connectToChannel(targetRoomName, options)).then((result) => {
            if (result && targetRoomName) {
                chatClient.subscribeChannel(targetRoomName);
                schedulePresenceChannelSync('connect_to_channel', { delayMs: 120, snapshotDelayMs: 350 });
            }
            return result;
        })
    );
}
function leaveRoom() {
    return afterAction(
        Promise.resolve(roomConnectionFeature.leaveRoom()).finally(() => {
            chatClient.disconnect();
        })
    );
}


/** 返回当前 LiveKit Room 对象，仅供 UI 统计面板读取本地 WebRTC stats。 */
function getLiveKitRoom() { return room; }

/** 刷新麦克风下拉框；Tauri 模式走 Rust 设备枚举，浏览器模式走 LiveKit 设备枚举。 */
async function updateMicList() {
    return updateMicListFromModule({
        isTauriClient,
        invoke,
        LivekitClient,
    });
}

/** 切换麦克风设备；如果当前 Rust 麦克风已开启，会重启 9002 管线并重新 publish。 */
async function switchMic(deviceId) {
    const result = await switchMicFromModule(deviceId, {
        isTauriClient,
        invoke,
        LivekitClient,
        getRoom: () => room,
        isMicActive: () => rustMicFeature.getIsMicOn(),
        isRustMicActive: () => rustMicFeature.getIsRustMicOn(),
        hasLocalRustMicPublication: () => rustMicFeature.hasLocalRustMicPublication(),
        stopRustMicShare: () => rustMicFeature.stopRustMicShare(),
        startRustMicShare: () => rustMicFeature.startRustMicShare(),
        afterRustMicRestart: () => {
            rustMicFeature.setMicOn(true);
            rustMicFeature.setRustMicOn(true);
            rustMicFeature.showRustMicUi();
            rustMicFeature.updateMicSourceButton();
        },
    });
    syncAppStore();
    return result;
}

/** 刷新扬声器下拉框，并恢复上次选择。 */
async function updateAudioOutputList() {
    return updateAudioOutputListFromModule({
        selectedAudioOutputId,
        LivekitClient,
    });
}

/** 切换远端音频和耳返使用的输出设备。 */
async function switchAudioOutput(deviceId) {
    selectedAudioOutputId = await switchAudioOutputFromModule(deviceId, {
        getRemoteAudioContext: () => remoteAudioContext,
        getLocalRustMicAudioContext: () => audioPipelinesFeature.getLocalRustMicAudioContext(),
    });
    syncAppStore();
}

// Vue 挂载完成后执行一次 legacy DOM 初始化。
/** 初始化登录区、频道列表和设备列表。只执行一次。 */
function initLegacyDomBlock1() {
    const savedUser = localStorage.getItem('lk_username');
    if (savedUser) document.getElementById('username').value = savedUser;

    const savedServerIp = localStorage.getItem('lk_server_ip');
    document.getElementById('server-ip').value = savedServerIp || DEFAULT_SERVER_IP;

    renderChannelList();
    updateMicList().catch((error) => logError('runtime/initLegacyDom 初始化麦克风列表失败', error, 'warn'));
    updateAudioOutputList();
}

/** 绑定 VAD 阈值/增益滑块，并监听 Rust 侧 mic_volume 事件更新绿条。 */
function initLegacyDomBlock2() {
    const slider = document.getElementById('vad-slider-input');
    const marker = document.getElementById('vad-threshold-marker');
    const text = document.getElementById('vad-threshold-text');
    const fillBar = document.getElementById('vad-fill-bar');
    const boostSlider = document.getElementById('vad-boost-input');
    const boostText = document.getElementById('vad-boost-text');

    function clampNumber(value, min, max, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(n, max));
    }

    function applyVadThreshold(value, { persist = true } = {}) {
        const val = clampNumber(value, 0, 100, 20);
        if (slider) slider.value = String(val);
        if (marker) marker.style.left = val + '%';
        if (text) text.innerText = val + '%';
        if (persist) localStorage.setItem(VAD_THRESHOLD_STORAGE_KEY, String(val));

        invoke('set_mic_vad_threshold', { val }).catch((error) => {
            logError('runtime/vadSlider 设置麦克风阈值失败', error);
        });
    }

    function applyMicBoost(value, { persist = true } = {}) {
        const val = clampNumber(value, 1, 20, 5);
        const sliderValue = Math.round(val * 10);
        if (boostSlider) boostSlider.value = String(sliderValue);
        if (boostText) boostText.innerText = val.toFixed(1) + 'x';
        if (persist) localStorage.setItem(MIC_BOOST_STORAGE_KEY, String(val));

        invoke('set_mic_boost', { val }).catch((error) => {
            logError('runtime/boostSlider 设置麦克风增益失败', error);
        });
    }

    if (slider) {
        const savedThreshold = localStorage.getItem(VAD_THRESHOLD_STORAGE_KEY);
        applyVadThreshold(savedThreshold ?? slider.value ?? 20, { persist: false });

        slider.addEventListener('input', (e) => {
            applyVadThreshold(e.target.value);
        });
    }

    if (boostSlider) {
        const savedBoost = localStorage.getItem(MIC_BOOST_STORAGE_KEY);
        const initialBoost = savedBoost ?? (Number(boostSlider.value || 50) / 10.0);
        applyMicBoost(initialBoost, { persist: false });

        boostSlider.addEventListener('input', (e) => {
            applyMicBoost(Number(e.target.value) / 10.0);
        });
    }

    listen('mic_volume', (event) => {
        const volumePercent = Number(event.payload) || 0;

        // 设置中心改成标签页后，VAD 相关 DOM 可能在初始化后被 Vue 重新挂载。
        // 这里每次事件都重新查询一次元素，避免闭包里保存的是旧节点或空节点，
        // 导致 Rust 仍在发送 mic_volume，但绿线不再跳动。
        const liveFillBar = document.getElementById('vad-fill-bar') || fillBar;
        const liveSlider = document.getElementById('vad-slider-input') || slider;

        if (liveFillBar) {
            liveFillBar.style.width = volumePercent + '%';
            const threshold = parseFloat(liveSlider?.value || '0');
            liveFillBar.style.background = volumePercent < threshold ? '#4f545c' : '#23a559';
        }
    });

    rustMicFeature.registerRustMicErrorListener();
}

let __legacyDomInitialized = false;

/** Vue DOM 挂载后调用；负责连接保留的 DOM id 与旧业务逻辑。 */
export function initLegacyDom() {
    if (__legacyDomInitialized) return;
    __legacyDomInitialized = true;
    initLegacyDomBlock1();
    initLegacyDomBlock2();
    markAppBooted();
    syncAppStore();
}

Object.assign(window, {
    joinRoom,
    createChannel,
    switchChannel,
    toggleMic,
    toggleMicMonitor,
    toggleScreen,
    handleAppAudioClick,
    leaveRoom,
    closeAppAudioModal,
    confirmAppAudioSelection,
    toggleAppAudioProcessSelection,
    switchMic,
    switchAudioOutput,
    sendChatMessage,
    toggleLocalScreenSubscription,
    setParticipantVolume,
    openAppAudioModal,
    stopAppAudioShare,
    renderChatMessage,
    switchMicSource,
    __appStore: appStore,
    __presenceClient: presenceClient,
    __chatClient: chatClient,
    __syncAppStore: syncAppStore,
    __syncPresenceChannel: syncPresenceChannel,
    __schedulePresenceChannelSync: schedulePresenceChannelSync,
    getLiveKitRoom,
});

export {
    appStore,
    syncAppStore,
    getRuntimeSnapshot,
    getLiveKitRoom,
    joinRoom,
    createChannel,
    switchChannel,
    connectToChannel,
    renderChannelList,
    refreshRoomsFromServer,
    startRoomPolling,
    stopRoomPolling,
    switchMic,
    switchAudioOutput,
    setParticipantVolume,
    getParticipantVolumePercent,
    toggleMic,
    toggleMicMonitor,
    toggleScreen,
    handleAppAudioClick,
    leaveRoom,
    closeAppAudioModal,
    confirmAppAudioSelection,
    sendChatMessage,
};
