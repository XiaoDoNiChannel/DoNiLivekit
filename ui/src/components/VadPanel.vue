<template>
  <!--
    Rust 麦克风阈值与增益控制面板。
    输入事件仍在 initLegacyDom() 中绑定到 Tauri invoke：
    - set_mic_vad_threshold
    - set_mic_boost
    这里先只负责稳定保留 DOM 结构和 id。
  -->
  <div
    id="vad-module"
    class="vad-container"
    style="display: none; margin: 15px 0; padding: 15px; background: #1e1f22; border-radius: 8px; border: 1px solid #3b3d44;"
  >
    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #b5bac1; margin-bottom: 12px; font-weight: 600;">
      <span>收音阈值（点击监听预览） </span>
      <span id="vad-threshold-text">20%</span>
    </div>

    <div style="position: relative; height: 16px; background: #313338; border-radius: 8px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);">
      <div id="vad-fill-bar" style="height: 100%; width: 0%; background: #23a559; border-radius: 8px; transition: width 0.05s linear;"></div>
      <div id="vad-threshold-marker" style="position: absolute; top: -2px; bottom: -2px; width: 3px; background: #faa61a; box-shadow: 0 0 6px #faa61a; z-index: 2; pointer-events: none; left: 20%;"></div>
      <input
        id="vad-slider-input"
        type="range"
        min="0"
        max="100"
        value="20"
        style="position: absolute; top: -4px; left: 0; width: 100%; height: 24px; margin: 0; opacity: 0; z-index: 3; cursor: pointer;"
      >
    </div>

    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #b5bac1; margin-top: 20px; margin-bottom: 12px; font-weight: 600;">
      <span>麦克风增益（默认5.0）</span>
      <span id="vad-boost-text">5.0x</span>
    </div>

    <div style="position: relative; height: 16px;">
      <input
        id="vad-boost-input"
        type="range"
        class="volume-slider"
        min="10"
        max="200"
        value="50"
        style="width: 100%; cursor: pointer;"
      >
    </div>
  </div>
</template>
