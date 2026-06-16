import { reactive } from 'vue';

/**
 * Presence 状态。
 *
 * 只保存大厅在线状态和频道成员分布。
 * 不保存 AudioContext、MediaStreamTrack、LiveKit Room 等重对象。
 */
export const presenceStore = reactive({
    connected: false,
    identity: '',
    userId: '',
    connectionId: '',
    displayName: '',
    channels: [],
    participants: {},
    /** 当前正在说话的用户标识集合；{ [identity]: true } */
    speakingIdentities: {},
    lastMessageType: '',
    lastUpdatedAt: Date.now(),
});

/** 清空 Presence 状态，用于主动退出大厅或断开连接。 */
export function resetPresenceStore() {
    presenceStore.connected = false;
    presenceStore.identity = '';
    presenceStore.userId = '';
    presenceStore.connectionId = '';
    presenceStore.displayName = '';
    presenceStore.channels = [];
    presenceStore.participants = {};
    presenceStore.speakingIdentities = {};
    presenceStore.lastMessageType = '';
    presenceStore.lastUpdatedAt = Date.now();
}

/** 记录当前 WebSocket 连接身份。 */
export function setPresenceConnectionState({ connected, identity, userId, connectionId, displayName }) {
    presenceStore.connected = !!connected;
    if (identity !== undefined) presenceStore.identity = identity || '';
    if (userId !== undefined) presenceStore.userId = userId || '';
    if (connectionId !== undefined) presenceStore.connectionId = connectionId || '';
    if (displayName !== undefined) presenceStore.displayName = displayName || '';
    presenceStore.lastUpdatedAt = Date.now();
}

function cleanText(value) {
    return String(value || '').trim();
}

function makeIdentityKeys({ identity, userId, connectionId } = {}) {
    return new Set([identity, userId, connectionId].map(cleanText).filter(Boolean));
}

function memberMatches(member, { identity, userId, connectionId, displayName } = {}) {
    if (!member) return false;

    const strongKeys = makeIdentityKeys({ identity, userId, connectionId });
    const memberStrongKeys = makeIdentityKeys({
        identity: member.identity,
        userId: member.userId,
        connectionId: member.connectionId,
    });

    for (const key of strongKeys) {
        if (memberStrongKeys.has(key)) return true;
    }

    // 只有在没有 identity/userId/connectionId 这类强身份时，才退回 displayName。
    // 避免两个用户同名时互相误删。
    if (strongKeys.size === 0) {
        const name = cleanText(displayName);
        return !!name && cleanText(member.displayName) === name;
    }

    return false;
}

function getMessageTargetChannel(message = {}) {
    return cleanText(
        message.to ??
        message.channelId ??
        message.currentChannel ??
        message.room ??
        message.targetChannel ??
        ''
    );
}

/** 标准化成员对象，保证 Vue 渲染层字段稳定。 */
function normalizeMember(member) {
    if (!member) return null;

    if (typeof member === 'string') {
        const name = member.trim();
        if (!name) return null;
        return {
            identity: name,
            userId: name,
            connectionId: '',
            displayName: name,
            statusText: '在线',
        };
    }

    const identity = cleanText(member.identity || member.name || member.displayName);
    const userId = cleanText(member.userId || member.identity || member.name || member.displayName);
    const connectionId = cleanText(member.connectionId);
    const displayName = cleanText(member.displayName || member.name || member.identity);

    if (!identity && !displayName) return null;

    return {
        identity: identity || displayName,
        userId: userId || identity || displayName,
        connectionId,
        displayName: displayName || identity,
        avatarColor: member.avatarColor,
        avatarPreset: member.avatarPreset,
        avatarUrl: member.avatarUrl,
        statusText: member.statusText || '在线',
    };
}

/** 标准化频道对象，后续 Discord UI 可以继续扩展 type/category/icon 等字段。 */
function normalizeChannel(channel) {
    const id = cleanText(channel?.id || channel?.name);
    const name = cleanText(channel?.name || channel?.id);

    if (!id && !name) return null;

    const members = [];
    const rawMembers = Array.isArray(channel.members) ? channel.members : [];
    rawMembers.forEach((member) => {
        const normalized = normalizeMember(member);
        if (!normalized) return;
        const index = findMemberIndex(members, normalized);
        if (index >= 0) {
            members[index] = { ...members[index], ...normalized };
        } else {
            members.push(normalized);
        }
    });

    return {
        id: id || name,
        name: name || id,
        type: channel.type || 'voice',
        members,
    };
}

