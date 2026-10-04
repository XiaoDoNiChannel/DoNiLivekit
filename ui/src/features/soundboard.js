import { analyzeSound, MAX_SOUND_BYTES, percent, readSoundboardSettings } from './soundboardAudio.js';

export function createSoundboardFeature({ state, invoke, listen, storage, getRoom, canSend,
    getOutputId, onReceiveChanged = () => {}, available = true,
    createContext = () => new AudioContext({ sampleRate: 48000 }), createAudio = () => new Audio(), now = Date.now }) {
    const settings = readSoundboardSettings(storage);
    let ctx, gain, sendGate, monitorGate, destination, monitorDestination, monitor, silence;
    let source, publication, publishedRoom, publishing, unlisten, disposed = false, starting;
    let generation = 0, epoch = 0, lastTrigger = -Infinity, resetting;
    const cache = new Map();
    const pending = new Map();
    const bindings = new Set();

    function save() {
        Object.assign(settings, { volume: state.volume, receiveVolume: state.receiveVolume,
            receive: state.receive, monitor: state.monitor, blocked: [...state.blocked], stopShortcut: state.stopShortcut });
        try { storage.setItem('lk_soundboard_v1', JSON.stringify(settings)); }
        catch { state.error = '设置保存失败，请检查本地存储空间'; }
    }
    function fail(action, error) {
        state.error = `一键喊话/${action}：${error?.message || error}`;
        console.warn(`soundboard/${action}`, error);
        if (action === '播放') state.open = true;
    }
    function graph() {
        if (ctx) return;
        ctx = createContext();
        gain = ctx.createGain(); sendGate = ctx.createGain(); monitorGate = ctx.createGain();
        destination = ctx.createMediaStreamDestination(); monitorDestination = ctx.createMediaStreamDestination();
        gain.connect(sendGate); gain.connect(monitorGate);
        sendGate.connect(destination); monitorGate.connect(monitorDestination);
        // Keep the media clock advancing between short clips. Without a live
        // silent source, Chromium can deliver buffered tail audio on restart.
        silence = ctx.createConstantSource(); silence.offset.value = 0;
        silence.connect(sendGate); silence.start();
        sendGate.gain.value = 0; monitorGate.gain.value = 0;
        monitor = createAudio(); monitor.srcObject = monitorDestination.stream;
    }
    async function output() {
        if (monitor?.setSinkId) await monitor.setSinkId(getOutputId() === 'default' ? '' : getOutputId());
    }
    function applyGain() {
        const clip = state.items.find(c => c.id === state.playing);
        if (gain && clip) gain.gain.setTargetAtTime((clip.attenuation ?? 1) * state.volume / 100 * clip.volume / 100, ctx.currentTime, 0.01);
        if (monitorGate) monitorGate.gain.value = state.mode === 'preview' || (state.mode === 'send' && state.monitor) ? 1 : 0;
    }
    function stop() {
        generation++;
        if (sendGate) sendGate.gain.value = 0;
        if (monitorGate) monitorGate.gain.value = 0;
        if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); source = null; }
        state.playing = ''; state.mode = '';
    }
    async function decode(bytes) {
        graph();
        const buffer = await ctx.decodeAudioData(bytes);
        return { buffer, ...analyzeSound(buffer) };
    }
    function remember(id, sound) {
        cache.delete(id); cache.set(id, sound);
        while (cache.size > 8) cache.delete(cache.keys().next().value);
        const clip = state.items.find(c => c.id === id);
        if (clip) Object.assign(clip, { duration: sound.duration, attenuation: sound.attenuation });
        return sound;
    }
    async function load(id) {
        if (cache.has(id)) { const value = cache.get(id); cache.delete(id); cache.set(id, value); return value; }
        if (pending.has(id)) return pending.get(id);
        const task = (async () => {
            const encoded = await invoke('soundboard_read', { id });
            const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
            return remember(id, await decode(bytes.buffer));
        })();
        pending.set(id, task);
        try { return await task; } finally { pending.delete(id); }
    }
    async function prepare() {
        if (resetting) await resetting;
        const room = getRoom();
        if (disposed || !available || !state.ready || !room || room.state !== 'connected') return;
        if (publication && publishedRoom === room) return;
        if (publishing?.room === room) return publishing.task;
        graph();
        const version = epoch;
        const job = { room };
        state.preparing = true;
        job.task = (async () => {
            // LiveKit stops published tracks on disconnect. Publish a clone so the
            // underlying Web Audio destination survives a full reconnect.
            const track = destination.stream.getAudioTracks()[0].clone();
            let pub;
            try {
                pub = await room.localParticipant.publishTrack(track, {
                    name: 'soundboard', source: 'unknown', dtx: false, audioPreset: { maxBitrate: 64000 },
                });
            } catch (error) { track.stop(); throw error; }
            if (disposed || epoch !== version || getRoom() !== room) {
                try { await room.localParticipant.unpublishTrack(pub.track, true); }
                finally { track.stop(); }
                return;
            }
            publication = pub; publishedRoom = room;
            state.sendReady = true;
        })();
        publishing = job;
        try { await job.task; }
        finally { if (publishing === job) { publishing = null; state.preparing = false; } }
    }
    async function play(id, preview = false) {
        if (disposed || state.busy) return;
        if (!preview && now() - lastTrigger < 300) return;
        if (!preview) lastTrigger = now();
        stop();
        const ticket = generation, room = getRoom();
        state.error = '';
        try {
            if (!preview && !canSend()) throw new Error('请先加入语音频道并打开麦克风');
            if (!preview && !state.sendReady) throw new Error('音效通道尚未就绪，请稍后再试');
            graph();
            // Resume/play in the user gesture, before IPC or decoding yields.
            const resume = ctx.resume();
            const localPlayback = preview || state.monitor;
            const monitoring = localPlayback ? monitor.play() : Promise.resolve();
            await Promise.all([resume, monitoring, localPlayback ? output() : Promise.resolve()]);
            const sound = await load(id);
            if (ticket !== generation || disposed) return;
            if (!preview) await prepare();
            if (ticket !== generation || disposed || (!preview && (getRoom() !== room || !canSend() || publishedRoom !== room))) return;
            const clip = state.items.find(c => c.id === id);
            if (!clip) return;
            state.playing = id; state.mode = preview ? 'preview' : 'send';
            gain.gain.cancelScheduledValues(ctx.currentTime);
            gain.gain.setValueAtTime(sound.attenuation * state.volume / 100 * clip.volume / 100, ctx.currentTime);
            sendGate.gain.value = preview ? 0 : 1;
            monitorGate.gain.value = localPlayback ? 1 : 0;
            const node = ctx.createBufferSource(); source = node; node.buffer = sound.buffer;
            node.connect(gain);
            node.onended = () => { if (source === node) stop(); };
            node.start();
        } catch (error) { if (ticket === generation) { stop(); fail('播放', error); } }
    }
    function reset() {
        stop(); epoch++; state.sendReady = false;
        const pub = publication, owner = publishedRoom, job = publishing;
        publication = null; publishedRoom = null;
        const previous = resetting;
        const task = (async () => {
            await previous;
            try { if (pub) await owner.localParticipant.unpublishTrack(pub.track, true); }
            catch (error) { console.warn('soundboard/reset', error); }
            finally { pub?.track?.stop?.(); }
            // Drain an in-flight publish before the same media track can enter a new room.
            try { await job?.task; } catch {}
        })();
        resetting = task;
        return task.finally(() => { if (resetting === task) resetting = null; });
    }
    async function bind(id, shortcut) {
        await invoke('soundboard_bind', { id, shortcut });
        if (shortcut) bindings.add(id); else bindings.delete(id);
        delete state.shortcutErrors[id];
    }
    async function setShortcut(id, shortcut) {
        try {
            await bind(id, shortcut);
            if (id === '_stop') state.stopShortcut = shortcut;
            else {
                const clip = state.items.find(c => c.id === id);
                if (clip) { clip.shortcut = shortcut; settings.clips[id] = { ...settings.clips[id], shortcut }; }
            }
            save();
        } catch (error) { state.shortcutErrors[id] = String(error?.message || error); }
    }
    function item(clip, index) {
        const pref = settings.clips[clip.id] || {};
        const seed = /^seed-([1-8])\.mp3$/.exec(clip.id);
        return { ...clip, name: pref.name || clip.name, volume: percent(pref.volume ?? 100, 100),
            shortcut: typeof pref.shortcut === 'string' ? pref.shortcut : (seed ? `Ctrl+Alt+Digit${seed[1]}` : ''), duration: 0 };
    }
    async function start() {
        if (starting) return starting;
        if (!available) { state.error = '一键喊话的导入和全局快捷键需要桌面客户端'; return; }
        starting = (async () => {
            try {
                const clips = await invoke('soundboard_list');
                if (disposed) return;
                state.items = clips.map(item);
                unlisten = await listen('soundboard-trigger', event => {
                    // Windows can consume a registered chord before the WebView's
                    // keydown. Still let the recorder report the conflict.
                    if (state.recording) {
                        const shortcut = event.payload === '_stop' ? state.stopShortcut : state.items.find(c => c.id === event.payload)?.shortcut;
                        if (shortcut) void setShortcut(state.recording, shortcut).finally(() => { state.recording = ''; });
                    } else if (event.payload === '_stop') stop();
                    else if (!state.busy) void play(event.payload);
                });
                for (const clip of [...state.items, { id: '_stop', shortcut: state.stopShortcut }]) {
                    if (disposed) return;
                    if (clip.shortcut) try { await bind(clip.id, clip.shortcut); }
                    catch (error) { state.shortcutErrors[clip.id] = String(error?.message || error); }
                }
                state.ready = true;
                await prepare();
                for (const clip of state.items.slice(0, 8)) {
                    if (disposed) return;
                    try { await load(clip.id); } catch (error) { clip.error = String(error?.message || error); }
                }
            } catch (error) { fail('初始化', error); }
        })();
        return starting;
    }
    async function importFiles(files) {
        if (state.busy) return;
        state.busy = true; state.error = ''; stop();
        const errors = [];
        try {
            for (const file of files) {
                try {
                    const extension = file.name.split('.').pop().toLowerCase();
                    if (!['mp3', 'wav', 'ogg'].includes(extension) || file.size > MAX_SOUND_BYTES) throw new Error('仅支持 5 MB 以内的 MP3、WAV、OGG');
                    const bytes = await file.arrayBuffer();
                    const sound = await decode(bytes.slice(0));
                    let binary = ''; const view = new Uint8Array(bytes);
                    for (let offset = 0; offset < view.length; offset += 8192) binary += String.fromCharCode(...view.subarray(offset, offset + 8192));
                    const clip = await invoke('soundboard_import', { name: file.name.replace(/\.[^.]+$/, ''), extension, data: btoa(binary) });
                    state.items.push(item(clip, state.items.length)); remember(clip.id, sound);
                } catch (error) { errors.push(`${file.name}：${error?.message || error}`); }
            }
        } finally { state.busy = false; state.error = errors.join('；'); }
    }
    async function remove(id) {
        if (state.busy) return;
        state.busy = true; stop();
        const previous = state.items.find(c => c.id === id)?.shortcut || '';
        try {
            await bind(id, '');
            await invoke('soundboard_remove', { id });
            state.items = state.items.filter(c => c.id !== id); cache.delete(id);
            delete settings.clips[id]; save();
        } catch (error) {
            if (previous) try { await bind(id, previous); } catch (restoreError) { state.shortcutErrors[id] = String(restoreError); }
            fail('删除', error);
        }
        finally { state.busy = false; }
    }
    function edit(id, patch) {
        const clip = state.items.find(c => c.id === id);
        if (!clip) return;
        if ('volume' in patch) clip.volume = percent(patch.volume, 100);
        if ('name' in patch) clip.name = String(patch.name).trim().slice(0, 80) || clip.name;
        settings.clips[id] = { name: clip.name, volume: clip.volume, shortcut: clip.shortcut };
        applyGain(); save();
    }
    function preferences(patch) {
        if ('volume' in patch) state.volume = percent(patch.volume);
        if ('receiveVolume' in patch) state.receiveVolume = percent(patch.receiveVolume, 80);
        if ('receive' in patch) state.receive = !!patch.receive;
        if ('monitor' in patch) {
            state.monitor = !!patch.monitor;
            if (state.monitor && state.mode === 'send') monitor?.play().catch(error => fail('返听', error));
        }
        applyGain(); save(); onReceiveChanged();
    }
    return { start, prepare, reset, stop, play, importFiles, remove, edit, preferences, setShortcut,
        output: () => output().catch(error => fail('输出设备', error)),
        block(identity, blocked) { state.blocked = [...new Set(blocked ? [...state.blocked, identity] : state.blocked.filter(x => x !== identity))]; save(); onReceiveChanged(); },
        async dispose() {
            disposed = true; unlisten?.(); await reset();
            await starting; unlisten?.();
            for (const id of bindings) try { await invoke('soundboard_bind', { id, shortcut: '' }); } catch {}
            monitor?.pause(); if (monitor) monitor.srcObject = null;
            destination?.stream.getTracks().forEach(track => track.stop());
            monitorDestination?.stream.getTracks().forEach(track => track.stop());
            silence?.stop();
            await ctx?.close(); cache.clear();
        },
    };
}
