<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { Mic, MicOff, Headphones, Volume2, MonitorUp, Music2, SlidersHorizontal, PictureInPicture2, PhoneOff, ChevronUp, Settings2, X, Circle, Palette } from 'lucide-vue-next';
import { appStore } from '../../stores/appStore.js';
import { presenceStore } from '../../stores/presenceStore.js';
import { overlayStore } from '../../stores/overlayStore.js';
import { soundboardStore } from '../../stores/soundboardStore.js';
import { Megaphone } from 'lucide-vue-next';
import { isTauriClient } from '../../shared/tauri.js';
const emit = defineEmits(['toggle-mic', 'toggle-monitor', 'toggle-screen', 'app-audio-click', 'leave', 'open-settings', 'switch-mic', 'switch-output', 'overlay-control', 'audio-gain', 'mic-setting']);
const open = ref('');
const dock = ref(null);
const connected = computed(() => appStore.connection.isConnected);
const voiceChannelName = computed(() => presenceStore.channels.find(c => c.id === appStore.connection.currentChannel)?.displayName || appStore.connection.currentChannel || '选择频道，与朋友聊聊');
const micId = computed(() => appStore.media.micSource === 'rust' ? appStore.devices.selectedRustMicId : appStore.devices.selectedBrowserMicId);
function toggle(name) { open.value = open.value === name ? '' : name; }
function outside(e) { if (!dock.value?.contains(e.target)) open.value = ''; }
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>

