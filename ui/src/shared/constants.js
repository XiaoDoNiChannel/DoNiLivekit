// 多个 feature 同时依赖的全局常量集中放在这里。
// 只被单个模块使用的配置，应优先留在对应模块内部。

// 默认后端地址：token/API 服务端口。LiveKit WebSocket 端口在 roomConnection.js 中拼接为 7880。
export const DEFAULT_SERVER_IP = '127.0.0.1:5000';

// 进入大厅后是否自动加入第一个语音频道。
export const AUTO_JOIN_FIRST_CHANNEL_AFTER_LOBBY = true;

// localStorage 中保存“远端成员音量百分比”的键名。
export const USER_VOLUME_STORAGE_KEY = 'lk_user_volumes_v1';

// LiveKit active speaker 高亮阈值和关闭防抖时间。
export const ACTIVE_SPEAKER_LEVEL_THRESHOLD = 0.05;
export const ACTIVE_SPEAKER_DEBOUNCE_MS = 100;
