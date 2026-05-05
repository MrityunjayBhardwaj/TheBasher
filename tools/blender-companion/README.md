# Blender Companion (v0.5)

Live-link bridge: Blender writes GLB into a watched directory; Basher polls
the companion to know when something changed.

## Why a companion script

Browsers can't host HTTP servers, and Basher v0.5 is browser-first. So the
direction reverses from RubicsWorld's old beacon-from-page pattern:

- **Companion** (this script) hosts `GET /active` on `127.0.0.1:7777`.
- **Basher** polls `/__assets/active` (Vite dev middleware mocks this when
  the companion isn't running).

In v0.6 (Tauri), the desktop build will swap `BrowserBlenderBridge` for a
filesystem-watch implementation that reads the directory directly. Same
`BlenderBridgeCapability` interface; no other code changes.

## Quickstart

```bash
python3 tools/blender-companion/serve.py --assets-dir /path/to/scene_assets
```

In another terminal:

```bash
npm run dev
```

Open http://localhost:5173. The companion shows up as connected once
Basher's bridge ships its UI indicator (P1+).

## Protocol

```
GET /active → 200 {
  "ok": true,
  "source": "companion",
  "companionConnected": true,
  "assetsDir": "/path/to/scene_assets",
  "lastUpdate": 1746460800000   // ms since epoch, latest mtime in dir
}
```

## Production

The companion is a dev tool. The polling endpoint and the bridge itself are
both inert in production builds (verified by acceptance test #6).