<template>
  <footer ref="dock" id="user-control-panel" class="call-dock" @keydown.esc="open = ''">
    <div class="call-connection"><Circle :size="8" :class="{ connected }" fill="currentColor" /><div><strong>{{ connected ? '语音已连接' : '尚未加入语音' }}</strong><small>{{ voiceChannelName }}</small></div></div>
    <div class="call-actions">
      <div class="dock-control-group mic-control" :class="{ 'popup-open': open === 'mic' }">
        <button id="btn-mic" :disabled="!connected" :aria-pressed="appStore.media.micOn" :class="{ muted: !appStore.media.micOn }" @click="emit('toggle-mic')"><component :is="appStore.media.micOn ? Mic : MicOff" :size="18" /><span>{{ appStore.media.micOn ? '麦克风开' : '已静音' }}</span></button>
        <button class="dock-caret" aria-label="选择麦克风" :aria-expanded="open === 'mic'" @click="toggle('mic')"><ChevronUp :size="14" /></button>
        <section class="dock-popup mic-quick-popup" aria-label="麦克风快捷切换">
          <strong>麦克风</strong>
          <select aria-label="麦克风设备" :value="micId" @change="emit('switch-mic', $event.target.value)"><option v-for="device in appStore.devices.micOptions" :key="device.id" :value="device.id">{{ device.label }}</option></select>
          <button @click="open = ''; emit('open-settings', 'devices')"><Settings2 :size="15" /> 更多音频设备设置</button>
        </section>
      </div>
      <button id="btn-mic-monitor" :disabled="!connected || !appStore.media.rustMicOn" :aria-pressed="appStore.media.micMonitorOn" @click="emit('toggle-monitor')"><Headphones :size="18" /><span>{{ appStore.media.micMonitorOn ? '耳返开' : '耳返' }}</span></button>
      <div class="dock-control-group speaker-control" :class="{ 'popup-open': open === 'speaker' }">
        <button :aria-expanded="open === 'speaker'" aria-controls="speaker-quick-popup" @click="toggle('speaker')"><Volume2 :size="18" /><span>扬声器</span><ChevronUp :size="14" /></button>
        <section id="speaker-quick-popup" class="dock-popup speaker-quick-popup" aria-label="扬声器快捷切换">
          <strong>扬声器 / 耳机</strong>
          <select aria-label="底部扬声器设备" :value="appStore.devices.selectedAudioOutputId" :disabled="appStore.devices.audioOutputUnavailable" @change="emit('switch-output', $event.target.value)">
            <option v-for="device in appStore.devices.audioOutputOptions" :key="device.id" :value="device.id">{{ device.label }}</option>
          </select>
          <small>切换通话、程序音频收听和耳返的输出设备。</small>
          <button @click="open = ''; emit('open-settings', 'devices')"><Settings2 :size="15" /> 更多音频设备设置</button>
        </section>
      </div>
    </div>
    <div class="call-actions call-share-actions" role="group" aria-label="共享">
      <div class="dock-control-group screen-control" :class="{ 'popup-open': open === 'screen' }">
        <button id="btn-screen" :disabled="!connected" :aria-pressed="appStore.media.screenOn" @click="emit('toggle-screen')"><MonitorUp :size="18" /><span>{{ appStore.media.screenOn ? '停止画面' : '屏幕共享' }}</span></button>
        <button class="dock-caret" aria-label="共享画质" :aria-expanded="open === 'screen'" @click="toggle('screen')"><ChevronUp :size="14" /></button>
        <section class="dock-popup screen-quick-popup" aria-label="共享画质"><strong>共享画质</strong><label>分辨率<select id="screen-res" :disabled="!connected || appStore.media.screenOn"><option value="1280x720">720P</option><option value="1920x1080" selected>1080P</option><option value="2560x1440">2K</option></select></label><label>帧率<select id="screen-fps" :disabled="!connected || appStore.media.screenOn"><option value="30">30 FPS</option><option value="60">60 FPS</option></select></label><label>码率<select id="screen-bitrate" :disabled="!connected || appStore.media.screenOn"><option v-for="rate in [2500,5000,8000,15000,20000,25000,30000]" :key="rate" :value="rate" :selected="rate === 5000">{{ rate / 1000 }} Mbps</option></select></label><small>仅共享画面；程序声音单独开启。</small></section>
      </div>
      <button id="btn-app-audio" :disabled="!connected || !isTauriClient" :aria-pressed="appStore.media.appAudioSharing" @click="emit('app-audio-click')"><Music2 :size="18" /><span>{{ appStore.media.appAudioSharing ? '停止音频' : '程序音频' }}</span></button>
    </div>
    <div class="call-actions call-social-actions">
      <button :aria-pressed="!!soundboardStore.playing" title="一键喊话：试听、音量与快捷键" @click="soundboardStore.open = true"><Megaphone :size="18" /><span>一键喊话</span></button>
    </div>
    <div class="call-tools">
      <div class="dock-control-group" :class="{ 'popup-open': open === 'audio' }"><button :aria-expanded="open === 'audio'" @click="toggle('audio')"><SlidersHorizontal :size="18" /><span>音频调节</span></button>
        <section v-show="open === 'audio'" class="dock-popup audio-quick-popup" aria-label="我的音频调节"><header><strong>我的音频</strong><button aria-label="关闭音频调节" @click="open = ''"><X :size="16" /></button></header>
          <label>程序音频发送音量 <output>{{ Math.round(appStore.media.appAudioGain * 100) }}%</output><input type="range" min="0" max="300" :value="appStore.media.appAudioGain * 100" @input="emit('audio-gain', $event.target.value)"></label><small>调整所有接收者听到的程序声音。</small>
          <template v-if="appStore.media.micSource === 'rust'">
            <div class="quick-level" aria-label="麦克风输入电平"><span :style="{ width: appStore.media.micLevel + '%' }"></span><i :style="{ left: appStore.media.micThreshold + '%' }"></i></div>
            <label>收音阈值 <output>{{ appStore.media.micThreshold }}%</output><input type="range" min="0" max="100" :value="appStore.media.micThreshold" @input="emit('mic-setting', 'threshold', $event.target.value)"></label>
            <label>麦克风增益 <output>{{ appStore.media.micBoost.toFixed(1) }}×</output><input type="range" min="10" max="200" :value="appStore.media.micBoost * 10" @input="emit('mic-setting', 'boost', $event.target.value)"></label>
          </template><small v-else>当前麦克风使用自动增益与回声消除。</small>
          <button @click="open = ''; emit('open-settings', 'mic')">完整音频设置 →</button>
        </section>
      </div>
      <div class="dock-control-group"><button :disabled="!overlayStore.available || overlayStore.busy" :aria-pressed="overlayStore.status.visible" @click="emit('overlay-control', 'toggle')"><PictureInPicture2 :size="18" /><span>浮窗</span></button><button class="dock-caret" aria-label="浮窗设置" @click="emit('open-settings', 'overlay')"><ChevronUp :size="14" /></button></div>
      <button aria-label="外观设置" title="外观设置" @click="open = ''; emit('open-settings', 'appearance')"><Palette :size="18" /><span>外观</span></button>
      <button id="btn-leave" class="call-leave" :disabled="!connected && !appStore.connection.isInLobby" @click="emit('leave')"><PhoneOff :size="18" /><span>离开</span></button>
    </div>
    <p v-if="overlayStore.error" class="dock-error" role="status">{{ overlayStore.error }} <button @click="emit('open-settings', 'overlay')">查看浮窗设置</button></p>
  </footer>
</template>
