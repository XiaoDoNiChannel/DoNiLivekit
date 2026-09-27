import { alertError, getErrorMessage, logError } from '../shared/errors.js';
import { appStore } from '../stores/appStore.js';

/**
 * 返回适合显示的麦克风名称。
 * 只有在 Rust 返回值看起来像 Windows Endpoint ID 时，才回退成“麦克风 N”。
 */
export function getCleanMicDeviceLabel(device, index) {
    const rawName = String(device?.name || '').trim();

    // Windows Endpoint ID 会长得像 {0.0.1.00000000}.{...}，不适合直接显示给用户。
    // 但真实设备名可能较长，例如“默认值 - 麦克风 (HECATE G4 Pro) (35bb:a164)”，不能因为长就替换成“麦克风 1”。
    const looksLikeEndpointId =
        rawName.includes('{0.0.') ||
        rawName.includes('\\?') ||
        /^麦克风\s*\{0\.0\./i.test(rawName);

    if (rawName && !looksLikeEndpointId) return rawName;
    return `麦克风 ${index + 1}`;
}

/** 刷新输入设备列表；Rust 模式走 WASAPI 枚举，浏览器 AEC 模式走 LiveKit 枚举。 */
export async function updateMicList({ isTauriClient, useRustMic = isTauriClient, invoke, LivekitClient }) {
    const selectEl = document.getElementById('mic-select');
    if (!selectEl) return;

    try {
        selectEl.disabled = false;
        selectEl.innerHTML = '';

        if (isTauriClient && useRustMic) {
            const devices = await invoke('list_capture_devices');
            const rows = Array.isArray(devices) ? devices : [];

            if (rows.length === 0) {
                const option = document.createElement('option');
                option.value = '';
                option.text = '未枚举到输入设备，使用系统默认麦克风';
                selectEl.appendChild(option);
            } else {
                rows.forEach((device, index) => {
                    const option = document.createElement('option');
                    option.value = device.id || '';
                    option.text = getCleanMicDeviceLabel(device, index);
                    option.title = device.name || device.id || option.text;
                    selectEl.appendChild(option);
                });
            }

            const savedMic = localStorage.getItem('lk_rust_mic_device_id') || '';
            const hasSaved = Array.from(selectEl.options).some(opt => opt.value === savedMic);
            selectEl.value = hasSaved ? savedMic : '';

            // 关键：开麦前先把选择同步给 Rust。否则 Rust 仍会录系统默认麦克风。
            await invoke('set_rust_mic_device_id', { deviceId: selectEl.value }).catch((error) => {
                logError('devices/updateMicList 同步 Rust 麦克风设备失败', error, 'warn');
            });
            return;
        }

        const devices = await LivekitClient.Room.getLocalDevices('audioinput');
        if (devices.length === 0) {
            selectEl.innerHTML = '<option value="">未找到麦克风</option>';
            return;
        }

        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `未知设备 (${device.deviceId.substring(0, 5)}...)`;
            selectEl.appendChild(option);
        });

        const savedMic = localStorage.getItem('lk_mic');
        if (savedMic && devices.some(d => d.deviceId === savedMic)) {
            selectEl.value = savedMic;
        }
    } catch (e) {
        logError('devices/updateMicList 获取麦克风列表失败', e);
        selectEl.innerHTML = `<option value="">麦克风列表获取失败：${getErrorMessage(e)}</option>`;
    } finally {
        appStore.devices.micOptions = Array.from(selectEl.options).map(option => ({ id: option.value, label: option.text }));
    }
}

/** 切换输入设备；Rust 麦克风开启时必须重启采集和重新发布 track。 */
export async function switchMic(deviceId, context) {
    const {
        isTauriClient,
        useRustMic = isTauriClient,
        invoke,
        getRoom,
        isMicActive,
        isRustMicActive,
        hasLocalRustMicPublication,
        stopRustMicShare,
        startRustMicShare,
        afterRustMicRestart,
    } = context;

    if (isTauriClient && useRustMic) {
        const normalized = deviceId || '';
        localStorage.setItem('lk_rust_mic_device_id', normalized);

        try {
            await invoke('set_rust_mic_device_id', { deviceId: normalized });

            const room = getRoom?.();
            const shouldRestart = !!(
                room &&
                room.localParticipant &&
                (isMicActive?.() || isRustMicActive?.() || hasLocalRustMicPublication?.())
            );

            // 如果当前已经开着 Rust 麦克风，切换设备必须重启采集线程和重新 publish。
            if (shouldRestart) {
                await stopRustMicShare();
                await startRustMicShare();
                afterRustMicRestart?.();
            }
        } catch (e) {
            logError('devices/switchMic 切换 Rust 麦克风失败', e);
            alertError('切换麦克风失败', e, '设备可能被其他程序独占，或 Rust 麦克风采集线程重启失败。');
        }

        return;
    }

    const room = getRoom?.();
    if (!room) return;
    localStorage.setItem('lk_mic', deviceId);
    try {
        await room.switchActiveDevice('audioinput', deviceId);
    } catch (e) {
        logError('devices/switchMic 切换浏览器麦克风失败', e);
        alertError('切换麦克风失败', e, '设备可能被独占、拔出，或浏览器没有麦克风权限。');
    }
}

