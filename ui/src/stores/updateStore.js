import { reactive } from 'vue';

export function createUpdateState() {
    return {
        status: 'idle',
        available: false,
        version: null,
        currentVersion: null,
        notes: null,
        pubDate: null,
        lastCheckedAt: null,
        downloadedBytes: 0,
        totalBytes: null,
        progressPercent: null,
        error: null,
    };
}

export const updateStore = reactive(createUpdateState());

export function patchUpdateState(values = {}) {
    Object.assign(updateStore, values);
}

export function resetUpdateState() {
    Object.assign(updateStore, createUpdateState());
}
