<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { Gamepad2, Plus, Pencil, Trash2, Volume2 } from 'lucide-vue-next';
import { workspaceStore as state } from '../../stores/workspaceStore.js';
import { presenceStore, getAuthoritativeChannelMembers } from '../../stores/presenceStore.js';
import { onlineInterests } from '../../features/workspace.js';
const props = defineProps({ channelId: String });
const emit = defineEmits(['edit', 'action', 'browse', 'join']);
const deleting = ref(''), clock = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { clock.value = Date.now(); }, 30000); });
onUnmounted(() => clearInterval(timer));
const self = computed(() => presenceStore.userId || presenceStore.identity);
const isLobby = computed(() => presenceStore.channels.find(c => c.id === props.channelId)?.isLobby);
const cards = computed(() => state.cards.filter(c => isLobby.value || c.targetChannel === props.channelId));
const channels = computed(() => presenceStore.channels.filter(c => !c.isLobby && getAuthoritativeChannelMembers(c.id).length));
const online = card => onlineInterests(card, presenceStore.participants);
const interested = card => card.interests.some(p => p.userId === self.value);
function age(timestamp) { const minutes = Math.max(0, Math.floor((clock.value - timestamp) / 60000)); return minutes < 1 ? '刚刚更新' : minutes < 60 ? `${minutes} 分钟前更新` : `${Math.floor(minutes / 60)} 小时前更新`; }
function title(id) { return presenceStore.channels.find(c => c.id === id)?.displayName || id; }
function remove(card) { emit('action', 'card_delete', { id: card.id, revision: card.revision }); deleting.value = ''; }
</script>
<template>
  <aside class="party-panel" aria-label="游戏组队卡">
    <header><div><strong>{{ isLobby ? '今天玩什么' : '频道组队卡' }}</strong><small>意向可以多选 · 不等于已参战</small></div><button :disabled="!state.supported || state.busy" @click="emit('edit', null)"><Plus :size="15" />发起</button></header>
    <p v-if="!state.supported" class="party-hint">{{ presenceStore.connected ? '组队功能需要更新服务端。' : '大厅连接已断开，重连后恢复组队卡。' }}</p>
    <p v-else-if="!cards.length" class="party-empty">还没有组队卡。发起一个想玩的游戏，大家在这里集合。</p>
    <article v-for="card in cards" :key="card.id" class="party-card">
      <div class="party-card-heading"><Gamepad2 :size="20" /><div><h3>{{ card.game }}</h3><small>{{ card.ownerName }} · {{ age(card.updatedAt) }}</small></div><div v-if="card.ownerId === self" class="party-card-tools"><button :disabled="state.busy" :aria-label="`编辑 ${card.game} 卡片`" @click="emit('edit', card)"><Pencil :size="14" /></button><button :disabled="state.busy" :aria-label="`删除 ${card.game} 卡片`" @click="deleting = deleting === card.id ? '' : card.id"><Trash2 :size="14" /></button></div></div>
      <p v-if="card.note" class="party-note">{{ card.note }}</p>
      <div class="party-people"><span v-for="member in online(card)" :key="member.userId">{{ member.displayName }}{{ member.userId === self ? ' · 我' : '' }}</span></div>
      <div class="party-interest-row"><small>{{ online(card).length }} 位在线成员想玩<span v-if="card.interests.length > online(card).length"> · {{ card.interests.length - online(card).length }} 位离线</span></small><button :disabled="state.busy || !state.supported" :aria-pressed="interested(card)" @click="emit('action', 'card_interest', { id: card.id, enabled: !interested(card) })">{{ interested(card) ? '暂时不玩' : '我也想玩' }}</button></div>
      <div v-if="card.targetChannel" class="party-target"><span><Volume2 :size="13" />{{ title(card.targetChannel) }}</span><small>语音内 {{ getAuthoritativeChannelMembers(card.targetChannel).length }} 人</small><div><button @click="emit('browse', card.targetChannel)">查看频道</button><button :disabled="state.busy || !presenceStore.connected" @click="emit('join', card.targetChannel)">加入语音</button></div></div>
      <p v-else class="party-hint">大厅集合 · {{ card.ownerId === self ? '编辑卡片可选择出发频道' : '尚未指定游戏语音频道' }}</p>
      <div v-if="deleting === card.id" class="party-delete-confirm"><p>删除这张组队卡？意向记录一并撤下，语音频道和通话不受影响。</p><button :disabled="state.busy" @click="remove(card)">确认删除</button><button :disabled="state.busy" @click="deleting = ''">取消</button></div>
    </article>
    <section v-if="isLobby && channels.length" class="party-destinations"><h3>去哪里找大家</h3><div v-for="channel in channels" :key="channel.id"><span>{{ channel.displayName || channel.name }}<small>语音内 {{ getAuthoritativeChannelMembers(channel.id).length }} 人</small></span><button @click="emit('browse', channel.id)">查看</button></div></section>
  </aside>
</template>
