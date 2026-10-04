export const THEME_STORAGE_KEY = 'donichannel_theme_v1';
export const APPEARANCE_STORAGE_KEY = 'donichannel_appearance_v1';
export const themes = [
  { id: 'graphite', name: '石墨', desc: '中性深灰 · 淡紫点缀', accent: '#b8aff0', colorScheme: 'dark', material: '实色' },
  { id: 'smoke-glass', name: '烟玻璃', desc: '冷灰磨砂 · 柔和透光', accent: '#a9c6fa', colorScheme: 'dark', material: '磨砂' },
  { id: 'midnight-blue', name: '午夜蓝', desc: '深海军蓝 · 冰蓝点缀', accent: '#8fc9fb', colorScheme: 'dark', material: '实色' },
  { id: 'silver', name: '银灰', desc: '浅灰背景 · 清晰明亮', accent: '#405db3', colorScheme: 'light', material: '实色' },
];
export const legacyThemeIds = { 'doni-dark': 'graphite', 'midnight-purple': 'midnight-blue', 'glass-dark': 'smoke-glass', 'soft-graphite': 'graphite' };
export function normalizeThemeId(id) {
  const next = legacyThemeIds[id] || id;
  return themes.some(theme => theme.id === next) ? next : 'smoke-glass';
}
export function normalizeAppearance(value) {
  const opacity = Number(value?.glassOpacity);
  return { glassOpacity: Number.isFinite(opacity) ? Math.max(65, Math.min(100, opacity)) : 82, density: value?.density === 'compact' ? 'compact' : 'comfortable' };
}
