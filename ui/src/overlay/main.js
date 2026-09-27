import { createApp } from 'vue';
import OverlayApp from './OverlayApp.vue';
import '../assets/overlayTokens.css';
import './overlay.css';

// Dedicated entry: never imports App.vue, runtime.js or a media feature.
createApp(OverlayApp).mount('#app');
