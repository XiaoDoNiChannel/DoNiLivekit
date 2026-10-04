import { reactive } from 'vue';
import { themes, legacyThemeIds, normalizeThemeId, normalizeAppearance, THEME_STORAGE_KEY, APPEARANCE_STORAGE_KEY } from '../shared/themes.js';
export { themes };

function readPreference(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function readAppearance() {
  try { return normalizeAppearance(JSON.parse(readPreference(APPEARANCE_STORAGE_KEY))); }
  catch { return normalizeAppearance(); }
}
export const themeStore = reactive({ activeTheme: normalizeThemeId(readPreference(THEME_STORAGE_KEY)), ...readAppearance(), storageError: '' });

function savePreference(key, value) {
  try { localStorage.setItem(key, value); themeStore.storageError = ''; }
  catch { themeStore.storageError = '当前外观已生效，但无法保存到本机。'; }
}
export function applyThemeToDocument(themeId = themeStore.activeTheme) {
  themeStore.activeTheme = normalizeThemeId(themeId);
  const root = document.documentElement;
  [...themes.map(theme => theme.id), ...Object.keys(legacyThemeIds)].forEach(id => root.classList.remove(`theme-${id}`));
  root.classList.add(`theme-${themeStore.activeTheme}`);
  root.dataset.theme = themeStore.activeTheme;
  root.style.colorScheme = getActiveTheme().colorScheme;
  root.dataset.density = themeStore.density;
  root.style.setProperty('--dc-glass-opacity', `${themeStore.glassOpacity}%`);
}
export function setTheme(themeId) {
  applyThemeToDocument(themeId);
  savePreference(THEME_STORAGE_KEY, themeStore.activeTheme);
}
export function setAppearance(values) {
  const next = normalizeAppearance({ ...themeStore, ...values });
  Object.assign(themeStore, next);
  applyThemeToDocument();
  savePreference(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
}
export function getActiveTheme() {
  return themes.find(theme => theme.id === themeStore.activeTheme) || themes[1];
}
applyThemeToDocument();
