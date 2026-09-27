/** Window controls shared by the settings page and the small status renderer. */
export function createOverlayClient({ store, invoke, listen, available, onPacket = () => {} }) {
    let disposed = false, started = false;
    const unlisteners = [];
    store.available = available;
    function applyStatus(status) {
        if (!disposed && status && status.version >= store.status.version) { store.status = status; store.ready = true; }
    }
    async function read() {
        if (!available || disposed) return;
        const result = await invoke('overlay_read');
        if (disposed) return;
        applyStatus(result.status); onPacket(result.packet);
    }
    async function start() {
        if (!available || disposed || started) return;
        started = true;
        try {
            for (const [name, callback] of [
                ['overlay-status', event => applyStatus(event.payload)],
                ['overlay-snapshot', event => { if (!disposed) onPacket(event.payload); }],
                ['overlay-error', event => { if (!disposed) store.error = String(event.payload); }],
            ]) {
                const unlisten = await listen(name, callback);
                if (disposed) { unlisten?.(); return; }
                unlisteners.push(unlisten);
            }
            await read();
        } catch (error) { store.error = String(error); }
    }
    async function run(command, args) {
        if (!available || store.busy || disposed) return false;
        store.busy = true; store.error = '';
        try { applyStatus(await invoke(command, args)); return true; }
        catch (error) { if (!disposed) store.error = String(error); return false; }
        finally { store.busy = false; }
    }
    return { start, read, applyStatus,
        control: action => run('overlay_control', { action }),
        preferences: values => run('overlay_preferences', values),
        dispose() { disposed = true; unlisteners.splice(0).forEach(fn => fn?.()); },
    };
}
