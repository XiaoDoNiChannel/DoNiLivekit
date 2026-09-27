import { alertError, formatError, getErrorMessage, logError } from '../shared/errors.js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 调用 Rust start_capture，并在 9001 推流通道尚未就绪时短暂重试。 */
async function startCaptureWithRetry(invoke, pid, maxAttempts = 8, intervalMs = 150) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await invoke('start_capture', { pid });
        } catch (error) {
            lastError = error;
            const message = String(error?.message || error || '');
            const isChannelNotReady = message.includes('channel closed');
            if (!isChannelNotReady || attempt === maxAttempts) break;
            await sleep(intervalMs);
        }
    }
    throw new Error(formatError(`启动应用音频采集失败(pid=${pid})`, lastError));
}

/** 多进程应用音频采集入口；用于同时共享多个应用的声音。 */
async function startCaptureMultiWithRetry(invoke, pids, maxAttempts = 8, intervalMs = 150) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await invoke('start_capture_multi', { pids });
        } catch (error) {
            lastError = error;
            const message = String(error?.message || error || '');
            const isChannelNotReady = message.includes('channel closed');
            if (!isChannelNotReady || attempt === maxAttempts) break;
            await sleep(intervalMs);
        }
    }
    throw new Error(formatError(`启动多应用音频采集失败(pids=${pids.join(',')})`, lastError));
}

