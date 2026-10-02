# Codex Router desktop preview

React UI + Tauri Windows host. See the [project README](../../README.md) and [build guide](../../docs/building.md) for current capabilities, limitations and runtime packaging.

```powershell
npm ci
npm test
npm run build
```

`npm run dev` is a browser-only interaction preview, not a connection to the real Router. The bundled Tauri application uses a restricted stdio bridge to the local Node runtime. Do not point an untrusted renderer at credentials or user configuration.

Phosphor icon attribution is preserved in `src-tauri/icons/LICENSE-Phosphor.txt`.
