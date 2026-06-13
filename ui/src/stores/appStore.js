import { reactive } from 'vue';
import { DEFAULT_SERVER_IP } from '../shared/constants.js';

/**
 * Central frontend state model.
 *
 * 这个 store 是后续继续加功能的“状态层入口”。当前项目仍保留部分 legacy DOM 渲染，
 * 但新功能应优先读写这里，而不是继续散落在 client.js 或组件内部。
 *
 * 约定：
 * - store 只保存可序列化/轻量状态，不保存 AudioContext、MediaStreamTrack、LiveKit Room 等重对象；
 * - 重对象仍由 features/ 中的 service 模块持有；
 * - 组件只根据 store 显示 UI，业务动作通过 app/runtime.js 暴露的 actions 调用。
 */
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
        micSource: 'rust',
        micMonitorOn: false,
        screenOn: false,
        appAudioSharing: false,
    },
    devices: {
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

export function patchStore(section, values) {
    if (!appStore[section] || !values || typeof values !== 'object') return;
    Object.assign(appStore[section], values);
    appStore.ui.lastUpdatedAt = Date.now();
}

export function markAppBooted() {
    appStore.app.booted = true;
    appStore.ui.lastUpdatedAt = Date.now();
}

export function setLastError(error) {
    appStore.ui.lastError = error ? String(error?.message || error) : null;
    appStore.ui.lastUpdatedAt = Date.now();
}

/**
 * 从现有 legacy/runtime 快照同步状态。
 *
 * 这是安全迁移阶段的桥：老业务链路继续稳定运行，新 Vue 组件和后续功能可以从 store 读取状态。
 */
export function syncFromRuntimeSnapshot(snapshot = {}) {
    if ('serverIp' in snapshot || 'username' in snapshot || 'isConnected' in snapshot || 'currentChannel' in snapshot || 'channels' in snapshot || 'isInLobby' in snapshot) {
        patchStore('connection', {
            serverIp: snapshot.serverIp ?? appStore.connection.serverIp,
            username: snapshot.username ?? appStore.connection.username,
            isInLobby: snapshot.isInLobby ?? appStore.connection.isInLobby,
            isConnected: snapshot.isConnected ?? appStore.connection.isConnected,
            currentChannel: snapshot.currentChannel ?? appStore.connection.currentChannel,
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
