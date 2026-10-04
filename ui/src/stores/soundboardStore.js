import { reactive } from 'vue';
import { readSoundboardSettings } from '../features/soundboardAudio.js';
export const soundboardStore = reactive({
    ...readSoundboardSettings(localStorage), open: false, ready: false, busy: false,
    items: [], playing: '', mode: '', error: '', recording: '', preparing: false,
    shortcutErrors: {}, peers: [], sendReady: false,
});
