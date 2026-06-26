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

import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadRenderResult, renderActiveProjectToView } from './renderImageAction';
import { saveRenderPassesToProject } from './saveRenderPassesToProject';
import { useRenderResultStore } from './stores/renderResultStore';
import { usePanZoomCanvas } from './usePanZoomCanvas';
import type { RenderPassKind } from '../render/renderToImage';

/** The control passes the pane can render + eyeball (ComfyUI Inc 1). */
const PASS_OPTIONS: readonly { value: RenderPassKind; label: string }[] = [
  { value: 'beauty', label: 'Beauty' },
  { value: 'depth', label: 'Depth' },
  { value: 'normal', label: 'Normal' },
];

export function RenderResultView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The decoded image lives in state so a fresh decode re-runs the draw closure
  // (which the pan/zoom hook repaints on).
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  const status = useRenderResultStore((s) => s.status);
  const dataUrl = useRenderResultStore((s) => s.dataUrl);
  const width = useRenderResultStore((s) => s.width);
  const height = useRenderResultStore((s) => s.height);
  const source = useRenderResultStore((s) => s.source);
  const pass = useRenderResultStore((s) => s.pass);
  const error = useRenderResultStore((s) => s.error);

  const rendering = status === 'rendering';
  const hasResult = status === 'ready' && dataUrl !== null;

  // Decode the data URL into an <img> off-DOM; setImage when it loads.
  useEffect(() => {
    if (!dataUrl) {
      setImage(null);
      return;
    }
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = dataUrl;
    return () => {
      img.onload = null;
    };
  }, [dataUrl]);

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, cssW: number, cssH: number) =>
      drawRenderResult(ctx, cssW, cssH, image),
    [image],
  );
  const { reset } = usePanZoomCanvas(canvasRef, draw);

  const passLabel = PASS_OPTIONS.find((p) => p.value === pass)?.label ?? '';
  const dims = width > 0 && height > 0 ? `${width}×${height}` : '';
  const statusText =
    status === 'rendering'
      ? 'Rendering…'
      : status === 'error'
        ? (error ?? 'Render failed.')
        : status === 'ready'
          ? `${dims} · ${passLabel}${source === 'ai' ? ' · AI' : ''}`
          : 'No render yet — press Render.';

  return (
    <div data-testid="render-result-view" className="flex h-full w-full flex-col bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-fg/70">
        <span className="flex items-center gap-2">
          <span>Render Result</span>
          {/* Control-pass selector (ComfyUI Inc 1): switch beauty/depth/normal
              and re-render so the geometry passes feeding the ComfyUI bridge can
              be scrubbed + eyeballed (observation, not inference). */}
          <span className="flex items-center gap-0.5" role="group" aria-label="Render pass">
            {PASS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                data-testid={`render-result-pass-${opt.value}`}
                data-active={pass === opt.value || undefined}
                disabled={rendering}
                onClick={() => void renderActiveProjectToView(opt.value)}
                className={`rounded px-1.5 py-0.5 text-[10px] normal-case transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  pass === opt.value ? 'bg-accent/15 text-accent' : 'text-fg/60 hover:text-fg'
                }`}
                title={`Render the ${opt.label.toLowerCase()} pass at the current playhead`}
              >
                {opt.label}
              </button>
            ))}
          </span>
          <button
            type="button"
            data-testid="render-result-render"
            disabled={rendering}
            onClick={() => void renderActiveProjectToView(pass)}
            className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] normal-case text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
            title="Re-render the current pass at the current playhead"
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
          {/* Save beauty/depth/normal at the current frame as project images so a
              video-mode ComfyUI layer can reference them in its image inputs (the
              3D scene as control rig — render_<frame>_<pass>.png). */}
          <button
            type="button"
            data-testid="render-result-save-passes"
            disabled={rendering}
            onClick={() => void saveRenderPassesToProject()}
            className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] normal-case text-fg/70 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            title="Render beauty/depth/normal at the current frame and add them to the project — usable as image inputs in video mode"
          >
            → Project
          </button>
          <button
            type="button"
            data-testid="render-result-fit"
            disabled={!hasResult}
            onClick={reset}
            className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] normal-case text-fg/70 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            title="Fit to view (or double-click the canvas)"
          >
            ⤢ Fit
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
