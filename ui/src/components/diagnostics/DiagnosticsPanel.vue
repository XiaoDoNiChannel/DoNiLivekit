<script setup>
import { computed } from 'vue';
import { Activity, Flag, Monitor, Radio, Clock3 } from 'lucide-vue-next';
import { diagnosticsStore as state } from '../../stores/diagnosticsStore.js';
import DiagnosticTrend from './DiagnosticTrend.vue';

const emit = defineEmits(['mark']);
const format = (value, unit = '', digits = 0) => Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '—';
const timeText = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const audioRows = computed(() => [
  { label: '语音', value: state.voice },
  { label: '共享音频', value: state.sharedAudio },
]);
const availabilityText = computed(() => {
  if (state.connection === 'reconnecting') return '正在重连，恢复后重新采样。';
  if (state.connection !== 'connected') return '连接频道后自动采集；历史事件保留至退出应用。';
  if (state.availability === 'unavailable') return '当前环境未返回可用统计，暂时无法判断质量。';
  if (state.availability === 'idle') return '暂无活动媒体轨道，开麦或接收共享后开始采集。';
  if (state.partial) return '部分轨道统计缺失，未返回的指标以 — 显示。';
  return '约每 2 秒更新；收起面板后继续记录。';
});
function limitationText(screen) {
  if (screen.direction === 'receive') return '发送端设置与编码限制在接收端不可见';
  const labels = { cpu: 'CPU 限制', bandwidth: '带宽限制', none: '未报告编码限制', other: '其他限制（原因未明）' };
  return screen.limitations.length ? screen.limitations.map(reason => labels[reason] || '未知限制').join(' / ') : '编码限制字段未提供';
}
const screenHistory = key => state.history.map(point => ({ time: point.time, fps: point.screens?.find(screen => screen.key === key)?.fps ?? null }));
const screenBitrate = screen => {
  const value = screen.direction === 'send' ? screen.txKbps : screen.rxKbps;
  return Number.isFinite(value) ? value / 1000 : null;
};
</script>

