// Clock — runs requestAnimationFrame and dispatches deltas into timeStore
// when the playhead is playing.
//
// File-rooted in `src/app/` (not `src/viewport/`) so V8 stays clean: this
// component invokes `useTimeStore.tick(delta)` which is a UI-projection
// store mutation, not a DAG dispatch. The DAG store remains untouched by
// playback.
//
// Mounting: rendered exactly once at App root (alongside Layout). The rAF
// loop runs even when paused — it just no-ops in `tick` — so the cost of
// running while idle is a single `getState().playing` read per frame.
//
// REF: THESIS.md §49, vyapti V8, krama K1.

import { useEffect, useRef } from 'react';
import { useTimeStore } from './stores/timeStore';

export function Clock() {
  const lastRef = useRef<number | null>(null);
  useEffect(() => {
    let rafId = 0;
    function loop(now: number) {
      const last = lastRef.current;
      if (last !== null) {
        const delta = (now - last) / 1000;
        // Cap to 100ms — a stalled tab shouldn't fast-forward the playhead
        // 30 seconds when it regains focus.
        const safeDelta = Math.min(0.1, Math.max(0, delta));
        useTimeStore.getState().tick(safeDelta);
      }
      lastRef.current = now;
      rafId = requestAnimationFrame(loop);
    }
    rafId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafId);
      lastRef.current = null;
    };
  }, []);
  return null;
}
