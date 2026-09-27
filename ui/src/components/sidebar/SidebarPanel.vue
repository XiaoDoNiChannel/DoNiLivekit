<script setup>
import { ref, watch, computed } from 'vue';
import { AudioLines, ChevronsUpDown, Plus, Settings2 } from 'lucide-vue-next';
import ChannelList from './ChannelList.vue';
import ParticipantList from './ParticipantList.vue';
import BaseAvatar from '../common/BaseAvatar.vue';
import { appStore } from '../../stores/appStore.js';
import { profileStore, getSelfDisplayName } from '../../stores/profileStore.js';
defineEmits(['join-room', 'create-channel', 'switch-channel', 'delete-channel', 'open-settings']);
const serverOpen = ref(!appStore.connection.isInLobby);
watch(() => appStore.connection.isInLobby, joined => { serverOpen.value = !joined; });
const name = computed(() => getSelfDisplayName('我的资料'));
</script>
<template>
  <aside id="sidebar" class="channel-sidebar workspace-sidebar">
    <header class="workspace-brand"><AudioLines :size="21" /><strong>DoNiChannel</strong></header>
    <button class="server-menu-button" :aria-expanded="serverOpen" @click="serverOpen = !serverOpen"><span><strong>局域网大厅</strong><small>{{ appStore.connection.isInLobby ? '已连接' : '设置连接' }}</small></span><ChevronsUpDown :size="16" /></button>
    <section v-show="serverOpen" id="login-section" class="server-menu"><label>服务器<input id="server-ip" type="text" placeholder="服务器 IP:端口"></label><label>昵称<input id="username" type="text" placeholder="你的昵称"></label><button id="btn-connect" class="primary-btn" @click="$emit('join-room')">进入大厅</button></section>
    <div class="sidebar-scroll-area"><section class="voice-channel-section"><div class="section-title-row channel-section-title"><span class="sidebar-title">语音频道</span><button class="create-channel-button" aria-label="创建频道" @click="$emit('create-channel')"><Plus :size="16" /></button></div><ChannelList @switch-channel="$emit('switch-channel', $event)" @delete-channel="$emit('delete-channel', $event)" /></section></div>
    <footer class="workspace-profile"><button class="profile-settings" @click="$emit('open-settings', 'profile')"><BaseAvatar :name="name" :color="profileStore.avatarColor" :preset="profileStore.avatarPreset" :avatar-url="profileStore.avatarUrl" size="sm" /><span><strong>{{ name }}</strong><small>{{ appStore.connection.isInLobby ? '在线' : '未连接' }}</small></span><Settings2 :size="17" /></button></footer>
    <!-- Keep legacy participant routing hooks mounted; the visible controls live under members. -->
    <div hidden><span id="user-count">0</span><span id="ui-username"></span><span id="ui-status"></span><ParticipantList /></div>
  </aside>
</template>