<template>
  <section id="call-diagnostics" class="diagnostics-panel" :class="{ 'has-diagnostic-data': state.availability === 'ready' }" aria-label="通话诊断">
    <header class="diagnostics-heading"><div><h2>通话诊断</h2><p>{{ state.channel || '等待加入频道' }}</p></div>
      <button class="diagnostic-mark" :disabled="state.connection !== 'connected'" title="标记当前时刻，便于回看卡顿前后记录" @click="emit('mark')"><Flag :size="14" aria-hidden="true" />刚才卡了</button>
    </header>
    <div class="diagnostic-compact-summary"><span>RTT <strong>{{ format(state.rttMs, ' ms') }}</strong></span><span>语音丢包 <strong>{{ format(state.voice?.lossPercent, '%', 1) }}</strong></span><span>共享轨道 <strong>{{ state.screens.length }}</strong></span></div>
    <p class="diagnostic-help" role="status">{{ availabilityText }}</p>

    <div v-for="issue in state.issues" :key="issue.key" class="diagnostic-issue">
      <strong>{{ issue.title }}</strong><p>{{ issue.detail }}</p><p>{{ issue.advice }}</p>
    </div>

    <section class="diagnostic-section">
      <h3><Activity :size="15" aria-hidden="true" />网络与语音</h3>
      <div class="diagnostic-primary-metric"><span>通话链路 RTT</span><strong>{{ format(state.rttMs, ' ms') }}</strong></div>
      <p class="diagnostic-help">到媒体服务器的往返时间，不等同于声音传到队友的延迟。</p>
      <div v-for="row in audioRows" :key="row.label" class="diagnostic-audio-row">
        <h4><Radio :size="13" aria-hidden="true" />{{ row.label }}<span>{{ row.value?.tracks ? `${row.value.tracks} 条轨道` : '暂无轨道' }}</span></h4>
        <dl class="diagnostic-metrics">
          <div><dt>接收丢包 · 近 10 秒</dt><dd>{{ format(row.value?.lossPercent, '%', 1) }}</dd></div>
          <div><dt>接收抖动</dt><dd>{{ format(row.value?.jitterMs, ' ms', 1) }}</dd></div>
          <div><dt>实际发送</dt><dd>{{ format(row.value?.txKbps, ' kbps', 1) }}</dd></div>
          <div><dt>实际接收</dt><dd>{{ format(row.value?.rxKbps, ' kbps', 1) }}</dd></div>
        </dl>
      </div>
      <details class="diagnostic-details"><summary>最近 2 分钟趋势</summary>
        <DiagnosticTrend :points="state.history" field="rttMs" label="链路 RTT" unit="ms" />
        <DiagnosticTrend :points="state.history" field="lossPercent" label="语音接收丢包" unit="%" />
        <DiagnosticTrend v-if="state.sharedAudio?.tracks" :points="state.history" field="sharedAudioLoss" label="共享音频接收丢包" unit="%" />
      </details>
    </section>

    <section class="diagnostic-section">
      <h3><Monitor :size="15" aria-hidden="true" />共享画面</h3>
      <p v-if="!state.screens.length" class="diagnostic-help">{{ state.connection === 'connected' ? '当前没有正在发送或接收的共享画面。' : '连接后显示共享轨道统计。' }}</p>
      <article v-for="screen in state.screens" :key="screen.key" class="diagnostic-screen">
        <h4>{{ screen.name }}<span>{{ screen.direction === 'send' ? '发送端' : '接收端' }}</span></h4>
        <p v-if="!screen.available" class="diagnostic-help">此轨道未返回可用统计。</p>
        <dl class="diagnostic-metrics">
          <div><dt>{{ screen.direction === 'send' ? '目标分辨率' : '对方目标' }}</dt><dd>{{ screen.target ? `${screen.target.width} × ${screen.target.height}` : '不可用' }}</dd></div>
          <div><dt>{{ screen.direction === 'send' ? '实际发送分辨率' : '实际接收分辨率' }}</dt><dd>{{ screen.dimensions ? `${screen.dimensions.width} × ${screen.dimensions.height}` : '—' }}</dd></div>
          <div><dt>目标帧率上限</dt><dd>{{ format(screen.target?.fps, ' fps') }}</dd></div>
          <div><dt>{{ screen.direction === 'send' ? '实际发送帧率' : '实际解码帧率' }}</dt><dd>{{ format(screen.fps, ' fps', 1) }}</dd></div>
          <div><dt>目标码率上限</dt><dd>{{ format(screen.target?.bitrateKbps / 1000, ' Mbps', 1) }}</dd></div>
          <div><dt>{{ screen.direction === 'send' ? '实际发送码率' : '实际接收码率' }}</dt><dd>{{ format(screenBitrate(screen), ' Mbps', 2) }}</dd></div>
          <template v-if="screen.direction === 'receive'"><div><dt>接收丢包 · 近 10 秒</dt><dd>{{ format(screen.lossPercent, '%', 1) }}</dd></div><div><dt>冻结次数 · 近 10 秒</dt><dd>{{ format(screen.freezes, ' 次') }}</dd></div></template>
        </dl>
        <p class="diagnostic-help">{{ limitationText(screen) }}</p>
        <p class="diagnostic-help">静止画面可能降低帧率；低于设置上限不一定代表故障。</p>
        <details class="diagnostic-details"><summary>最近 2 分钟帧率</summary><DiagnosticTrend :points="screenHistory(screen.key)" field="fps" label="实际共享帧率" unit="fps" /></details>
      </article>
    </section>

    <section class="diagnostic-section diagnostic-timeline">
      <h3><Clock3 :size="15" aria-hidden="true" />故障与会话时间线<span>{{ state.events.length }} 条</span></h3>
      <p v-if="!state.events.length" class="diagnostic-help">连接、重连、共享变化及持续异常会记录在这里。</p>
      <ol><li v-for="event in state.events" :key="event.id" :class="event.type">
        <div class="diagnostic-event-meta"><time :datetime="new Date(event.time).toISOString()">{{ timeText(event.time) }}</time><span>{{ event.channel }}</span></div>
        <strong>{{ event.title }}</strong><p v-if="event.detail">{{ event.detail }}</p>
      </li></ol>
    </section>
    <footer class="diagnostic-help">启动不足 10 秒时使用已采集区间。— 表示未提供或尚未形成有效样本；不会当作 0。仅在本次运行中保留最近 100 条事件，不记录音视频内容。</footer>
  </section>
</template>
