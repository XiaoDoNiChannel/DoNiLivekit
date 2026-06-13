# Stage 9 - Code style, comments, and developer onboarding cleanup

This version is based on the Stage 8 frontend framework. It does **not** change the Rust backend, LiveKit publishing flow, 9001/9002 PCM WebSocket protocol, AudioWorklet processor, or channel-switch microphone recovery flow.

## What changed

- Added `src/shared/errors.js` for consistent error formatting, console logging, and user-facing alerts.
- Standardized comments in key modules so future developers can quickly understand module boundaries.
- Improved error messages around:
  - Rust microphone 9002 pipeline initialization.
  - App-audio 9001 pipeline initialization.
  - Microphone and output device switching.
  - Room/channel connection failures.
  - Screen share fallback and failure paths.
  - LiveKit data-channel parse failures.
- Added `.editorconfig` to keep formatting consistent across editors.
- Added `PROJECT_GUIDE.md` for onboarding and long-term feature development.
- Added `src/features/README.md` and `src/shared/README.md` for module-level guidance.

## Architecture rules preserved

- `legacy/client.js` remains a compatibility entry only.
- `app/runtime.js` remains the composition root.
- `features/` owns business actions and runtime side effects.
- `stores/` owns lightweight state snapshots only.
- `components/` owns UI structure and user events.
- `shared/` owns pure helpers and constants.

## Checks performed

```bash
find src -name '*.js' -print0 | xargs -0 -n1 node --check
npm run build
```

Both checks passed.

## Local regression checklist

After replacing files, run:

```powershell
cd F:\livekit_pack
npx tauri dev
```

Then test:

1. App starts in Tauri.
2. Lobby can be entered.
3. Auto-join first voice channel still works.
4. Rust microphone publishes through 9002.
5. VAD green bar moves normally.
6. Switching channels restores microphone state.
7. Microphone device switching works.
8. Audio output switching works.
9. App-audio sharing works through 9001.
10. Screen share works.
11. Chat send/receive works.
12. Leave room releases resources.
