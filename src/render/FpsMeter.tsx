// FPS HUD. Refreshes the DOM every 500ms (digits don't jitter), writes via
// ref (no React re-renders per frame). Visible only in dev (THESIS.md §38
// acceptance #8 — ≥60fps on M1 baseline; visible to verify, hidden in prod).
//
// Lifted from RubicsWorld with minor restyle. Lives outside src/nodes/** so
// the V2 purity lint rule does not apply — this is a UI overlay, not a node.

import { useEffect, useRef } from 'react';
import { useChromeStore } from '../app/stores/chromeStore';

export function FpsMeter() {
  const elRef = useRef<HTMLDivElement | null>(null);
  // Default OFF: the meter is a dev tool, not director chrome — a clean canvas
  // is the Spline target. A dev opts in via View ▸ Show FPS Meter. Still
  // dev-only: in prod it never renders (and the rAF loop never starts).
  const showFps = useChromeStore((s) => s.showFpsMeter);
  const visible = import.meta.env.DEV && showFps;

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    let frames = 0;
    let lastFlush = performance.now();
    let lastFrame = lastFlush;
    let worstMs = 0;

    const tick = () => {
      const now = performance.now();
      const dt = now - lastFrame;
      lastFrame = now;
      if (dt > worstMs) worstMs = dt;
      frames++;
      const sinceFlush = now - lastFlush;
      if (sinceFlush >= 500 && elRef.current) {
        const fps = (frames * 1000) / sinceFlush;
        const avgMs = sinceFlush / frames;
        elRef.current.textContent = `${fps.toFixed(0)} fps · ${avgMs.toFixed(1)} ms (worst ${worstMs.toFixed(1)})`;
        frames = 0;
        lastFlush = now;
        worstMs = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      ref={elRef}
      data-testid="fps-meter"
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 30,
        padding: '3px 8px',
        font: '10px/1.2 "JetBrains Mono", ui-monospace, monospace',
        color: '#5af07a',
        background: 'rgba(0,0,0,0.55)',
        borderRadius: 4,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      — fps —
    </div>
  );
}
