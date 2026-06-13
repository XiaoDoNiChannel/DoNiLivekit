import { logError } from '../shared/errors.js';

/**
 * 聊天模块。
 *
 * 这里仍然使用 LiveKit data channel，不引入 Vue state，保证和旧版逻辑兼容。
 */

export function createChatFeature(context) {
    async function sendChatMessage() {
        const room = context.getRoom();
        if (!room || !room.localParticipant) return;

        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;

        try {
            const data = JSON.stringify({ msg: text });
            await room.localParticipant.publishData(new TextEncoder().encode(data), { reliable: true });

            const myName = room.localParticipant.name || room.localParticipant.identity;
            renderChatMessage(myName, text, true);
            input.value = '';
        } catch (e) {
            logError('chat/sendChatMessage 发送消息失败', e);
        }
    }

    function renderChatMessage(sender, text, isSelf) {
        const messagesDiv = document.getElementById('chat-messages');
        if (!messagesDiv) return;

        const msgEl = document.createElement('div');
        msgEl.className = 'chat-message' + (isSelf ? ' self' : '');

        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

        msgEl.innerHTML = `
            <div class="chat-meta">${context.sanitizeText(sender)} ${timeStr}</div>
            <div class="chat-content">${context.sanitizeText(text)}</div>
        `;
        messagesDiv.appendChild(msgEl);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    return { sendChatMessage, renderChatMessage };
}
