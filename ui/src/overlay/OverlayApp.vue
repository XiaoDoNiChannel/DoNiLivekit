<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import StatusOverlay from './StatusOverlay.vue';
import { invoke, listen, isTauriClient } from '../shared/tauri.js';
import { createOverlayStore } from '../stores/overlayStore.js';
import { createOverlayClient } from '../features/overlayClient.js';
import { acceptOverlayPacket } from '../features/overlayProtocol.js';
import { applyThemeToDocument } from '../stores/themeStore.js';
const store = createOverlayStore(), packet = ref(null), receivedAt = ref(0), clock = ref(Date.now()), pending = ref(false);
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
function onKey(event) { if (event.key === 'Escape' && store.status.interactive && store.status.shortcutsReady) void client.control('game'); }
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
  <StatusOverlay :status="store.status" :snapshot="packet?.snapshot" :fresh="fresh" :available="store.available && store.ready" :pending="pending" :busy="store.busy" :error="store.error"
    @control="client.control" @opacity="opacity => client.preferences({ opacity })" @mic="mic" @drag="drag(false)" @resize="drag(true)" />
</template>
