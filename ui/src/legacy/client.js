// Legacy compatibility entry.
//
// Stage 8 后，真正的前端运行时已经移动到 ../app/runtime.js。
// 保留这个文件是为了兼容旧 import 路径和少量 window.xxx 调用。
// 新功能请优先从 src/app/runtime.js 或 stores/features 中接入，不要继续把业务堆回这里。

export * from '../app/runtime.js';
