export function normalizeServerBaseUrl(rawValue) {
    const value = String(rawValue || '').trim().replace(/\/+$/, '');
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (/^wss?:\/\//i.test(value)) {
        return value.replace(/^ws/i, 'http');
    }
    return `http://${value}`;
}

export function createAutoUpdateFeature({
    invoke,
    isTauriClient,
    patchState,
    logger = console,
}) {
    let serverBaseUrl = null;
    let checkInFlight = null;
    let installInFlight = null;

    async function checkSilently(rawServerAddress) {
        serverBaseUrl = normalizeServerBaseUrl(rawServerAddress);
        if (!isTauriClient || !serverBaseUrl) {
            patchState({ status: 'skipped', error: null });
            return { skipped: true };
        }

        if (checkInFlight) return checkInFlight;

        checkInFlight = (async () => {
            patchState({ status: 'checking', error: null });
            try {
                const result = await invoke('check_for_update', {
                    serverBaseUrl,
                });
                patchState({
                    status: result?.available ? 'available' : 'up-to-date',
                    available: !!result?.available,
                    version: result?.version || null,
                    currentVersion: result?.currentVersion || null,
                    notes: result?.notes || null,
                    pubDate: result?.pubDate || null,
                    lastCheckedAt: Date.now(),
                    downloadedBytes: 0,
                    totalBytes: null,
                    progressPercent: null,
                    error: null,
                });
                return result;
            } catch (error) {
                const message = String(error?.message || error);
                patchState({
                    status: 'unavailable',
                    available: false,
                    lastCheckedAt: Date.now(),
                    error: message,
                });
                logger.debug?.('[autoUpdate/check] update service unavailable', { error: message });
                return { available: false, error: message };
            } finally {
                checkInFlight = null;
            }
        })();

        return checkInFlight;
    }

    async function installAvailable() {
        if (!isTauriClient || !serverBaseUrl) return false;
        if (installInFlight) return installInFlight;

        installInFlight = (async () => {
            patchState({
                status: 'downloading',
                error: null,
                downloadedBytes: 0,
                totalBytes: null,
                progressPercent: 0,
            });
            try {
                const installed = await invoke('install_update', { serverBaseUrl });
                patchState({
                    status: installed ? 'installed' : 'up-to-date',
                    available: false,
                    progressPercent: installed ? 100 : null,
                });
                return !!installed;
            } catch (error) {
                const message = String(error?.message || error);
                patchState({ status: 'install-failed', error: message });
                throw error;
            } finally {
                installInFlight = null;
            }
        })();

        return installInFlight;
    }

    async function attachProgressListener(subscribe) {
        if (!isTauriClient || typeof subscribe !== 'function') return () => {};
        return subscribe('update-download-progress', (event) => {
            const payload = event?.payload || {};
            patchState({
                status: payload.phase === 'installing' ? 'installing' : 'downloading',
                downloadedBytes: Number(payload.downloadedBytes || 0),
                totalBytes: payload.totalBytes != null && Number.isFinite(Number(payload.totalBytes))
                    ? Number(payload.totalBytes)
                    : null,
                progressPercent: payload.progressPercent != null && Number.isFinite(Number(payload.progressPercent))
                    ? Math.max(0, Math.min(100, Number(payload.progressPercent)))
                    : null,
            });
        });
    }

    return { checkSilently, installAvailable, attachProgressListener };
}
