import { reactive } from 'vue';

export function createDiagnosticsState() {
    return {
        connection: 'disconnected', channel: '', updatedAt: null,
        voice: null, sharedAudio: null, screens: [], rttMs: null,
        history: [], events: [], issues: [], target: null,
        availability: 'idle', partial: false,
    };
}

// Only serializable diagnostics; RTC reports and track objects stay in the feature.
export const diagnosticsStore = reactive(createDiagnosticsState());

export function getDiagnosticSummary(state) {
    if (state.connection === 'reconnecting') return { text: '正在重连', tone: 'warning' };
    if (state.connection !== 'connected') return { text: '未连接', tone: 'muted' };
    if (state.issues.length) return { text: state.issues[0].title, tone: 'warning' };
    if (state.availability === 'unavailable') return { text: '统计暂不可用', tone: 'muted' };
    if (state.partial) return { text: '部分统计缺失', tone: 'muted' };
    if (!Number.isFinite(state.rttMs)) return { text: '通话诊断', tone: 'muted' };
    return { text: `链路 ${Math.round(state.rttMs)} ms`, tone: 'good' };
}
