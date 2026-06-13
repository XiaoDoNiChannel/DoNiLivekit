// Tauri API compatibility wrapper.
//
// Tauri v2 exposes `window.__TAURI__.core.invoke`; some older examples use
// `window.__TAURI__.tauri.invoke`. This wrapper keeps feature modules independent
// from the exact runtime shape and provides a clear error outside Tauri.

export const invoke = window.__TAURI__?.core?.invoke
    ? (...args) => window.__TAURI__.core.invoke(...args)
    : window.__TAURI__?.tauri?.invoke
        ? (...args) => window.__TAURI__.tauri.invoke(...args)
        : async () => {
            throw new Error('Tauri invoke 不可用：请确认当前页面运行在 Tauri 窗口内，而不是普通浏览器标签页。');
        };

export const listen = window.__TAURI__?.event?.listen
    ? (...args) => window.__TAURI__.event.listen(...args)
    : (..._args) => {
        console.warn('[tauri] Tauri event listen 不可用，Rust 事件将不会被接收。');
    };

export const isTauriClient = !!window.__TAURI__;
