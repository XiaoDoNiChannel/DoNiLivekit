// Application-wide constants.
// Keep values here only when more than one feature module depends on them.

export const DEFAULT_SERVER_IP = '10.126.126.10:5000';

// Click “进入大厅” and automatically join the first available voice channel.
export const AUTO_JOIN_FIRST_CHANNEL_AFTER_LOBBY = true;

// localStorage key for per-participant volume preferences.
export const USER_VOLUME_STORAGE_KEY = 'lk_user_volumes_v1';

// LiveKit active speaker tuning.
export const ACTIVE_SPEAKER_LEVEL_THRESHOLD = 0.05;
export const ACTIVE_SPEAKER_DEBOUNCE_MS = 100;
