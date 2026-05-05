#!/usr/bin/env python3
"""
Blender companion script — Basher v0.5.

Browsers cannot host HTTP servers, so the addon flips the live-link
direction: this script (or a Blender addon, eventually) hosts a tiny
HTTP server on localhost:7777, and Basher polls it.

What it serves
--------------
GET /active
    JSON describing the currently-active Blender scene's asset directory.
    Basher's BrowserBlenderBridge expects this exact shape:

        {
          "ok": true,
          "source": "companion",
          "companionConnected": true,
          "assetsDir": "/path/to/scene_assets",
          "lastUpdate": 1746460800000
        }

How Basher reaches it
---------------------
In dev, Vite's vite-plugin-blender-mock plugin serves a same-origin
fallback at /__assets/active so the polling loop has something to talk
to even when this companion is not running. The plugin does NOT proxy to
this script in v0.5 — it just returns companionConnected:false.

For v0.5 testing, run this script alongside `npm run dev`. The Vite
plugin will need a small extension (or a manual proxy in vite.config.ts)
to forward /__assets/active here when this script is up — landing in P1
once the asset library actually consumes the data.

Production
----------
In a production build, /__assets/active does not exist; the browser
bridge stays dormant (acceptance #6). This script is a developer tool,
never bundled.

Usage
-----
    python3 tools/blender-companion/serve.py [--assets-dir /path/to/dir]

Then run Blender's GLB exporter targeting the same directory; touching
files updates `lastUpdate`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional


PORT_DEFAULT = 7777


def _state(assets_dir: Optional[str]) -> dict:
    last_update: Optional[int] = None
    if assets_dir and os.path.isdir(assets_dir):
        latest = 0.0
        for entry in os.scandir(assets_dir):
            if entry.is_file():
                try:
                    latest = max(latest, entry.stat().st_mtime)
                except OSError:
                    continue
        if latest > 0:
            last_update = int(latest * 1000)
    return {
        "ok": True,
        "source": "companion",
        "companionConnected": True,
        "assetsDir": assets_dir,
        "lastUpdate": last_update,
    }


def make_handler(assets_dir: Optional[str]):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler API)
            if self.path != "/active":
                self.send_response(404)
                self.end_headers()
                return
            payload = json.dumps(_state(assets_dir)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            # Allow Basher's dev server to read us without a proxy.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args, **_kwargs):
            return  # silent — keep stdout clean for `npm run dev` companion logs

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(prog="blender-companion")
    parser.add_argument("--port", type=int, default=PORT_DEFAULT)
    parser.add_argument("--assets-dir", type=str, default=None)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.assets_dir))
    print(
        f"basher companion: http://127.0.0.1:{args.port}/active "
        f"(assets={args.assets_dir or '<unset>'})"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("basher companion: shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
