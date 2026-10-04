export const WINDOW_CLOSE_PREFERENCE_KEY = 'donichannel_window_close_action_v1';
const closeActions = ['minimize', 'exit'];

export function createWindowCloseFeature({ state, enabled, onCloseRequested, minimize, exit, storage }) {
    let stopListening;
    let generation = 0;

    state.preference = 'ask';
    state.remember = false;
    state.preferenceError = '';
    try {
        const saved = storage?.getItem(WINDOW_CLOSE_PREFERENCE_KEY);
        if (closeActions.includes(saved)) state.preference = saved;
    } catch (error) {
        state.preferenceError = '无法读取关闭偏好，将在关闭时询问。';
    }

    function setPreference(action) {
        if (state.busy || !['ask', ...closeActions].includes(action)) return false;
        try {
            storage.setItem(WINDOW_CLOSE_PREFERENCE_KEY, action);
            state.preference = action;
            state.preferenceError = '';
            return true;
        } catch (error) {
            state.preferenceError = '关闭偏好保存失败，请重试。';
            return false;
        }
    }

    async function start() {
        if (!enabled) return;
        const current = ++generation;
        stopListening?.();
        stopListening = undefined;
        try {
            const unlisten = await onCloseRequested(event => {
                event.preventDefault();
                if (current !== generation || state.open || state.busy) return;
                state.error = '';
                state.remember = false;
                if (closeActions.includes(state.preference)) return perform(state.preference);
                state.open = true;
            });
            if (current !== generation) unlisten();
            else stopListening = unlisten;
        } catch (error) {
            console.error('[window-close] 无法监听窗口关闭事件', error);
        }
    }

    function cancel() {
        if (!state.busy) {
            state.open = false;
            state.remember = false;
        }
    }

    async function choose(action) {
        if (!state.open || state.busy || !closeActions.includes(action)) return;
        // Persist before exiting: the window may be destroyed before the native
        // promise resolves. Cancel never writes the pending checkbox choice.
        if (state.remember && !setPreference(action)) {
            state.error = state.preferenceError;
            return;
        }
        await perform(action);
    }

    async function perform(action) {
        state.busy = true;
        state.error = '';
        try {
            await (action === 'minimize' ? minimize() : exit());
            state.open = false;
        } catch (error) {
            state.open = true;
            state.error = `${action === 'minimize' ? '最小化' : '退出'}失败，请重试：${error?.message || error}`;
        } finally {
            state.busy = false;
        }
    }

    function dispose() {
        generation++;
        stopListening?.();
        stopListening = undefined;
    }

    return { start, cancel, choose, setPreference, dispose };
}
