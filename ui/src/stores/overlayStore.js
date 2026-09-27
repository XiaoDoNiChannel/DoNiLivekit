import { reactive } from 'vue';

export const defaultOverlayStatus = () => ({
    version: -1, visible: false, interactive: true, shortcutsReady: false, shortcutError: '',
    preferences: { opacity: .7, toggleShortcut: 'Ctrl+Alt+Shift+O', editShortcut: 'Ctrl+Alt+O', width: 320, height: 164 },
});
export function createOverlayStore() { return reactive({ status: defaultOverlayStatus(), available: false, ready: false, busy: false, error: '' }); }
export const overlayStore = createOverlayStore();
