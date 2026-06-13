# DoNiChannel Developer Guide

This guide describes the frontend architecture after the Stage 9 cleanup. It is intended for future developers who need to add features without turning the project back into a single-file legacy frontend.

## 1. Architecture

The frontend is intentionally split into four layers:

```text
src/
├─ app/          Runtime assembly and compatibility exports
├─ stores/       Lightweight UI/state snapshots
├─ features/     Business logic and integration with LiveKit/Tauri/WebAudio
├─ components/   Vue components and layout
├─ shared/       Pure utilities, constants, Tauri wrappers, error helpers
└─ legacy/       Compatibility entry only; do not add new business logic here
```

### `app/runtime.js`

The runtime is the composition root. It creates feature modules, wires dependencies, exposes actions for Vue components, and keeps a light store snapshot in sync. Runtime may coordinate modules, but it should not become a new business-logic dump.

### `features/`

Feature modules own business actions:

- `roomConnection.js`: lobby, channel list, room connect/disconnect, channel switch recovery.
- `rustMic.js`: Rust microphone publish/unpublish and mic error handling.
- `audioPipelines.js`: 9001/9002 WebSocket PCM, AudioWorklet, MediaStreamTrack lifecycle.
- `appAudio.js`: process selection and app-audio publishing.
- `screenShare.js`: screen share publishing, local preview, bitrate monitor.
- `livekitEvents.js`: LiveKit room events and remote track attachment.
- `participants.js`: participant list rendering and active-speaker UI.
- `remoteAudio.js`: GainNode routing and per-user volume.
- `devices.js`: microphone and audio output devices.
- `chat.js`: local chat send/render.

Feature modules may call Tauri, LiveKit, AudioContext, and update store snapshots through runtime callbacks. Avoid adding large UI templates here unless the module is still in a legacy DOM compatibility zone.

### `stores/`

`stores/appStore.js` is a lightweight state snapshot for new Vue-side features. Do not store heavy runtime objects such as `LiveKit.Room`, `AudioContext`, `MediaStreamTrack`, or WebSocket instances in stores. Keep those in feature modules.

### `components/`

Vue components own UI structure and events. They should emit user actions and receive/observe state. They should not directly call Tauri commands, construct LiveKit rooms, or manage AudioContext lifecycle.

### `legacy/`

`legacy/client.js` exists only so older imports keep working. New features must not be added there.

## 2. Golden rules for new features

1. **UI goes in `components/`.**
2. **Business actions go in `features/`.**
3. **Shared helpers go in `shared/`.**
4. **State snapshots go in `stores/`.**
5. **Do not add new logic to `legacy/client.js`.**
6. **Do not rewrite 9001/9002 audio pipelines casually.** They are intentionally isolated and should be tested after every change.
7. **Keep error messages actionable.** Use `shared/errors.js` for consistent logs and user-facing alerts.

## 3. Adding a feature

Example: adding an audio settings modal.

```text
src/components/modals/AudioSettingsModal.vue
src/features/audioSettings.js
src/stores/appStore.js        // add lightweight state only
src/app/runtime.js            // wire feature actions to components
```

Recommended flow:

1. Add state fields to `appStore` only if UI needs to react to them.
2. Add business actions in a feature module.
3. Add or update Vue components.
4. Wire actions in `app/runtime.js`.
5. Run the full regression checklist below.

## 4. Error handling conventions

Use these helpers from `src/shared/errors.js`:

```js
import { getErrorMessage, logError, alertError } from '../shared/errors.js';

try {
    await doSomething();
} catch (error) {
    logError('设备设置/切换麦克风', error);
    alertError('切换麦克风失败', error, '设备可能已被拔出或被其他程序独占。');
}
```

Console messages should include the module and action, for example:

```text
[roomConnection] 连接频道失败: token service returned 500
[rustMic] 启动 Rust 麦克风失败: ws://127.0.0.1:9002 timeout
```

## 5. Regression checklist

Run this checklist after every structural change:

1. App starts in Tauri.
2. Lobby can be entered.
3. The app auto-joins the first voice channel if enabled.
4. Rust microphone publishes correctly.
5. VAD green bar moves normally.
6. Switching channels restores microphone state.
7. Microphone device selection works.
8. Audio output device switching works.
9. App-audio sharing works through 9001.
10. Screen share works, including preview and stop flow.
11. Chat send/receive works.
12. Leave room releases local resources.

## 6. Commands

```powershell
# Frontend build check
cd F:\livekit_pack\ui
npm run build

# Full Tauri development run
cd F:\livekit_pack
npx tauri dev
```

## 7. Known compatibility notes

Some components still preserve fixed DOM IDs because LiveKit callbacks and legacy DOM rendering use them. This is intentional. Future pure-Vue migration should move one area at a time, starting with low-risk UI such as channel list or chat messages, not the Rust microphone pipeline.
