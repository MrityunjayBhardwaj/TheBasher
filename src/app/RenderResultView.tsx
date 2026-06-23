// RenderResultView — the "Render Result" pane of the unified 2D View
// (Blender's Image Editor → Render Result). A 2D HTML canvas that draws the
// most-recent still render (#168), letterbox-fit. Read-only viewer; never
// touches the DAG (file-rooted V8).
//
// The render itself runs through renderActiveProjectToDataUrl() — the SAME
// production-camera offscreen path the download action uses — so what shows
// here is byte-identical to what "Render Image" saves (viewport==render,
// V37/V51). The result is parked in renderResultStore so it survives a
// tab/space switch (the pane is display:none, not unmounted) and so the fal
// AI edit (follow-up) can write a new image into the same slot.

import { useEffect, useRef } from 'react';
import { downloadRenderResult, renderActiveProjectToView } from './renderImageAction';
import { useRenderResultStore } from './stores/renderResultStore';

export function RenderResultView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const status = useRenderResultStore((s) => s.status);
  const dataUrl = useRenderResultStore((s) => s.dataUrl);
  const width = useRenderResultStore((s) => s.width);
  const height = useRenderResultStore((s) => s.height);
  const source = useRenderResultStore((s) => s.source);
  const error = useRenderResultStore((s) => s.error);

  const rendering = status === 'rendering';
  const hasResult = status === 'ready' && dataUrl !== null;

  // Repaint the canvas: fit the decoded image (imageRef) into the box,
  // letterboxed. ResizeObserver covers initial mount, resizes, and the
  // display:none → block transition on tab/space switch (the box jumps from
  // 0×0 to its real size, firing the observer) — same trick as UVEditor.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const repaint = () => {
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
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      drawRenderResult(ctx, r.width, r.height, imageRef.current);
    };
    repaint();
    const ro = new ResizeObserver(repaint);
    ro.observe(canvas);
    return () => ro.disconnect();
    // Re-run on dataUrl/status so the observer + initial repaint re-fire after
    // the image element is swapped (the actual draw uses the imageRef set by
    // the load effect below). drawRenderResult is module-level (stable).
  }, [dataUrl, status]);

  // Decode the data URL into an <img> off-DOM, then repaint when it loads.
  useEffect(() => {
    if (!dataUrl) {
      imageRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      drawRenderResult(ctx, r.width, r.height, img);
    };
    img.src = dataUrl;
    return () => {
      img.onload = null;
    };
  }, [dataUrl]);

  const dims = width > 0 && height > 0 ? `${width}×${height}` : '';
  const statusText =
    status === 'rendering'
      ? 'Rendering…'
      : status === 'error'
        ? (error ?? 'Render failed.')
        : status === 'ready'
          ? `${dims}${source === 'ai' ? ' · AI' : ''}`
          : 'No render yet — press Render.';

  return (
    <div data-testid="render-result-view" className="flex h-full w-full flex-col bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-fg/70">
        <span className="flex items-center gap-2">
          <span>Render Result</span>
          <button
            type="button"
            data-testid="render-result-render"
            disabled={rendering}
            onClick={() => void renderActiveProjectToView()}
            className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] normal-case text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
            title="Render the production frame at the current playhead"
          >
            {rendering ? 'Rendering…' : 'Render'}
          </button>
          <button
            type="button"
            data-testid="render-result-save"
            disabled={!hasResult}
            onClick={() => void downloadRenderResult()}
            className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] normal-case text-fg/70 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            title="Save the current render result as a PNG"
          >
            ⬇ Save
          </button>
        </span>
        <span
          data-testid="render-result-status"
          data-status={status}
          className="normal-case text-fg/50"
        >
          {statusText}
        </span>
      </header>
      <div className="relative flex-1">
        <canvas
          ref={canvasRef}
          data-testid="render-result-canvas"
          className="absolute inset-0 h-full w-full"
        />
      </div>
    </div>
  );
}

/** Paint the render result: dark backing, image letterbox-fit (contain),
 *  centered. Pure given (width, height, image). */
function drawRenderResult(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  image: HTMLImageElement | null,
) {
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, cssW, cssH);
  if (!image || image.naturalWidth === 0 || image.naturalHeight === 0) return;

  const pad = 12;
  const boxW = Math.max(1, cssW - pad * 2);
  const boxH = Math.max(1, cssH - pad * 2);
  const scale = Math.min(boxW / image.naturalWidth, boxH / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  const x = (cssW - w) / 2;
  const y = (cssH - h) / 2;
  ctx.drawImage(image, x, y, w, h);
}
