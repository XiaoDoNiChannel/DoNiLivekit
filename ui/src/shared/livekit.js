import * as LivekitClient from 'livekit-client';

// Central adapter: feature modules keep receiving the same LivekitClient shape,
// while the SDK is bundled by Vite and remains available without internet access.
export { LivekitClient };
