// BrowserBlenderBridge — the v0.5 browser implementation. Polls
// /__assets/active every 2s. The endpoint is served by the Vite dev-only
// middleware (vite-plugin-blender-mock); in production the route 404s, and
// `start()` early-returns when `import.meta.env.DEV` is false so the bridge
// is silently inert instead of spamming the network.
//
// Silent-failure surface (dharana B5):
//   • addon server not running → bridge reports companionConnected:false
//     but stays alive for retries. UI shows the disconnected indicator
//     instead of "Blender connected".
//   • CORS misconfig — same-origin fetch through Vite middleware avoids
//     this in dev; native companion (v0.6) will need explicit CORS allow.
//   • Wrong asset folder — companion reports its assetsDir; UI surfaces it
//     so the user can confirm.
//
// REF: THESIS.md §32, dharana B5.

import type {
  BlenderBeaconListener,
  BlenderBeaconState,
  BlenderBridgeCapability,
} from './BlenderBridgeCapability';

const DEFAULT_INTERVAL_MS = 2000;
const ENDPOINT = '/__assets/active';

export class BrowserBlenderBridge implements BlenderBridgeCapability {
  readonly id = 'browser-poll';
  readonly kind = 'browser-poll' as const;

  private timer: ReturnType<typeof setInterval> | null = null;
  private state: BlenderBeaconState | null = null;
  private listeners = new Set<BlenderBeaconListener>();

  start(opts?: { intervalMs?: number }): void {
    if (this.timer !== null) return;
    if (typeof window === 'undefined') return;
    if (!import.meta.env.DEV) return; // production: bridge is inert
    const interval = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    void this.tick(); // run once immediately so first state is fresh
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  current(): BlenderBeaconState | null {
    return this.state;
  }

  subscribe(listener: BlenderBeaconListener): () => void {
    this.listeners.add(listener);
    if (this.state) listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async tick(): Promise<void> {
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' });
      if (!res.ok) {
        this.update({
          companionConnected: false,
          assetsDir: null,
          lastUpdate: null,
          source: 'unknown',
        });
        return;
      }
      const json = (await res.json()) as Partial<BlenderBeaconState>;
      this.update({
        companionConnected: !!json.companionConnected,
        assetsDir: json.assetsDir ?? null,
        lastUpdate: json.lastUpdate ?? null,
        source: (json.source as BlenderBeaconState['source']) ?? 'vite-mock',
      });
    } catch {
      this.update({
        companionConnected: false,
        assetsDir: null,
        lastUpdate: null,
        source: 'unknown',
      });
    }
  }

  private update(next: BlenderBeaconState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }
}
