<script setup>
import { computed, ref, watch } from 'vue';
import { Monitor, Music2, ChevronDown, X } from 'lucide-vue-next';
import { sharingStore } from '../../stores/sharingStore.js';
const emit = defineEmits(['watch', 'listen', 'dismiss']);
const expanded = ref(true);
watch(() => sharingStore.view, value => { if (value === 'watch') expanded.value = false; }, { immediate: true });
const groups = computed(() => {
  const byOwner = new Map();
  for (const share of sharingStore.shares) {
    if (!byOwner.has(share.identity)) byOwner.set(share.identity, { identity: share.identity, name: share.displayName, shares: [] });
    byOwner.get(share.identity).shares.push(share);
  }
  return [...byOwner.values()];
});
const notices = computed(() => sharingStore.notices.map(notice => sharingStore.shares.find(share => share.id === notice.id)).filter(Boolean));
</script>
<template>
  <section v-if="groups.length" class="share-shelf" aria-label="房间共享列表">
    <button class="share-shelf-heading" :aria-expanded="expanded" @click="expanded = !expanded"><Monitor :size="15" /><span>房间共享 · {{ sharingStore.shares.length }} 路</span><ChevronDown :size="15" :class="{ rotated: !expanded }" /></button>
    <div v-show="expanded" class="share-groups"><div v-for="group in groups" :key="group.identity" class="share-owner"><strong>{{ group.name }}</strong><div v-for="share in group.shares" :key="share.id" class="share-source"><component :is="share.kind === 'screen' ? Monitor : Music2" :size="15" /><span :title="share.title">{{ share.title }}</span><button v-if="share.kind === 'screen'" :aria-pressed="share.id === sharingStore.watchingId" @click="emit('watch', share.id)">{{ share.id === sharingStore.watchingId ? '返回观看' : '观看' }}</button><button v-else :aria-pressed="share.wanted" @click="emit('listen', share.id)">{{ share.wanted ? '停止收听' : '收听' }}</button></div></div></div>
  </section>
  <div class="share-notices" aria-live="polite" aria-label="新共享提醒"><article v-for="share in notices" :key="share.id" class="share-notice"><component :is="share.kind === 'screen' ? Monitor : Music2" :size="19" /><div><strong>{{ share.displayName }} 开始共享{{ share.kind === 'screen' ? '画面' : '程序音频' }}</strong><small>{{ share.title }}</small><button @click="emit(share.kind === 'screen' ? 'watch' : 'listen', share.id)">{{ share.kind === 'screen' ? '观看' : '收听' }}</button><button class="notice-later" @click="emit('dismiss', share.id)">暂不{{ share.kind === 'screen' ? '观看' : '收听' }}</button></div><button class="notice-close" aria-label="关闭共享提醒" @click="emit('dismiss', share.id)"><X :size="16" /></button></article></div>
</template>
