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
import { profileStore } from '../stores/profileStore.js';
import { watch } from 'vue';
import { switchChatChannel, loadServerHistory, applyServerChatMessage, applyServerReactionUpdate, updateChatAvatars } from '../stores/chatStore.js';
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

        // 服务器推送的聊天消息广播（其他人发送的）
        if (message.type === 'chat_message' && message.message) {
            const selfId = presenceClient.getIdentity?.() || '';
            applyServerChatMessage(message.message, selfId);
        }

        // 服务器推送的 reaction 更新
        if (message.type === 'reaction_update') {
            applyServerReactionUpdate(message);
        }

        // 有人更新了 profile
        if (message.type === 'profile_updated') {
            updateChatAvatars(message.identity, message.avatarColor, message.avatarPreset, message.avatarUrl);
        }

        // 收到快照时，全量更新在线用户的头像到本地聊天记录缓存
        if (message.type === 'presence_snapshot' && message.participants) {
            for (const p of Object.values(message.participants)) {
                updateChatAvatars(p.identity, p.avatarColor, p.avatarPreset, p.avatarUrl);
            }
        }

        requestStoreSync();
    },
});

watch(
    () => [profileStore.avatarColor, profileStore.avatarPreset, profileStore.avatarUrl],
    ([avatarColor, avatarPreset, avatarUrl]) => {
        if (presenceClient.isConnected()) {
            presenceClient.updateProfile({ avatarColor, avatarPreset, avatarUrl });
        }
        // 当自己更新资料时，也需要同步更新本地聊天记录中的自己发送的消息头像
        updateChatAvatars(presenceClient.getIdentity?.() || profileStore.userId, avatarColor, avatarPreset, avatarUrl);
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

// 创建业务模块，并通过 context 注入它们需要的状态读写函数。
const appAudioFeature = createAppAudioFeature({
    invoke,
    sanitizeText,
    getRoom: () => room,
    getIsAppAudioSharing: () => isAppAudioSharing,
    setIsAppAudioSharing: (value) => { isAppAudioSharing = value; requestStoreSync(); },
    getLocalAppAudioPublication: () => localAppAudioPublication,
    setLocalAppAudioPublication: (value) => { localAppAudioPublication = value; },
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
    updateParticipantList: (...args) => participantsFeature.updateParticipantList(...args),
    updateActiveSpeakerUI: (...args) => participantsFeature.updateActiveSpeakerUI(...args),
    markParticipantAsActiveSpeaker: (...args) => participantsFeature.markParticipantAsActiveSpeaker(...args),
    scheduleParticipantActiveSpeakerOff: (...args) => participantsFeature.scheduleParticipantActiveSpeakerOff(...args),
    getActiveSpeakerIdentities: () => participantsFeature.getActiveSpeakerIdentities(),
    activeSpeakerLevelThreshold: ACTIVE_SPEAKER_LEVEL_THRESHOLD,
    showLocalScreenPreview: (...args) => screenShareFeature.showLocalScreenPreview(...args),
    hideLocalScreenPreview: (...args) => screenShareFeature.hideLocalScreenPreview(...args),
    renderChatMessage: (...args) => chatFeature.renderChatMessage(...args),
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
    setRoom: (value) => { room = value; requestStoreSync(); },
    onAutoJoinChannel: switchChannel,
    ensureAudioContext,
    audioPipelines: audioPipelinesFeature,
    rustMic: rustMicFeature,
    appAudio: {
        getIsAppAudioSharing: () => isAppAudioSharing,
        setIsAppAudioSharing: (value) => { isAppAudioSharing = value; requestStoreSync(); },
        setLocalAppAudioPublication: (value) => { localAppAudioPublication = value; },
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
    participants: participantsFeature,
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
function afterAction(result) {
    if (result && typeof result.finally === 'function') {
        return result.finally(syncAppStore);
    }
    syncAppStore();
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

function sendChatMessage(text) { return chatFeature.sendChatMessage(text); }
function renderChatMessage(msgDataOrSender, text, isSelf) { return chatFeature.renderChatMessage(msgDataOrSender, text, isSelf); }

function addRemoteGainNode(identity, source, track, audioEl) { return remoteAudioFeature.addRemoteGainNode(identity, source, track, audioEl); }
function clearRemoteGainNodes() { return remoteAudioFeature.clearRemoteGainNodes(); }
function removeRemoteAudioRouteByTrackSid(trackSid) { return remoteAudioFeature.removeRemoteAudioRouteByTrackSid(trackSid); }
function setParticipantVolume(identity, source, volumeValue) { return remoteAudioFeature.setParticipantVolume(identity, source, volumeValue); }

/** 返回某个成员某类音源的界面百分比，范围 0~300。 */
function getParticipantVolumePercent(identity, source = 'mic') {
    const volumes = ensureParticipantVolumeState(identity);
    const gain = volumes[source] !== undefined ? volumes[source] : 1;
    return gainToPercent(gain);
}

function updateParticipantList() { return participantsFeature.updateParticipantList(); }
function updateActiveSpeakerUI() { return participantsFeature.updateActiveSpeakerUI(); }
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
function ensureApiBase() {
    try {
        const cfg = roomConnectionFeature.getServerConfig?.();
        if (cfg?.apiBase) setApiBase(cfg.apiBase);
    } catch (_) {}
}

function joinRoom(options) {
    ensureApiBase();
    return afterAction(roomConnectionFeature.joinRoom(options));
}

function switchChannel(roomName) {
    ensureApiBase();
    // 切换频道时，先切换本地频道记录，再从服务器加载历史
    if (roomName) {
        switchChatChannel(roomName);
        loadServerHistory(roomName).catch(() => {});
    }
    return afterAction(roomConnectionFeature.switchChannel(roomName));
}

function connectToChannel(targetRoomName, options) {
    ensureApiBase();
    if (targetRoomName) {
        switchChatChannel(targetRoomName);
        loadServerHistory(targetRoomName).catch(() => {});
    }
    return afterAction(roomConnectionFeature.connectToChannel(targetRoomName, options));
}

function leaveRoom() { return afterAction(roomConnectionFeature.leaveRoom()); }


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
    __syncAppStore: syncAppStore,
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
