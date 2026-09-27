<script setup>
import { computed } from 'vue';
const props = defineProps({ points: { type: Array, required: true }, field: { type: String, required: true }, label: String, unit: String });
const valid = computed(() => props.points.map(point => point[props.field]).filter(Number.isFinite));
const peak = computed(() => valid.value.length ? Math.max(...valid.value) : null);
const ceiling = computed(() => Math.max(1, peak.value || 0));
const path = computed(() => {
  const end = props.points.at(-1)?.time || 0;
  let drawing = false;
  return props.points.map(point => {
    const value = point[props.field];
    if (!Number.isFinite(value)) { drawing = false; return ''; }
    const x = 4 + Math.max(0, 1 - (end - point.time) / 120000) * 252;
    const y = 54 - value / ceiling.value * 46;
    const segment = `${drawing ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    drawing = true;
    return segment;
  }).join(' ');
});
</script>

<template>
  <figure class="diagnostic-trend">
    <figcaption><span>{{ label }}</span><span>{{ valid.length ? `最高 ${peak.toFixed(1)} ${unit}` : '等待有效采样' }}</span></figcaption>
    <svg viewBox="0 0 260 62" role="img" :aria-label="`${label}，最近两分钟趋势${valid.length ? '' : '，暂无数据'}`">
      <line x1="4" y1="54" x2="256" y2="54" class="trend-baseline" />
      <path v-if="valid.length > 1" :d="path" class="trend-line" />
      <circle v-else-if="valid.length === 1" cx="256" :cy="54 - valid[0] / ceiling * 46" r="2" class="trend-point" />
    </svg>
    <div class="trend-time"><span>2 分钟前</span><span>最近采样</span></div>
  </figure>
</template>
