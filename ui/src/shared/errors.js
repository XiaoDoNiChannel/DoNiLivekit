// Centralized error formatting utilities.
//
// Keep user-facing messages readable while preserving the original error object
// in console output for debugging. Feature modules should prefer these helpers
// instead of building ad-hoc `error?.message || error` strings everywhere.

export function getErrorMessage(error, fallback = '未知错误') {
    if (!error) return fallback;

    if (typeof error === 'string') return error;

    if (error instanceof Error) {
        return error.message || fallback;
    }

    if (typeof error === 'object') {
        if (typeof error.message === 'string' && error.message.trim()) {
            return error.message;
        }

        try {
            return JSON.stringify(error);
        } catch (_) {
            return fallback;
        }
    }

    return String(error);
}

export function formatError(scope, error, fallback = '未知错误') {
    return `${scope}: ${getErrorMessage(error, fallback)}`;
}

export function logError(scope, error, level = 'error') {
    const message = formatError(scope, error);
    const logger = console[level] || console.error;
    logger(message, error);
    return message;
}

export function alertError(scope, error, fallback = '操作失败，请稍后重试。') {
    alert(`${scope}：${getErrorMessage(error, fallback)}`);
}