/** 尝试请求一次浏览器音频权限，用于解锁设备真实名称。 */
async function requestAudioDeviceLabelPermission() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach((track) => track.stop());
    } catch (_) {
        // 用户拒绝或 WebView 不支持时，仍然允许后续 enumerateDevices 返回默认设备。
    }
}

/** 去重并清理音频输出设备。 */
function normalizeAudioOutputs(devices) {
    const seen = new Set();
    const rows = [];

    (Array.isArray(devices) ? devices : []).forEach((device) => {
        if (!device || device.kind !== 'audiooutput') return;
        const id = device.deviceId || '';
        if (!id || seen.has(id)) return;
        seen.add(id);
        rows.push(device);
    });

    return rows;
}

/** 刷新输出设备列表，并选中上次保存的扬声器。 */
export async function updateAudioOutputList({ selectedAudioOutputId, LivekitClient }) {
    const selectEl = document.getElementById('audio-output-select');
    if (!selectEl) return;

    function syncOutputOptions() {
        appStore.devices.audioOutputOptions = Array.from(selectEl.options).map(option => ({ id: option.value, label: option.text }));
        appStore.devices.audioOutputUnavailable = selectEl.disabled;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
        selectEl.innerHTML = '<option value="default">当前 WebView 不支持输出设备切换</option>';
        selectEl.disabled = true;
        syncOutputOptions();
        return;
    }

    try {
        selectEl.disabled = false;

        let outputs = [];

        // LiveKit 会在部分 WebView 中更稳定地触发设备枚举权限流程。
        if (LivekitClient?.Room?.getLocalDevices) {
            try {
                outputs = normalizeAudioOutputs(
                    await LivekitClient.Room.getLocalDevices('audiooutput', true)
                );
            } catch (error) {
                logError('devices/updateAudioOutputList LiveKit 输出设备枚举失败，回退到 enumerateDevices', error, 'warn');
            }
        }

        // 如果只拿到空标签/极少设备，主动请求一次音频权限后重新枚举。
        if (outputs.length <= 1 || outputs.every((device) => !device.label)) {
            await requestAudioDeviceLabelPermission();
            outputs = normalizeAudioOutputs(await navigator.mediaDevices.enumerateDevices());
        }

        selectEl.innerHTML = '';

        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.text = '默认扬声器';
        selectEl.appendChild(defaultOption);

        outputs.forEach((device) => {
            if (device.deviceId === 'default') return;
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `音频输出设备 (${device.deviceId.slice(0, 6)}...)`;
            option.title = device.label || device.deviceId;
            selectEl.appendChild(option);
        });

        const hasSaved = Array.from(selectEl.options).some(opt => opt.value === selectedAudioOutputId);
        selectEl.value = hasSaved ? selectedAudioOutputId : 'default';
    } catch (e) {
        logError('devices/updateAudioOutputList 枚举音频输出设备失败', e, 'warn');
        selectEl.innerHTML = '<option value="default">输出设备不可用</option>';
        selectEl.disabled = true;
    } finally {
        syncOutputOptions();
    }
}

/** 切换输出设备；同时作用于远端音频 AudioContext、Rust 麦克风耳返和 audio 元素。 */
export async function switchAudioOutput(deviceId, context) {
    const selectedAudioOutputId = deviceId || 'default';
    localStorage.setItem('lk_audio_output', selectedAudioOutputId);

    // setSinkId('default') 在部分 WebView 中会报 NotFoundError。
    // 使用空字符串表示回到系统默认设备。
    const sinkId = selectedAudioOutputId === 'default' ? '' : selectedAudioOutputId;

    async function applySinkId(target, label) {
        if (!target || typeof target.setSinkId !== 'function') return;

        try {
            await target.setSinkId(sinkId);
        } catch (e) {
            logError(`devices/switchAudioOutput 切换${label}输出设备失败`, e, 'warn');
        }
    }

    await applySinkId(context.getRemoteAudioContext?.(), '远端 AudioContext');
    await applySinkId(context.getLocalRustMicAudioContext?.(), 'Rust 麦克风耳返');

    const audioEls = document.querySelectorAll('#audio-container audio');
    for (const audioEl of audioEls) {
        await applySinkId(audioEl, 'audio 元素');
    }

    return selectedAudioOutputId;
}