/** 查找频道索引，兼容 id/name 两种字段。 */
function findChannelIndex(channelId) {
    const cleanId = cleanText(channelId);
    if (!cleanId) return -1;

    return presenceStore.channels.findIndex((channel) => {
        return channel.id === cleanId || channel.name === cleanId;
    });
}

function findMemberIndex(members, memberLike) {
    return members.findIndex((member) => memberMatches(member, memberLike));
}

/** 确保频道存在；用于处理先收到 moved、后收到 snapshot 的极端顺序。 */
function ensureChannel(channelId) {
    const cleanId = cleanText(channelId);
    if (!cleanId) return null;

    let index = findChannelIndex(cleanId);

    if (index < 0) {
        presenceStore.channels.push({
            id: cleanId,
            name: cleanId,
            type: 'voice',
            members: [],
        });
        index = presenceStore.channels.length - 1;
    }

    return presenceStore.channels[index];
}

/** 从全部频道移除指定成员，避免切频道后同一个人残留在旧频道。 */
function removeMemberFromAllChannels(identity, displayName, userId = '', connectionId = '') {
    const matcher = { identity, userId, connectionId, displayName };

    presenceStore.channels.forEach((channel) => {
        channel.members = channel.members.filter((member) => !memberMatches(member, matcher));
    });
}

function upsertMemberToChannel(channelId, memberData) {
    const channel = ensureChannel(channelId);
    const member = normalizeMember(memberData);
    if (!channel || !member) return;

    const index = findMemberIndex(channel.members, member);
    if (index >= 0) {
        channel.members[index] = {
            ...channel.members[index],
            ...member,
        };
    } else {
        channel.members.push(member);
    }
}

function removeParticipantRecords({ identity, userId, connectionId, displayName } = {}) {
    const strongKeys = makeIdentityKeys({ identity, userId, connectionId });
    const fallbackName = cleanText(displayName);

    for (const key of Object.keys(presenceStore.participants)) {
        const participant = presenceStore.participants[key];
        if (strongKeys.has(cleanText(key)) || memberMatches(participant, { identity, userId, connectionId, displayName })) {
            delete presenceStore.participants[key];
        } else if (strongKeys.size === 0 && fallbackName && cleanText(participant?.displayName) === fallbackName) {
            delete presenceStore.participants[key];
        }
    }
}

function upsertParticipantRecord(memberData, currentChannel) {
    const member = normalizeMember(memberData);
    if (!member) return;

    const key = member.identity || member.userId || member.connectionId || member.displayName;
    presenceStore.participants[key] = {
        ...(presenceStore.participants[key] || {}),
        identity: member.identity,
        userId: member.userId,
        connectionId: member.connectionId,
        displayName: member.displayName,
        currentChannel: currentChannel || null,
        avatarColor: member.avatarColor,
        avatarPreset: member.avatarPreset,
        avatarUrl: member.avatarUrl,
        statusText: member.statusText || '在线',
    };
}

/** 应用后端推送的完整 Presence 快照。 */
export function applyPresenceSnapshot(message) {
    if (!message || message.type !== 'presence_snapshot') return;

    presenceStore.channels = Array.isArray(message.channels)
        ? message.channels.map(normalizeChannel).filter(Boolean)
        : [];

    presenceStore.participants = message.participants && typeof message.participants === 'object'
        ? message.participants
        : {};

    presenceStore.lastMessageType = message.type;
    presenceStore.lastUpdatedAt = Date.now();
}

/** 应用成员移动事件。 */
function applyParticipantMoved(message) {
    const identity = cleanText(message.identity);
    const userId = cleanText(message.userId);
    const connectionId = cleanText(message.connectionId);
    const displayName = cleanText(message.displayName || message.identity || message.userId);
    const targetChannel = getMessageTargetChannel(message);

    if (!identity && !displayName && !userId && !connectionId) return;

    removeMemberFromAllChannels(identity, displayName, userId, connectionId);

    const memberData = {
        identity: identity || userId || displayName,
        userId: userId || identity || displayName,
        connectionId,
        displayName: displayName || identity || userId,
        avatarColor: message.avatarColor,
        avatarPreset: message.avatarPreset,
        avatarUrl: message.avatarUrl,
        statusText: message.statusText || '在线',
    };

    if (targetChannel) {
        upsertMemberToChannel(targetChannel, memberData);
    }

    upsertParticipantRecord(memberData, targetChannel || null);
}

