import { reactive } from 'vue';
import { DEFAULT_SERVER_IP } from '../shared/constants.js';

// 前端轻量状态入口。
// 只保存可序列化状态；AudioContext、MediaStreamTrack、LiveKit Room 等重对象必须留在 features 中。
// 新组件优先读取这里，业务动作仍通过 app/runtime.js 调用。
export const appStore = reactive({
    app: {
        booted: false,
        stage: 'stage9-polished-framework',
    },
    connection: {
        serverIp: localStorage.getItem('lk_server_ip') || DEFAULT_SERVER_IP,
        username: localStorage.getItem('lk_username') || '',
        isInLobby: false,
        isConnected: false,
        currentChannel: null,
        channels: [],
    },
    media: {
        micOn: false,
        rustMicOn: false,
        micSource: localStorage.getItem('lk_mic_source') === 'browser' ? 'browser' : 'rust',
        micMonitorOn: false,
        screenOn: false,
        appAudioSharing: false,
        appAudioGain: Math.min(3, Math.max(0, Number(localStorage.getItem('lk_app_audio_gain') ?? 1) || 0)),
        micLevel: 0,
        micThreshold: Number(localStorage.getItem('lk_vad_threshold') ?? 20),
        micBoost: Number(localStorage.getItem('lk_mic_boost') ?? 5),
    },
    devices: {
        micOptions: [],
        audioOutputOptions: [{ id: 'default', label: '默认扬声器' }],
        audioOutputUnavailable: false,
        selectedRustMicId: localStorage.getItem('lk_rust_mic_device_id') || '',
        selectedBrowserMicId: localStorage.getItem('lk_mic') || '',
        selectedAudioOutputId: localStorage.getItem('lk_audio_output') || 'default',
    },
    ui: {
        appAudioModalOpen: false,
        switchingChannel: false,
        lastError: null,
        lastUpdatedAt: Date.now(),
    },
});

/** 按 section 合并更新 store，并刷新 lastUpdatedAt。 */
export function patchStore(section, values) {
    if (!appStore[section] || !values || typeof values !== 'object') return;
    Object.assign(appStore[section], values);
    appStore.ui.lastUpdatedAt = Date.now();
}

/** 标记 Vue 与 legacy DOM 初始化完成。 */
export function markAppBooted() {
    appStore.app.booted = true;
    appStore.ui.lastUpdatedAt = Date.now();
}

/** 记录最近一次非致命错误，供后续错误提示或调试面板使用。 */
export function setLastError(error) {
    appStore.ui.lastError = error ? String(error?.message || error) : null;
    appStore.ui.lastUpdatedAt = Date.now();
}

/** 从 runtime 快照同步状态；用于让新 Vue 组件读取旧业务链路的状态。 */
export function syncFromRuntimeSnapshot(snapshot = {}) {
    if ('serverIp' in snapshot || 'username' in snapshot || 'isConnected' in snapshot || 'currentChannel' in snapshot || 'channels' in snapshot || 'isInLobby' in snapshot) {
        patchStore('connection', {
            serverIp: snapshot.serverIp ?? appStore.connection.serverIp,
            username: snapshot.username ?? appStore.connection.username,
            isInLobby: snapshot.isInLobby ?? appStore.connection.isInLobby,
            isConnected: snapshot.isConnected ?? appStore.connection.isConnected,
            currentChannel: 'currentChannel' in snapshot ? snapshot.currentChannel : appStore.connection.currentChannel,
            channels: Array.isArray(snapshot.channels) ? snapshot.channels : appStore.connection.channels,
        });
    }

    if ('micOn' in snapshot || 'rustMicOn' in snapshot || 'micSource' in snapshot || 'micMonitorOn' in snapshot || 'screenOn' in snapshot || 'appAudioSharing' in snapshot) {
        patchStore('media', {
            micOn: snapshot.micOn ?? appStore.media.micOn,
            rustMicOn: snapshot.rustMicOn ?? appStore.media.rustMicOn,
            micSource: snapshot.micSource ?? appStore.media.micSource,
            micMonitorOn: snapshot.micMonitorOn ?? appStore.media.micMonitorOn,
            screenOn: snapshot.screenOn ?? appStore.media.screenOn,
            appAudioSharing: snapshot.appAudioSharing ?? appStore.media.appAudioSharing,
        });
    }

    if ('selectedAudioOutputId' in snapshot || 'selectedRustMicId' in snapshot || 'selectedBrowserMicId' in snapshot) {
        patchStore('devices', {
            selectedAudioOutputId: snapshot.selectedAudioOutputId ?? appStore.devices.selectedAudioOutputId,
            selectedRustMicId: snapshot.selectedRustMicId ?? appStore.devices.selectedRustMicId,
            selectedBrowserMicId: snapshot.selectedBrowserMicId ?? appStore.devices.selectedBrowserMicId,
        });
    }
}