/** 创建应用音频共享模块。context 提供 room、publication 和 9001 PCM 管线操作。 */
export function createAppAudioFeature(context) {
    const selectedAppAudioPids = new Set();
    let starting = false;

    /** 根据房间连接和共享状态刷新左下角应用音频按钮。 */
    function updateAppAudioButtons() {
        const btn = document.getElementById('btn-app-audio');
        if (!btn) return;

        const room = context.getRoom();
        const connected = !!(room && room.localParticipant);
        btn.disabled = !connected;

        if (context.getIsAppAudioSharing()) {
            btn.classList.add('active');

            btn.setAttribute('data-tooltip', '停止音频共享');
        } else {
            btn.classList.remove('active');

            btn.setAttribute('data-tooltip', '共享应用音频');
        }
    }

    function closeAppAudioModal(event) {
        if (event && event.target && event.target.id !== 'app-audio-modal') return;
        const modal = document.getElementById('app-audio-modal');
        if (modal) modal.classList.add('hidden');
        selectedAppAudioPids.clear();
    }

    function handleAppAudioClick() {
        if (context.getIsAppAudioSharing()) {
            stopAppAudioShare();
        } else {
            openAppAudioModal();
        }
    }

    /** 打开应用音频弹窗，并从 Rust 获取当前活跃进程列表。 */
    async function openAppAudioModal() {
        const room = context.getRoom();
        if (!room || !room.localParticipant) {
            alert('请先进入语音分组后再共享应用音频。');
            return;
        }

        const modal = document.getElementById('app-audio-modal');
        const listEl = document.getElementById('app-audio-process-list');
        if (!modal || !listEl) return;

        modal.classList.remove('hidden');
        listEl.innerHTML = '<div class="modal-empty">正在扫描活跃进程...</div>';

        try {
            const processes = await context.invoke('get_active_processes');
            const rows = (Array.isArray(processes) ? processes : []).filter((p) => {
                const name = (p?.name || '').trim();
                return name.length > 0;
            });

            if (rows.length === 0) {
                listEl.innerHTML = '<div class="modal-empty">未发现可用进程，请先启动目标应用后重试。</div>';
                return;
            }

            listEl.innerHTML = rows.map((p) => {
                const safeName = context.sanitizeText(p.name);
                const pid = Number(p.pid) || 0;
                const mem = Number(p.memory_mb) || 0;
                return `
                    <button id="process-item-${pid}" class="process-item" onclick="toggleAppAudioProcessSelection(${pid})" title="选择 ${safeName}">
                        <span class="process-name">${safeName}</span>
                        <span class="process-meta">PID ${pid} · ${mem} MB</span>
                    </button>
                `;
            }).join('');
        } catch (error) {
            logError('appAudio/openAppAudioModal 获取活跃进程失败', error);
            listEl.innerHTML = `<div class="modal-empty">获取进程列表失败：${context.sanitizeText(getErrorMessage(error))}</div>`;
        }
    }

    function toggleAppAudioProcessSelection(pid) {
        if (!Number.isFinite(pid) || pid <= 0) return;
        const item = document.getElementById(`process-item-${pid}`);
        if (selectedAppAudioPids.has(pid)) {
            selectedAppAudioPids.delete(pid);
            if (item) item.classList.remove('selected');
        } else {
            selectedAppAudioPids.add(pid);
            if (item) item.classList.add('selected');
        }
    }

    /** 确认进程选择：启动 9001 管线并将 app-audio track 发布到当前频道。 */
    async function confirmAppAudioSelection() {
        if (starting) return;
        const pids = Array.from(selectedAppAudioPids.values());
        const programNames = pids.map(pid => document.querySelector(`#process-item-${pid} .process-name`)?.textContent || `进程 ${pid}`);
        if (pids.length === 0) {
            alert('请至少选择一个应用进程。');
            return;
        }

        const room = context.getRoom();
        if (!room || !room.localParticipant) {
            alert('房间未连接，无法共享应用音频。');
            return;
        }

        const listEl = document.getElementById('app-audio-process-list');
        if (listEl) {
            listEl.innerHTML = '<div class="modal-empty">正在启动多应用音频截流并发布轨道，请稍候...</div>';
        }

        starting = true;
        try {
            const oldPublication = context.getLocalAppAudioPublication();
            if (oldPublication) {
                try {
                    await room.localParticipant.unpublishTrack(oldPublication.track);
                } catch (_) {}
                context.setLocalAppAudioPublication(null);
            }

            const realSampleRate = pids.length === 1
                ? await startCaptureWithRetry(context.invoke, pids[0])
                : await startCaptureMultiWithRetry(context.invoke, pids);

            const track = await context.initLocalPcmPipeline(realSampleRate);
            if (!track) throw new Error('应用音频管线未返回 MediaStreamTrack，请检查 9001 WebSocket 与 AudioWorklet 初始化。');

            // Rust 9001 刚启动时给一点缓冲，避免发布瞬间远端收到空音频。
            await sleep(500);

            if (context.getRoom() !== room) { context.teardownLocalPcmPipeline(); return; }
            const publication = await room.localParticipant.publishTrack(track, { name: `app-audio:${programNames.join('、')}` });
            context.setLocalAppAudioPublication(publication);
            context.setIsAppAudioSharing(true);
            updateAppAudioButtons();
            closeAppAudioModal();
        } catch (error) {
            logError('appAudio/confirmAppAudioSelection 共享应用音频失败', error);
            alertError('共享应用音频失败', error);
            context.setIsAppAudioSharing(false);
            context.teardownLocalPcmPipeline();
            updateAppAudioButtons();
        } finally {
            starting = false;
        }
    }

    /** 停止 app-audio 发布并释放 9001 AudioWorklet/WebSocket 管线。 */
    async function stopAppAudioShare() {
        const room = context.getRoom();
        try {
            const publication = context.getLocalAppAudioPublication();
            if (room && room.localParticipant && publication) {
                await room.localParticipant.unpublishTrack(publication.track);
            }
        } catch (error) {
            logError('appAudio/stopAppAudioShare 停止应用音频发布失败', error, 'warn');
        } finally {
            context.setLocalAppAudioPublication(null);
            context.setIsAppAudioSharing(false);
            context.teardownLocalPcmPipeline();
            closeAppAudioModal();
            updateAppAudioButtons();
        }
    }

    return {
        updateAppAudioButtons,
        closeAppAudioModal,
        handleAppAudioClick,
        openAppAudioModal,
        toggleAppAudioProcessSelection,
        confirmAppAudioSelection,
        stopAppAudioShare,
    };
}
