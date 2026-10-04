<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import StatusOverlay from './StatusOverlay.vue';
import { invoke, listen, isTauriClient } from '../shared/tauri.js';
import { createOverlayStore } from '../stores/overlayStore.js';
import { createOverlayClient } from '../features/overlayClient.js';
import { acceptOverlayPacket } from '../features/overlayProtocol.js';
import { applyThemeToDocument } from '../stores/themeStore.js';
const store = createOverlayStore(), packet = ref(null), receivedAt = ref(0), clock = ref(Date.now()), pending = ref(false);
const drafts = ref({});
const draftKey = computed(() => `${packet.value?.snapshot.session || ''}:${packet.value?.snapshot.panel?.chatChannelId || ''}`);
const draft = computed({ get: () => drafts.value[draftKey.value] || '', set: value => { drafts.value[draftKey.value] = value; } });
const fresh = computed(() => !!packet.value?.fresh && clock.value - receivedAt.value < 6000);
const client = createOverlayClient({ store, invoke, listen, available: isTauriClient, onPacket(next) {
    const accepted = acceptOverlayPacket(packet.value, next);
    if (accepted && accepted.sequence !== packet.value?.sequence) receivedAt.value = Date.now();
    packet.value = accepted;
    if (accepted) applyThemeToDocument(accepted.snapshot.theme);
} });
let timer;
onMounted(() => { void client.start(); timer = setInterval(() => { clock.value = Date.now(); }, 500); window.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { client.dispose(); clearInterval(timer); window.removeEventListener('keydown', onKey); });
function onKey(event) { if (event.key === 'Escape' && !event.isComposing && store.status.interactive && store.status.shortcutsReady) { document.activeElement?.blur?.(); void client.control('game'); } }
async function action(request) {
    if (pending.value || !fresh.value || !store.status.interactive) return false;
    pending.value = true; store.error = '';
    try {
        await invoke('overlay_action', { request: { ...request, session: packet.value.snapshot.session } });
        return true;
    } catch (error) { store.error = String(error); return false; }
    finally { pending.value = false; }
}
async function send() {
    const key = draftKey.value, content = draft.value;
    if (!content.trim()) return;
    if (await action({ kind: 'chat', channelId: packet.value.snapshot.panel.chatChannelId, content })) {
        if (drafts.value[key] === content) drafts.value[key] = '';
    }
}
async function mic() {
    if (pending.value || !fresh.value || !packet.value?.snapshot.connected) return;
    pending.value = true; store.error = '';
    try {
        await invoke('overlay_mic', { session: packet.value.snapshot.session, enabled: !packet.value.snapshot.micOn });
        await client.read();
    } catch (error) { store.error = String(error); }
    finally { pending.value = false; }
}
async function drag(resize = false) {
    if (!isTauriClient || !store.status.interactive) return;
    try {
        if (resize) await window.__TAURI__.window.getCurrentWindow().startResizeDragging('SouthEast');
        else await invoke('overlay_drag');
    } catch (error) { store.error = String(error); }
}
</script>
<template>
  <StatusOverlay v-model:draft="draft" :now="clock" :status="store.status" :snapshot="packet?.snapshot" :fresh="fresh" :available="store.available && store.ready" :pending="pending" :busy="store.busy" :error="store.error"
    @control="client.control" @opacity="opacity => client.preferences({ opacity })" @layout="layout => client.preferences({ layout })" @action="action" @send="send" @mic="mic" @drag="drag(false)" @resize="drag(true)" />
</template>
