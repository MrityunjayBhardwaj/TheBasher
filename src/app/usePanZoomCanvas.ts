// usePanZoomCanvas — the ONE pan/zoom primitive for the 2D View's canvases
// (the UV layout and the Render Result image). Blender's Image Editor lets you
// scroll-zoom toward the cursor, drag to pan, and Home/double-click to fit;
// both the UV and Render panes need exactly that, so the interaction lives in
// ONE hook they both consume (never duplicated per pane — the V34/V45 "one
// home" face applied to canvas navigation).
//
// The hook owns ALL the canvas boilerplate: DPR sizing, the ResizeObserver, and
// the view transform. A pane supplies only a `draw(ctx, cssW, cssH, zoom)` that
// paints its content in CSS-pixel space (the fit-to-view layout it already
// had); the hook applies pan/zoom ON TOP, so the identity transform (zoom 1,
// pan 0) is byte-identical to the old fit-only draw. `zoom` is passed so a pane
// can keep hairlines/labels crisp (divide by zoom) while its image/texture
// content scales.
//
// View model (CSS px): screen = content * zoom + pan. Wheel zooms toward the
// cursor (the point under the pointer stays fixed); drag (left OR middle button)
// pans; double-click resets to fit. State lives in a ref + imperative repaint —
// no React re-render per wheel tick, so it stays smooth.
//
// File-rooted V8: src/app/. Pure UI projection — never touches the DAG.

import { useCallback, useEffect, useRef } from 'react';

export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

const IDENTITY: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 40;
const WHEEL_SENSITIVITY = 0.0015;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export type PanZoomDraw = (
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  zoom: number,
) => void;

export function usePanZoomCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  draw: PanZoomDraw,
): { reset: () => void } {
  const view = useRef<ViewTransform>({ ...IDENTITY });
  // Latest draw, read at paint time — repaint stays stable (no per-content
  // listener teardown).
  const drawRef = useRef<PanZoomDraw>(draw);
  drawRef.current = draw;

  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const W = Math.floor(r.width * dpr);
    const H = Math.floor(r.height * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const { zoom, panX, panY } = view.current;
    // dpr → CSS-px space, then pan/zoom on top. The pane draws in CSS px.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);
    drawRef.current(ctx, r.width, r.height, zoom);
  }, [canvasRef]);

  const reset = useCallback(() => {
    view.current = { ...IDENTITY };
    repaint();
  }, [repaint]);

  // Repaint when the pane's content (its draw closure) changes.
  useEffect(() => {
    repaint();
  }, [draw, repaint]);

  // ResizeObserver — initial mount, parent resize, and the display:none → block
  // transition on tab/space switch (the box jumps 0×0 → real size).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => repaint());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef, repaint]);

  // Wheel (zoom-to-cursor) + pointer (pan) + double-click (fit). Native, with
  // a non-passive wheel listener so preventDefault stops the page from
  // scrolling under the zoom.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let drag: { x: number; y: number } | null = null;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const t = view.current;
      const z = clamp(t.zoom * Math.exp(-e.deltaY * WHEEL_SENSITIVITY), MIN_ZOOM, MAX_ZOOM);
      const k = z / t.zoom;
      // Keep the point under the cursor fixed: pan' = c - (c - pan) * k.
      view.current = {
        zoom: z,
        panX: cx - (cx - t.panX) * k,
        panY: cy - (cy - t.panY) * k,
      };
      repaint();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return; // left or middle = pan
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag) return;
      view.current.panX += e.clientX - drag.x;
      view.current.panY += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      repaint();
    };
    const endDrag = (e: PointerEvent) => {
      if (!drag) return;
      drag = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      canvas.style.cursor = '';
    };
    const onDblClick = () => reset();

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', onDblClick);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }, [canvasRef, repaint, reset]);

  return { reset };
}