/** 应用用户离线事件。 */
function applyParticipantOffline(message) {
    const identity = cleanText(message.identity);
    const userId = cleanText(message.userId);
    const connectionId = cleanText(message.connectionId);
    const displayName = cleanText(message.displayName || message.identity || message.userId);

    removeMemberFromAllChannels(identity, displayName, userId, connectionId);
    removeParticipantRecords({ identity, userId, connectionId, displayName });
}

/** 应用用户进入大厅事件；未进入语音频道时不显示在频道下面。 */
function applyParticipantOnline(message) {
    const participant = message.participant || {};
    const identity = cleanText(participant.identity);
    const userId = cleanText(participant.userId);
    const connectionId = cleanText(participant.connectionId);
    const displayName = cleanText(participant.displayName || participant.identity || participant.userId);
    const currentChannel = cleanText(participant.currentChannel || participant.channelId);

    if (!identity && !displayName && !userId && !connectionId) return;

    const memberData = {
        identity: identity || userId || displayName,
        userId: userId || identity || displayName,
        connectionId,
        displayName: displayName || identity || userId,
        avatarColor: participant.avatarColor,
        avatarPreset: participant.avatarPreset,
        avatarUrl: participant.avatarUrl,
        statusText: participant.statusText || '在线',
    };

    upsertParticipantRecord(memberData, currentChannel || null);

    if (currentChannel) {
        removeMemberFromAllChannels(identity, displayName, userId, connectionId);
        upsertMemberToChannel(currentChannel, memberData);
    }
}

/** 应用用户资料更新（头像颜色、预设 emoji、头像 URL）。 */
function applyProfileUpdate(message) {
    const identity = cleanText(message.identity);
    const userId = cleanText(message.userId);
    const connectionId = cleanText(message.connectionId);
    const displayName = cleanText(message.displayName);

    const applyToMember = (member) => {
        if (!member) return;
        if (message.displayName) member.displayName = message.displayName;
        member.avatarColor = message.avatarColor;
        member.avatarPreset = message.avatarPreset;
        member.avatarUrl = message.avatarUrl;
        member.statusText = message.statusText || member.statusText || '在线';
    };

    for (const participant of Object.values(presenceStore.participants)) {
        if (memberMatches(participant, { identity, userId, connectionId, displayName })) {
            applyToMember(participant);
        }
    }

    for (const channel of presenceStore.channels) {
        for (const member of channel.members) {
            if (memberMatches(member, { identity, userId, connectionId, displayName })) {
                applyToMember(member);
            }
        }
    }
}

/** 统一处理 Presence 消息；ChannelList.vue 会自动响应 presenceStore 的变化。 */
export function applyPresenceMessage(message) {
    if (!message || !message.type) return;

    if (message.type === 'presence_snapshot') {
        applyPresenceSnapshot(message);
    } else if (message.type === 'participant_moved') {
        applyParticipantMoved(message);
    } else if (message.type === 'participant_offline') {
        applyParticipantOffline(message);
    } else if (message.type === 'participant_online') {
        applyParticipantOnline(message);
    } else if (message.type === 'update_profile') {
        applyProfileUpdate(message);
    } else if (message.type === 'profile_updated') {
        applyProfileUpdate(message);
    }

    presenceStore.lastMessageType = message.type;
    presenceStore.lastUpdatedAt = Date.now();
}

/**
 * 将 LiveKit active speaker 集合全量同步到 presence 响应式状态。
 * 由 runtime.js 桥接层调用，供 ChannelList.vue 等 Vue 组件响应说话高亮。
 *
 * @param {Set<string>} activeIdentities - 当前正在说话的用户 identity 集合
 */
export function syncSpeakingIdentities(activeIdentities) {
    const next = {};
    if (activeIdentities && activeIdentities.size > 0) {
        activeIdentities.forEach((id) => {
            if (id) next[id] = true;
        });
    }
    presenceStore.speakingIdentities = next;
}

/** 清空所有说话状态；用于离开房间/断开连接。 */
export function clearSpeakingIdentities() {
    presenceStore.speakingIdentities = {};
}
