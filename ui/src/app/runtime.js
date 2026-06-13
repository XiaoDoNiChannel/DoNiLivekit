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

// ------------------------------------------------------------
// Application runtime / composition root
// ------------------------------------------------------------
// runtime.js 是前端运行时装配层：负责创建模块、连接依赖、同步轻量 store。
// 具体业务已经拆到 features/，Vue 组件通过这里暴露的 action 调用业务：
// - roomConnection.js：大厅、频道、连接/切换/离开；
// - rustMic.js：Rust 9002 麦克风发布/停止/错误监听；
// - livekitEvents.js：远端音视频 Track、成员事件、聊天 DataReceived；
// - participants.js：成员列表和 active-speaker 高亮；
// - audioPipelines.js：9001/9002 PCM -> AudioWorklet -> MediaStreamTrack。

let room = null;
let isScreenOn = false;
let remoteAudioContext = null;
let localAppAudioPublication = null;
let isAppAudioSharing = false;
let selectedAudioOutputId = localStorage.getItem('lk_audio_output') || 'default';

const userVolumes = loadUserVolumesFromStorage();
const audioPipelinesFeature = createAudioPipelinesFeature();
let roomConnectionFeature;

function saveUserVolumesToStorage() {
    persistUserVolumesToStorage(userVolumes);
}

function ensureParticipantVolumeState(identity) {
    return ensureParticipantVolumeStateFromStore(userVolumes, identity);
}

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

// ------------------------------
// Feature modules
// ------------------------------
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
    defaultServerIp: DEFAULT_SERVER_IP,
    autoJoinFirstChannelAfterLobby: AUTO_JOIN_FIRST_CHANNEL_AFTER_LOBBY,
    sanitizeText,
    getRoom: () => room,
    setRoom: (value) => { room = value; requestStoreSync(); },
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


// ------------------------------
// Runtime store bridge
// ------------------------------
// 当前阶段仍有部分 legacy DOM 渲染。这里提供一个轻量状态快照，
// 让后续新功能可以逐步迁移到 Vue store，而不需要一次性重写音频/LiveKit 链路。
let __syncScheduled = false;

function getInputValue(id, fallback = '') {
    return document.getElementById(id)?.value ?? fallback;
}

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

function syncAppStore() {
    try {
        syncFromRuntimeSnapshot(getRuntimeSnapshot());
    } catch (error) {
        logError('runtime/syncAppStore 同步 appStore 失败', error, 'warn');
        setLastError(error);
    }
}

function requestStoreSync() {
    if (__syncScheduled) return;
    __syncScheduled = true;
    queueMicrotask(() => {
        __syncScheduled = false;
        syncAppStore();
    });
}

function afterAction(result) {
    if (result && typeof result.finally === 'function') {
        return result.finally(syncAppStore);
    }
    syncAppStore();
    return result;
}

// ------------------------------
// Thin wrappers kept for App.vue and inline onclick compatibility
// ------------------------------
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

function sendChatMessage() { return chatFeature.sendChatMessage(); }
function renderChatMessage(sender, text, isSelf) { return chatFeature.renderChatMessage(sender, text, isSelf); }

function addRemoteGainNode(identity, source, track, audioEl) { return remoteAudioFeature.addRemoteGainNode(identity, source, track, audioEl); }
function clearRemoteGainNodes() { return remoteAudioFeature.clearRemoteGainNodes(); }
function removeRemoteAudioRouteByTrackSid(trackSid) { return remoteAudioFeature.removeRemoteAudioRouteByTrackSid(trackSid); }
function setParticipantVolume(identity, source, volumeValue) { return remoteAudioFeature.setParticipantVolume(identity, source, volumeValue); }

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
function joinRoom(options) { return afterAction(roomConnectionFeature.joinRoom(options)); }
function switchChannel(roomName) { return afterAction(roomConnectionFeature.switchChannel(roomName)); }
function connectToChannel(targetRoomName, options) { return afterAction(roomConnectionFeature.connectToChannel(targetRoomName, options)); }
function leaveRoom() { return afterAction(roomConnectionFeature.leaveRoom()); }

async function updateMicList() {
    return updateMicListFromModule({
        isTauriClient,
        invoke,
        LivekitClient,
    });
}

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

async function updateAudioOutputList() {
    return updateAudioOutputListFromModule({
        selectedAudioOutputId,
    });
}

async function switchAudioOutput(deviceId) {
    selectedAudioOutputId = await switchAudioOutputFromModule(deviceId, {
        getRemoteAudioContext: () => remoteAudioContext,
        getLocalRustMicAudioContext: () => audioPipelinesFeature.getLocalRustMicAudioContext(),
    });
    syncAppStore();
}

// ===== Vue3 migration entry: App.vue renders DOM, then calls this function. =====
function initLegacyDomBlock1() {
    const savedUser = localStorage.getItem('lk_username');
    if (savedUser) document.getElementById('username').value = savedUser;

    const savedServerIp = localStorage.getItem('lk_server_ip');
    document.getElementById('server-ip').value = savedServerIp || DEFAULT_SERVER_IP;

    renderChannelList();
    updateMicList().catch((error) => logError('runtime/initLegacyDom 初始化麦克风列表失败', error, 'warn'));
    updateAudioOutputList();
}

function initLegacyDomBlock2() {
    const slider = document.getElementById('vad-slider-input');
    const marker = document.getElementById('vad-threshold-marker');
    const text = document.getElementById('vad-threshold-text');
    const fillBar = document.getElementById('vad-fill-bar');
    const boostSlider = document.getElementById('vad-boost-input');
    const boostText = document.getElementById('vad-boost-text');

    if (slider) {
        slider.addEventListener('input', (e) => {
            const val = e.target.value;
            if (marker) marker.style.left = val + '%';
            if (text) text.innerText = val + '%';
            invoke('set_mic_vad_threshold', { val: parseFloat(val) }).catch((error) => {
                logError('runtime/vadSlider 设置麦克风阈值失败', error);
            });
        });
    }

    if (boostSlider) {
        boostSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value) / 10.0;
            if (boostText) boostText.innerText = val.toFixed(1) + 'x';
            invoke('set_mic_boost', { val }).catch((error) => {
                logError('runtime/boostSlider 设置麦克风增益失败', error);
            });
        });
    }

    listen('mic_volume', (event) => {
        const volumePercent = event.payload;
        if (fillBar) {
            fillBar.style.width = volumePercent + '%';
            const threshold = parseFloat(slider?.value || '0');
            fillBar.style.background = volumePercent < threshold ? '#4f545c' : '#23a559';
        }
    });

    rustMicFeature.registerRustMicErrorListener();
}

let __legacyDomInitialized = false;

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
    __syncAppStore: syncAppStore,
});

export {
    appStore,
    syncAppStore,
    getRuntimeSnapshot,
    joinRoom,
    createChannel,
    switchMic,
    switchAudioOutput,
    toggleMic,
    toggleMicMonitor,
    toggleScreen,
    handleAppAudioClick,
    leaveRoom,
    closeAppAudioModal,
    confirmAppAudioSelection,
    sendChatMessage,
};
