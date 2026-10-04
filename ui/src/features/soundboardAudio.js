export const MAX_SOUND_BYTES = 5 * 1024 * 1024;
export const MAX_SOUND_SECONDS = 30;
export function percent(value, fallback = 60) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
}

// Attenuation only: cap sample peaks at -6 dBFS and whole-clip RMS at -20 dBFS.
// User gains are applied afterwards and never exceed unity.
export function analyzeSound(buffer) {
    if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new Error('仅支持单声道或立体声音频');
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > MAX_SOUND_SECONDS) {
        throw new Error('请选择 30 秒以内的短音频');
    }
    let peak = 0, sum = 0, count = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (const sample of data) {
            if (!Number.isFinite(sample)) throw new Error('音频数据损坏');
            peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; count++;
        }
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    return { peak, rms, attenuation: Math.min(1, peak ? 0.5 / peak : 1, rms ? 0.1 / rms : 1), duration: buffer.duration };
}

export function shortcutFromEvent(event) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return '';
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F([1-9]|1\d|2[0-4])$/.test(event.code)) return '';
    if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1\d|2[0-4])|Numpad[0-9]|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/.test(event.code)) return '';
    return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', event.code].filter(Boolean).join('+');
}

export function readSoundboardSettings(storage) {
    try {
        const data = JSON.parse(storage.getItem('lk_soundboard_v1') || '{}');
        return { volume: percent(data.volume ?? 60), receiveVolume: percent(data.receiveVolume ?? 80, 80),
            receive: data.receive !== false, monitor: data.monitor === true,
            clips: data.clips && typeof data.clips === 'object' && !Array.isArray(data.clips) ? data.clips : {},
            blocked: Array.isArray(data.blocked) ? data.blocked.filter(x => typeof x === 'string') : [],
            stopShortcut: typeof data.stopShortcut === 'string' ? data.stopShortcut : 'Ctrl+Alt+Backspace' };
    } catch { return { volume: 60, receiveVolume: 80, receive: true, monitor: false, clips: {}, blocked: [], stopShortcut: 'Ctrl+Alt+Backspace' }; }
}
