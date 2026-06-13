# DoNiChannel Frontend

This directory contains the Vue 3 frontend for DoNiChannel. It runs inside Tauri and talks to the Rust backend through Tauri commands plus two local PCM WebSocket channels:

- `127.0.0.1:9001` for application audio sharing.
- `127.0.0.1:9002` for Rust microphone audio.

Start the app from the project root:

```powershell
cd F:\livekit_pack
npx tauri dev
```

Frontend-only development is possible with:

```powershell
cd F:\livekit_pack\ui
npm run dev
```

Read [`PROJECT_GUIDE.md`](./PROJECT_GUIDE.md) before adding new features.
