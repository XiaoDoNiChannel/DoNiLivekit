import { createApp, watch } from 'vue';
import App from './App.vue';
import './assets/tailwind.css';
import './assets/index.css';
import './assets/diagnostics.css';
import './assets/overlayTokens.css';
import './assets/overlaySettings.css';
import './assets/workspace.css';
import './assets/parties.css';
import './assets/themes.css';
import './assets/appearance.css';
import { getActiveTheme } from './stores/themeStore.js';
import { setNativeWindowTheme } from './shared/tauri.js';
import { createWindowAppearance } from './features/windowAppearance.js';

const updateNativeTheme = createWindowAppearance(setNativeWindowTheme);
const stopAppearanceWatch = watch(() => getActiveTheme().colorScheme, theme => {
  void updateNativeTheme(theme).catch(error => console.warn('[appearance] 标题栏主题同步失败', error));
}, { immediate: true });
if (import.meta.hot) import.meta.hot.dispose(stopAppearanceWatch);

createApp(App).mount('#app');
