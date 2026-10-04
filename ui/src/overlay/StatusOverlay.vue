<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { Mic, MicOff, LockKeyhole, X, Grip, ChevronDown, ChevronUp, Send, MessageSquare, Radio, SlidersHorizontal, Activity } from 'lucide-vue-next';
const props = defineProps({ status: Object, snapshot: Object, fresh: Boolean, available: Boolean, pending: Boolean, busy: Boolean, error: String, draft: String, now: Number });
const emit = defineEmits(['control', 'opacity', 'mic', 'drag', 'resize', 'layout', 'action', 'update:draft', 'send']);
const opacity = ref(70), tab = ref('messages'), messagesEl = ref(null), followLatest = ref(true);
const tabs = [{ id: 'messages', label: '消息', icon: MessageSquare }, { id: 'events', label: '动态', icon: Radio }, { id: 'voice', label: '语音', icon: SlidersHorizontal }, { id: 'status', label: '状态', icon: Activity }];
watch(() => props.status.preferences.opacity, value => { opacity.value = Math.round(value * 100); }, { immediate: true });
const expanded = computed(() => props.status.preferences.layout === 'expanded');
const panel = computed(() => props.snapshot?.panel || {});
const active = computed(() => props.fresh && props.snapshot?.connected);
const disabled = computed(() => props.busy || props.pending || !props.status.interactive || !props.available || !props.fresh);
const connection = computed(() => !props.fresh ? '状态更新中断' : props.snapshot?.reconnecting ? '正在重连' : props.snapshot?.connected ? '已连接' : '未连接语音');
const lastMessage = computed(() => panel.value.messages?.at(-1));
const recentEvent = computed(() => {
  const event = panel.value.events?.at(-1);
  return event && props.now - event.timestamp < 12000 ? event : null;
});
const statsFresh = computed(() => active.value && Number.isFinite(panel.value.diagnosticsAt) && props.now - panel.value.diagnosticsAt < 10000);
const quality = computed(() => !props.fresh ? '状态未知' : !active.value ? connection.value : !statsFresh.value ? '等待通话统计' : props.snapshot.networkWarning ? props.snapshot.networkText : panel.value.availability !== 'ready' ? '暂无可用通话统计' : '未发现通话异常');
function time(value) { return Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''; }
function metric(value, suffix, digits = 0) { return statsFresh.value && Number.isFinite(value) ? value.toFixed(digits) + ' ' + suffix : '—'; }
function trackScroll() { const el = messagesEl.value; if (el) followLatest.value = el.scrollHeight - el.scrollTop - el.clientHeight < 32; }
async function scrollLatest() { await nextTick(); if (followLatest.value && messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight; }
watch([() => panel.value.chatChannelId, expanded, tab], () => { followLatest.value = true; void scrollLatest(); });
watch(() => panel.value.messages?.map(row => row.id + ':' + row.status).join('|'), scrollLatest);
function submit(event) { if (!event?.isComposing && !disabled.value && panel.value.chatConnected && props.draft?.trim()) emit('send'); }
function volume(member, source, event) { emit('action', { kind: 'volume', identity: member.volumeIdentity, source, value: Number(event.target.value) }); }
</script>
<template>
  <section class="status-overlay" :class="{ interactive: status.interactive, stale: !fresh, expanded }" :style="{ '--overlay-opacity': opacity / 100 }" aria-label="队伍浮窗">
    <header class="status-overlay-header" @mousedown.left.prevent="status.interactive && emit('drag')">
      <strong :title="snapshot?.channel">{{ snapshot?.channel || 'DoNiChannel' }}</strong>
      <span class="overlay-connection">{{ connection }}</span>
      <template v-if="status.interactive">
        <button class="overlay-icon-button" :disabled="busy || pending || !available" :aria-label="expanded ? '切换精简布局' : '切换展开布局'" :title="expanded ? '收起' : '展开'" @mousedown.stop @click="emit('layout', expanded ? 'compact' : 'expanded')"><component :is="expanded ? ChevronUp : ChevronDown" :size="15" /></button>
        <button class="overlay-icon-button" :disabled="busy || !available || !status.shortcutsReady" :title="'鼠标穿透 · ' + status.preferences.editShortcut + ' 恢复'" aria-label="锁定并穿透" @mousedown.stop @click="emit('control', 'game')"><LockKeyhole :size="13" /></button>
        <button class="overlay-icon-button" :disabled="busy || !available" title="隐藏浮窗" aria-label="隐藏浮窗" @mousedown.stop @click="emit('control', 'hide')"><X :size="14" /></button>
      </template>
    </header>
    <div class="overlay-quick-status">
      <button class="overlay-mic" :disabled="disabled || !active" :aria-pressed="active && snapshot.micOn" @click="emit('mic')"><component :is="active && snapshot.micOn ? Mic : MicOff" :size="14" /><span>{{ !fresh ? '麦克风未知' : !active ? '未在通话' : snapshot.micOn ? '麦克风开' : '已静音' }}</span></button>
      <span>{{ active ? (panel.memberCount || 0) + ' 人在线' : '— 人在线' }}</span>
      <span class="overlay-unread">{{ panel.mentions ? '@我 ' + panel.mentions : '未读 ' + (panel.unread || 0) }}</span>
    </div>
    <template v-if="!expanded">
      <div class="overlay-compact-message" :title="lastMessage?.content"><span class="overlay-kicker">消息 · {{ panel.chatChannel || '未选择频道' }}</span><p>{{ !fresh ? '等待主界面更新消息' : lastMessage ? lastMessage.sender + '：' + lastMessage.content : '还没有消息' }}</p></div>
      <p class="overlay-compact-event" :title="recentEvent?.text || quality">{{ fresh && recentEvent ? recentEvent.text : quality }}</p>
    </template>
    <template v-else>
      <nav class="overlay-tabs" aria-label="浮窗内容"><button v-for="item in tabs" :key="item.id" :aria-pressed="tab === item.id" :disabled="!status.interactive" @click="tab = item.id"><component :is="item.icon" :size="13" />{{ item.label }}</button></nav>
      <div v-if="tab === 'messages'" class="overlay-page overlay-chat">
        <div class="overlay-page-heading"><span :title="panel.chatChannel">聊天 · {{ panel.chatChannel }}</span><button :disabled="disabled || !panel.chatChannelId || !panel.unread" @click="emit('action', { kind: 'read', channelId: panel.chatChannelId })">全部已读</button></div>
        <p class="overlay-note">跟随主界面的聊天频道{{ panel.chatConnected ? '' : ' · 聊天未连接' }}</p>
        <div ref="messagesEl" class="overlay-scroll overlay-messages" @scroll="trackScroll">
          <p v-if="!panel.messages?.length" class="overlay-empty">这里还没有消息，和队友打个招呼吧。</p>
          <article v-for="message in panel.messages" :key="message.id" class="overlay-chat-message" :class="{ self: message.self }">
            <header><strong>{{ message.self ? '你' : message.sender }}</strong><time>{{ time(message.timestamp) }}</time><span v-if="message.status !== 'sent'" :class="{ 'overlay-error-text': message.status === 'failed' }">{{ message.status === 'failed' ? '发送失败 · 主界面可重试' : '发送中' }}</span></header>
            <p>{{ message.content }}</p>
            <small v-if="message.truncated" class="overlay-note">长消息已截断，请在主界面查看完整内容。</small>
          </article>
        </div>
        <form class="overlay-composer" @submit.prevent="submit()">
          <textarea :value="draft" maxlength="2000" rows="2" aria-label="队伍消息" :placeholder="'发送到 ' + (panel.chatChannel || '聊天频道')" :disabled="!status.interactive || pending" @input="emit('update:draft', $event.target.value)" @keydown.enter.exact="!$event.isComposing && ($event.preventDefault(), submit($event))"></textarea>
          <button type="submit" aria-label="发送消息" :disabled="disabled || !panel.chatConnected || !panel.chatChannelId || !draft?.trim()"><Send :size="15" /></button>
        </form>
        <p class="overlay-note">Enter 发送 · Shift+Enter 换行 · 最近 30 条</p>
      </div>
      <div v-else-if="tab === 'events'" class="overlay-page">
        <div class="overlay-page-heading">队伍动态 · {{ snapshot?.channel }}</div>
        <p class="overlay-note">本次通话的成员进出与共享变化 · 最近 30 条</p>
        <div class="overlay-scroll"><p v-if="!panel.events?.length" class="overlay-empty">暂时没有新动态</p><article v-for="event in [...(panel.events || [])].reverse()" :key="event.id" class="overlay-event"><time>{{ time(event.timestamp) }}</time><p>{{ event.text }}</p></article></div>
      </div>
      <div v-else-if="tab === 'voice'" class="overlay-page">
        <div class="overlay-page-heading">语音控制 <span>{{ pending ? '正在操作…' : '与主界面同步' }}</span></div>
        <p class="overlay-note">上方按钮切换麦克风；成员音量只影响你的收听。</p>
        <div v-if="active && panel.micLevel !== null" class="overlay-level-row"><span>麦克风输入</span><meter min="0" max="100" :value="panel.micLevel" aria-label="麦克风输入电平"></meter></div>
        <div class="overlay-scroll"><p v-if="!active" class="overlay-empty">加入语音频道后可调整音量</p>
          <article v-for="member in active ? panel.members : []" :key="member.identity" class="overlay-member">
            <header><strong>{{ member.name }}{{ member.self ? '（你）' : '' }}</strong><span>{{ member.micOn ? '麦克风开' : '已静音' }}</span></header>
            <template v-if="!member.self"><label>语音 <input type="range" min="0" max="300" step="5" :aria-label="member.name + '的语音音量'" :value="member.micVolume" :disabled="disabled" @change="volume(member, 'mic', $event)"><output>{{ member.micVolume }}%</output></label>
              <label v-if="member.audio">程序音频 <input type="range" min="0" max="300" step="5" :aria-label="member.name + '的程序音量'" :value="member.audioVolume" :disabled="disabled" @change="volume(member, 'appaudio', $event)"><output>{{ member.audioVolume }}%</output></label></template>
          </article>
        </div>
      </div>
      <div v-else class="overlay-page">
        <div class="overlay-page-heading">通话状态</div>
        <div class="overlay-scroll"><p class="overlay-quality" :class="{ warning: fresh && snapshot?.networkWarning }">{{ quality }}</p>
          <dl class="overlay-metrics"><div><dt>链路 RTT</dt><dd>{{ metric(panel.rttMs, 'ms') }}</dd></div><div><dt>语音接收丢包</dt><dd>{{ metric(panel.lossPercent, '%', 1) }}</dd></div><div><dt>语音抖动</dt><dd>{{ metric(panel.jitterMs, 'ms', 1) }}</dd></div><div><dt>在线人数</dt><dd>{{ active ? panel.memberCount : '—' }}</dd></div></dl>
          <p class="overlay-note">RTT 是链路往返时间；缺失或过期的统计显示为 —。</p>
          <p class="overlay-sharing">你的屏幕：{{ !fresh ? '未知' : active && snapshot.screenOn ? '共享中' : '未共享' }}<br>你的程序音频：{{ !fresh ? '未知' : active && snapshot.appAudioOn ? '共享中' : '未共享' }}</p>
          <article v-for="issue in statsFresh ? panel.issues : []" :key="issue.title" class="overlay-issue"><strong>{{ issue.title }}</strong><p>{{ issue.detail }}</p></article>
        </div>
      </div>
    </template>
    <footer v-if="status.interactive" class="overlay-adjustments"><label>背景 <input v-model.number="opacity" type="range" min="10" max="100" step="5" :disabled="busy || !available" aria-label="背景不透明度" @change="emit('opacity', opacity / 100)"><span>{{ opacity }}%</span></label><button class="overlay-icon-button overlay-resize" :disabled="busy || !available" aria-label="拖动调整大小" @mousedown.left.prevent="emit('resize')"><Grip :size="14" /></button></footer>
    <footer v-else class="overlay-game-hint">鼠标穿透 · {{ status.preferences.editShortcut }} 操作</footer>
    <p v-if="!fresh" class="overlay-message" role="status">状态未更新，操作暂不可用</p>
    <p v-if="!available" class="overlay-message">请在桌面客户端打开队伍浮窗</p>
    <p v-if="error" class="overlay-message" role="alert">{{ error }}</p>
  </section>
</template>
