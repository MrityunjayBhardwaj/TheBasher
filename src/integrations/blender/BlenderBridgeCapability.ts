// BlenderBridgeCapability — interface that abstracts how Basher discovers
// what Blender is currently authoring.
//
// Browser cannot host HTTP servers, so the protocol reverses RubicsWorld's
// "beacon from page": the Blender addon runs a small Python http.server,
// Basher polls it. The browser bridge talks to /__assets/active (Vite dev
// middleware proxies/mocks; in production this endpoint does not exist —
// acceptance #6).
//
// V6 (capability interfaces): no caller imports a Tauri or Node-specific
// path. v0.6 will add `TauriBlenderBridge` for desktop builds.
//
// REF: THESIS.md §32, §33, dharana B5.

export interface BlenderBeaconState {
  /** True iff a companion server responded with companionConnected:true. */
  companionConnected: boolean;
  /** OS path of the active scene's asset directory (companion-side). */
  assetsDir: string | null;
  /** ms since-epoch of the companion's last write event. */
  lastUpdate: number | null;
  /** Where the response came from — for diagnostics. */
  source: 'companion' | 'vite-mock' | 'unknown';
}

export type BlenderBeaconListener = (state: BlenderBeaconState) => void;

export interface BlenderBridgeCapability {
  readonly id: string;
  readonly kind: 'browser-poll' | 'tauri-fs-watch' | 'noop';

  /** Begin polling. Idempotent — calling again is a no-op while running. */
  start(opts?: { intervalMs?: number }): void;
  /** Stop polling and clear listeners. */
  stop(): void;
  /** Latest known state, or null if start() has not been called. */
  current(): BlenderBeaconState | null;
  /** Subscribe to beacon updates; returns unsubscribe. */
  subscribe(listener: BlenderBeaconListener): () => void;
}
