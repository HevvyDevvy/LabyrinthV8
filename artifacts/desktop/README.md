# LabyrinthV8 Desktop

Wraps the existing dashboard (`artifacts/labyrinthv8`) and API server
(`artifacts/api-server`) into an installable desktop app. The key
difference from the GitHub Pages + Render deployment: the API server runs
**locally**, as a child process of the Electron app, so "full-system scan"
in the dashboard walks the machine the app is actually installed on.

## How it works

- `electron-main.cjs` starts the built API server (`api-server/dist/index.mjs`)
  as a local child process on a free port, bound to `127.0.0.1` only.
- That server is pointed at the built dashboard via `LABYRINTH_STATIC_DIR`,
  so one local server hosts both the UI and the `/api/*` routes — same
  origin, no CORS involved.
- App data (requests, audit log, keystore) is stored under Electron's
  per-OS user data directory, not inside the app bundle.

## Local development

```
pnpm install
pnpm --filter @workspace/desktop run dev
```

This builds the API server and dashboard, stages them, and launches the
Electron window pointed at the local server.

## Building an installer

```
pnpm --filter @workspace/desktop run dist
```

Outputs land in `artifacts/desktop/release/`. Platform-specific installers
(`.dmg`, `.exe`/NSIS, `.AppImage`/`.deb`) can only be *fully* built on their
own OS — electron-builder can cross-compile some targets, but macOS builds
in particular need to run on macOS. See `.github/workflows/build-desktop.yml`
for a CI matrix that builds all three.

## Known gaps

- **Not code-signed.** Windows SmartScreen and macOS Gatekeeper will both
  warn on install until you add a real code-signing certificate (paid, for
  both platforms) and wire `CSC_LINK`/`CSC_KEY_PASSWORD` into the workflow.
- ~~Placeholder icon~~ / ~~`labyrinth-lock.png` screenshot~~ — fixed. Both
  `build-resources/icon.png` (app icon, all three platforms) and
  `artifacts/labyrinthv8/public/labyrinth-lock.png` (in-app sidebar emblem +
  background) now use the same cropped circular lock-and-maze mark, with the
  original screenshot's status bar, nav buttons, and stray "X" overlay
  removed. It's still upscaled from a fairly small, slightly soft source
  image (the original screenshot was 540×1092), so it won't be perfectly
  crisp at large sizes (e.g. a macOS dock icon at 512px) — worth swapping
  for a vector or higher-resolution source if one becomes available.
