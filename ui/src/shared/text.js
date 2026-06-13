// Text escaping helpers for legacy DOM rendering.
// Vue templates escape text automatically, but several LiveKit callback paths still
// generate HTML strings manually for compatibility with the existing DOM ids.

export function sanitizeText(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
