<script setup>
defineEmits(['close', 'confirm']);
</script>

<template>
  <!--
    应用音频选择弹窗。
    进程列表由 appAudio.js 动态写入 #app-audio-process-list；
    这里保留原 id 和 class，保证 9001 应用音频共享链路不变。
  -->
  <div id="app-audio-modal" class="modal hidden" @click="$emit('close', $event)">
    <div class="modal-card" @click.stop>
      <div class="modal-header">
        <div class="modal-title">🎯 选择要共享音频的应用</div>
        <button class="modal-close" @click="$emit('close')">✕</button>
      </div>
      <div class="modal-subtitle">仅展示可识别名称的活跃进程，点击后将开始截流并推送到房间。</div>
      <div id="app-audio-process-list" class="modal-list"></div>
      <div class="modal-footer">
        <button id="btn-confirm-app-audio" class="primary-btn" @click="$emit('confirm')">开始共享所选应用</button>
      </div>
    </div>
  </div>
</template>
