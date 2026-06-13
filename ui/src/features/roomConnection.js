import { alertError, logError } from '../shared/errors.js';

/**
 * Room and channel connection module.
 *
 * 负责大厅/频道这一层状态：
 * - 服务器地址解析；
 * - 频道列表渲染、刷新和轮询；
 * - 创建频道；
 * - 进入大厅、连接 LiveKit 频道；
 * - 切频道时按原顺序停止本地资源、disconnect、connect、恢复麦克风；
 * - 离开房间时释放关键资源。
 *
 * 这里不直接实现 Rust 麦克风底层管线，也不直接实现 LiveKit RoomEvent 处理。
 * 这些分别交给 rustMic.js、audioPipelines.js、livekitEvents.js。
 */

export function createRoomConnectionFeature(context) {
    let currentChannel = null;
    let isInLobby = false;
    let channels = ['day0', 'day1', 'day2'];
    const channelParticipants = {};
    let roomPollTimer = null;
    let isPolling = false;
    let shouldRestoreMicAfterChannelSwitch = false;
    let isSwitchingChannel = false;

    function normalizeServerInput(rawValue) {
        let val = (rawValue || '').trim();
        if (!val) return context.defaultServerIp;
        val = val.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '');
        val = val.replace(/\/$/, '');
        return val;
    }

    function getServerConfig() {
        const inputEl = document.getElementById('server-ip');
        const normalized = normalizeServerInput(inputEl ? inputEl.value : '');

        let host = normalized;
        let apiPort = '5000';

        if (normalized.includes(':')) {
            const parts = normalized.split(':');
            host = parts[0];
            apiPort = parts[1] || '5000';
        }

        const apiBase = `http://${host}:${apiPort}`;
        const livekitWs = `ws://${host}:7880`;
        return { apiBase, livekitWs, persistValue: `${host}:${apiPort}` };
    }

    function renderChannelList() {
        const list = document.getElementById('channel-list');
        if (!list) return;

        list.innerHTML = channels.map(name => {
            const active = currentChannel === name ? 'active' : '';
            const escapedName = name.replace(/'/g, "\\'");
            const participants = Array.isArray(channelParticipants[name]) ? channelParticipants[name] : [];
            const participantsHTML = participants.length > 0
                ? participants.map(p => context.sanitizeText(p)).join('、')
                : '暂无在线成员';
            const participantsClass = participants.length > 0 ? 'channel-participants' : 'channel-participants empty';
            return `
                <div class="channel-row">
                    <button class="channel-item ${active}" onclick="switchChannel('${escapedName}')"># ${context.sanitizeText(name)}</button>
                    <div class="${participantsClass}">${participantsHTML}</div>
                </div>
            `;
        }).join('');
    }

    async function refreshRoomsFromServer() {
        const serverConfig = getServerConfig();
        const response = await fetch(`${serverConfig.apiBase}/api/rooms`);
        if (!response.ok) throw new Error(`房间列表接口返回异常：HTTP ${response.status}`);
        const rows = await response.json();
        if (!Array.isArray(rows)) return;

        const nextChannels = [];
        const nextParticipants = {};
        rows.forEach((row) => {
            const roomName = (row && row.name ? String(row.name) : '').trim();
            if (!roomName) return;
            nextChannels.push(roomName);
            nextParticipants[roomName] = Array.isArray(row.participants) ? row.participants : [];
        });

        if (nextChannels.length > 0) channels = nextChannels;

        Object.keys(channelParticipants).forEach((key) => delete channelParticipants[key]);
        Object.keys(nextParticipants).forEach((key) => {
            channelParticipants[key] = nextParticipants[key];
        });

        renderChannelList();
    }

    async function pollRooms() {
        if (!isInLobby || !isPolling) return;

        try {
            await refreshRoomsFromServer();
        } catch (err) {
            logError('roomConnection/pollRooms 房间轮询失败，将在下一轮重试', err, 'warn');
        } finally {
            if (isPolling) {
                roomPollTimer = setTimeout(pollRooms, 3000);
            }
        }
    }

    function startRoomPolling() {
        if (isPolling) return;
        isPolling = true;
        pollRooms();
    }

    function stopRoomPolling() {
        isPolling = false;
        if (roomPollTimer) {
            clearTimeout(roomPollTimer);
            roomPollTimer = null;
        }
    }

    async function createChannel() {
        const value = prompt('输入新频道名（英文字母/数字/短横线）:');
        if (!value) return;
        const name = value.trim();
        if (!name) return;

        const serverConfig = getServerConfig();
        const action = {
            action: 'create_channel',
            name,
        };
        try {
            const response = await fetch(`${serverConfig.apiBase}/api/rooms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(action),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `创建频道接口返回异常：HTTP ${response.status}`);
            }
            await refreshRoomsFromServer();
            await switchChannel(name);
        } catch (e) {
            logError('roomConnection/createChannel 创建频道失败', e);
            alertError('创建频道失败', e);
        }
    }

    function resetRoomUIAfterDisconnect() {
        document.getElementById('video-container').innerHTML = '';
        document.getElementById('audio-container').innerHTML = '';
        document.getElementById('participant-list').innerHTML = '<div style="font-size: 12px; color: #80848e; text-align: center; margin-top: 20px;">加入频道后显示在线人员</div>';
        document.getElementById('user-count').innerText = '0';
        document.getElementById('btn-mic').disabled = true;
        document.getElementById('mic-select').disabled = true;
        document.getElementById('audio-output-select').disabled = true;
        document.getElementById('btn-screen').disabled = true;
        document.getElementById('screen-res').disabled = true;
        document.getElementById('screen-fps').disabled = true;
        document.getElementById('screen-bitrate').disabled = true;
        document.getElementById('chat-input').disabled = true;
        document.getElementById('btn-send').disabled = true;
        document.getElementById('btn-app-audio').disabled = true;

        context.rustMic.setMicOn(false);
        context.screenShare.setIsScreenOn(false);
        context.appAudio.setIsAppAudioSharing(false);
        context.appAudio.setLocalAppAudioPublication(null);
        context.participants.clearActiveSpeakers();
        context.remoteAudio.clearRemoteGainNodes();
        context.livekitEvents.clearLocalScreenControls();
        context.screenShare.hideLocalScreenPreview();

        const uiName = document.getElementById('ui-username');
        if (uiName) uiName.innerText = '未连接大厅';
        const uiStatus = document.getElementById('ui-status');
        if (uiStatus) {
            uiStatus.innerText = '等待加入房间';
            uiStatus.style.color = '#b5bac1';
        }

        context.appAudio.closeAppAudioModal();
    }

    async function joinRoom(options = {}) {
        const autoJoinFirstChannel = options.autoJoinFirstChannel !== false;
        const username = document.getElementById('username').value.trim();
        if (!username) return alert('起个响亮的名字吧！');

        context.ensureAudioContext();
        await context.audioPipelines.resumeLocalPcmAudioContext();

        localStorage.setItem('lk_username', username);
        const serverConfig = getServerConfig();
        localStorage.setItem('lk_server_ip', serverConfig.persistValue);

        isInLobby = true;
        document.getElementById('btn-connect').innerText = '🏛️ 已进入大厅';
        document.getElementById('btn-connect').style.backgroundColor = '#1a6334';
        document.getElementById('header').innerText = '# 🏛️ DoNiChannel 电竞大厅（选择左侧语音分组）';

        await refreshRoomsFromServer().catch((err) => {
            logError('roomConnection/joinRoom 进入大厅后拉取房间列表失败', err, 'warn');
            renderChannelList();
        });
        startRoomPolling();

        if (context.autoJoinFirstChannelAfterLobby && autoJoinFirstChannel && !context.getRoom() && Array.isArray(channels) && channels.length > 0) {
            await switchChannel(channels[0]);
        }
    }

    async function switchChannel(roomName) {
        if (!isInLobby) {
            await joinRoom({ autoJoinFirstChannel: false });
            if (!isInLobby) return;
        }

        if (isSwitchingChannel) return;

        const room = context.getRoom();
        if (currentChannel === roomName && room) return;
        isSwitchingChannel = true;

        const isInitialChannelJoin = !room;
        const shouldRestoreMic = isInitialChannelJoin
            ? true
            : (context.rustMic.getIsMicOn() || context.rustMic.getIsRustMicOn() || context.rustMic.hasLocalRustMicPublication());
        shouldRestoreMicAfterChannelSwitch = shouldRestoreMic;

        try {
            const currentRoom = context.getRoom();
            if (currentRoom) {
                try {
                    if (context.isTauriClient && (context.rustMic.getIsMicOn() || context.rustMic.getIsRustMicOn() || context.rustMic.hasLocalRustMicPublication())) {
                        await context.rustMic.stopRustMicShare();
                    } else if (!context.isTauriClient && context.rustMic.getIsMicOn() && currentRoom.localParticipant) {
                        await currentRoom.localParticipant.setMicrophoneEnabled(false).catch(() => {});
                        context.rustMic.setMicOn(false);
                    }

                    if (context.appAudio.getIsAppAudioSharing()) {
                        await context.appAudio.stopAppAudioShare();
                    }

                    if (context.screenShare.getIsScreenOn() && currentRoom.localParticipant) {
                        await currentRoom.localParticipant.setScreenShareEnabled(false).catch(() => {});
                        context.screenShare.setIsScreenOn(false);
                    }
                } catch (e) {
                    logError('roomConnection/switchChannel 停止旧频道本地资源失败', e, 'warn');
                }

                try {
                    await currentRoom.disconnect();
                } catch (e) {
                    logError('roomConnection/switchChannel 断开旧频道失败', e, 'warn');
                }

                context.setRoom(null);
                resetRoomUIAfterDisconnect();
            }

            currentChannel = roomName;
            renderChannelList();

            await connectToChannel(roomName, { autoMic: false });

            const nextRoom = context.getRoom();
            if (shouldRestoreMicAfterChannelSwitch && nextRoom && nextRoom.localParticipant) {
                try {
                    if (context.isTauriClient) {
                        await context.updateMicList().catch((error) => logError('roomConnection/switchChannel 恢复麦克风前刷新设备列表失败', error, 'warn'));
                        await context.rustMic.startRustMicShare();
                        context.rustMic.showRustMicUi();
                    } else {
                        await nextRoom.localParticipant.setMicrophoneEnabled(true, context.rustMic.getMicCaptureOptions());
                    }

                    context.rustMic.setMicOn(true);
                    context.rustMic.updateMicSourceButton();
                    console.log('[roomConnection/switchChannel] 麦克风已在新频道重新发布');
                } catch (e) {
                    logError('roomConnection/switchChannel 新频道恢复麦克风失败', e);
                    context.rustMic.setMicOn(false);
                    context.rustMic.setRustMicOn(false);
                    context.rustMic.updateMicSourceButton();
                    alertError('切换频道后恢复麦克风失败', e);
                }
            }
        } finally {
            shouldRestoreMicAfterChannelSwitch = false;
            isSwitchingChannel = false;
            context.rustMic.updateMicSourceButton();
        }
    }

    async function connectToChannel(targetRoomName, options = {}) {
        const autoMic = options.autoMic !== false;
        const username = document.getElementById('username').value.trim();
        if (!username) return;
        const serverConfig = getServerConfig();

        try {
            const response = await fetch(`${serverConfig.apiBase}/api/get_token?user=${encodeURIComponent(username)}&room=${encodeURIComponent(targetRoomName)}`);
            const data = await response.json();
            const token = data.token;

            const room = new context.LivekitClient.Room({
                adaptiveStream: true,
                dynacast: true,
                audioCaptureDefaults: context.rustMic.getMicCaptureOptions(),
                publishDefaults: {
                    videoCodec: 'h264',
                    dtx: true,
                    audioPreset: (context.LivekitClient.AudioPresets && (context.LivekitClient.AudioPresets.musicHighQuality || context.LivekitClient.AudioPresets.music)) || undefined,
                },
            });

            context.setRoom(room);
            context.livekitEvents.registerRoomEvents(room);

            await room.connect(serverConfig.livekitWs, token);
            document.getElementById('header').innerText = `# 🔊 ${targetRoomName} 语音分组`;
            document.getElementById('ui-username').innerText = username;
            document.getElementById('ui-status').innerText = '已连接: ' + targetRoomName;
            document.getElementById('ui-status').style.color = '#23a559';

            document.getElementById('username').disabled = true;
            document.getElementById('btn-mic').disabled = false;
            document.getElementById('mic-select').disabled = false;
            document.getElementById('audio-output-select').disabled = false;
            document.getElementById('btn-screen').disabled = false;
            context.rustMic.updateMicSourceButton();
            document.getElementById('screen-res').disabled = false;
            document.getElementById('screen-fps').disabled = false;
            document.getElementById('screen-bitrate').disabled = false;
            document.getElementById('btn-app-audio').disabled = false;
            document.getElementById('btn-leave').style.display = 'flex';

            await context.updateMicList();

            try {
                if (autoMic && !context.rustMic.getIsMicOn()) {
                    await context.updateMicList().catch((error) => logError('roomConnection/connectToChannel 自动开麦前刷新设备列表失败', error, 'warn'));
                    await context.rustMic.toggleMic();
                }
            } catch (e) {
                logError('roomConnection/connectToChannel 自动开麦失败', e, 'warn');
            }

            document.getElementById('chat-input').disabled = false;
            document.getElementById('btn-send').disabled = false;

            context.participants.updateParticipantList();
            await context.updateAudioOutputList();
            await context.switchAudioOutput(document.getElementById('audio-output-select').value || context.getSelectedAudioOutputId());
            context.appAudio.updateAppAudioButtons();
        } catch (error) {
            logError('roomConnection/connectToChannel 频道连接失败', error);
            alertError('连接频道失败', error, '请检查 LiveKit 服务、Token 服务或网络连接。');
            currentChannel = null;
            context.setRoom(null);
            renderChannelList();
            document.getElementById('header').innerText = '# 🏛️ DoNiChannel 电竞大厅（连接失败，请重试）';
        }
    }

    async function leaveRoom() {
        if (context.isTauriClient && context.rustMic.getIsMicOn()) {
            await context.rustMic.stopRustMicShare();
        }

        context.appAudio.stopAppAudioShare();
        stopRoomPolling();
        context.screenShare.stopScreenBitrateMonitor();
        context.screenShare.hideLocalScreenPreview();

        const room = context.getRoom();
        if (room) room.disconnect();
        context.audioPipelines.teardownLocalPcmPipeline();

        setTimeout(() => {
            window.location.reload();
        }, 100);
    }

    return {
        normalizeServerInput,
        getServerConfig,
        renderChannelList,
        refreshRoomsFromServer,
        startRoomPolling,
        stopRoomPolling,
        createChannel,
        resetRoomUIAfterDisconnect,
        joinRoom,
        switchChannel,
        connectToChannel,
        leaveRoom,
        getCurrentChannel: () => currentChannel,
        getChannels: () => channels,
        getIsInLobby: () => isInLobby,
    };
}
