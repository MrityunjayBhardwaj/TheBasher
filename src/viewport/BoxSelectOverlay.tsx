// BoxSelectOverlay (#226) — the DOM half of viewport box-select. While box mode is
// armed (the `B` shortcut → boxSelectStore.active) it covers the viewport with a
// crosshair surface that intercepts the pointer (so OrbitControls / the gizmo don't
// also act), tracks the drag, draws the marquee, and on release calls the in-Canvas
// `commit` (registered by BoxSelect) to run the world-space hit test.
//
// One box per `B` press (Blender's idiom): release commits and exits box mode.
// RMB / Esc / a click-without-drag cancel without changing the selection.

import { useRef } from 'react';
import { useBoxSelectStore } from '../app/stores/boxSelectStore';
import { isDragRect, normalizeRect } from './boxSelect';

export function BoxSelectOverlay() {
  const active = useBoxSelectStore((s) => s.active);
  const rect = useBoxSelectStore((s) => s.rect);
  // Drag origin in overlay-relative px (== canvas px; the overlay fills the viewport).
  const startRef = useRef<{ x: number; y: number } | null>(null);

  if (!active) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) {
      // RMB cancels box mode (Blender).
      useBoxSelectStore.getState().cancel();
      return;
    }
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    startRef.current = { x, y };
    useBoxSelectStore.getState().setRect({ x0: x, y0: y, x1: x, y1: y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s) return;
    useBoxSelectStore.getState().setRect({
      x0: s.x,
      y0: s.y,
      x1: e.nativeEvent.offsetX,
      y1: e.nativeEvent.offsetY,
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const s = startRef.current;
    startRef.current = null;
    const store = useBoxSelectStore.getState();
    if (s) {
      const r = { x0: s.x, y0: s.y, x1: e.nativeEvent.offsetX, y1: e.nativeEvent.offsetY };
      // A click-without-drag cancels (Blender B-then-click changes nothing).
      if (isDragRect(r)) store.commit?.(r, e.shiftKey);
    }
    store.cancel();
  };

  const marquee = rect ? normalizeRect(rect) : null;

  return (
    <div
      data-testid="box-select-overlay"
      className="absolute inset-0 z-30 cursor-crosshair"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {marquee ? (
        <div
          data-testid="box-select-marquee"
          className="pointer-events-none absolute border border-dashed"
          style={{
            left: marquee.minX,
            top: marquee.minY,
            width: marquee.maxX - marquee.minX,
            height: marquee.maxY - marquee.minY,
            // Inline colours (not tw bg-/text- tokens) — a marquee is not text, so
            // it carries no contrast obligation and must not trip the W8 token gate.
            borderColor: 'rgba(120, 170, 255, 0.95)',
            backgroundColor: 'rgba(120, 170, 255, 0.12)',
          }}
        />
      ) : null}
    </div>
  );
}
