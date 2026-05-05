// UVEditor — 2D HTML canvas editor that shows the UV layout of the
// currently-selected mesh. Read-only in v1 (P2.6); editing handles land
// later. Lives in src/app/ (file-rooted V8); never touches the DAG.
//
// The component is mounted as a sibling to the 3D Viewport in
// Layout.tsx; visibility flips via display:none so the Canvas (and its
// GPU state) survives the space toggle (K1 step 6 discipline).
//
// Implemented in Wave C of P2.6.

import { useEffect, useMemo, useRef } from 'react';
import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';
import { generateBoxUVs, type UVPolygon } from './uvLayout';

export function UVEditor() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const primaryId = useSelectionStore((s) => s.primaryNodeId);
  const node = useDagStore((s) => (primaryId ? s.state.nodes[primaryId] : null));

  const polygons = useMemo<UVPolygon[]>(
    () => (node?.type === 'BoxMesh' ? generateBoxUVs() : []),
    [node?.type],
  );
  const status = !node
    ? 'Select a mesh to view UVs.'
    : node.type === 'BoxMesh'
      ? `${node.id} · BoxMesh — canonical UV layout (read-only).`
      : node.type === 'GltfAsset'
        ? `${node.id} · GltfAsset — UV preview lands when the geometry registry ships.`
        : `${node.id} · ${node.type} — no UV layout.`;

  // ResizeObserver handles three triggers in one place:
  //   - initial mount once the canvas has a layout box,
  //   - window/parent resizes,
  //   - display:none → block transitions when the user switches space
  //     (Layout flips visibility; the canvas's box jumps from 0×0 to its
  //     actual size, which triggers the observer).
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
      drawUVCanvas(ctx, r.width, r.height, polygons);
    };
    repaint();
    const ro = new ResizeObserver(repaint);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [polygons]);

  return (
    <div data-testid="uv-editor" className="flex h-full w-full flex-col bg-bg">
      <header className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-fg/70">
        <span>UV Editor</span>
        <span data-testid="uv-editor-status" className="text-fg/50 normal-case">
          {status}
        </span>
      </header>
      <div className="relative flex-1">
        <canvas
          ref={canvasRef}
          data-testid="uv-editor-canvas"
          className="absolute inset-0 h-full w-full"
        />
      </div>
    </div>
  );
}

/** Paint the 2D canvas: 0..1 grid, axis labels, and any polygon outlines.
 *  Pure given (width, height, polygons) — testable separately if needed. */
function drawUVCanvas(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  polygons: UVPolygon[],
) {
  // Background.
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, cssW, cssH);

  // Frame the 0..1 UV square in the center, leaving padding for labels.
  const pad = 32;
  const sz = Math.min(cssW, cssH) - pad * 2;
  const ox = (cssW - sz) / 2;
  const oy = (cssH - sz) / 2;

  // Sub-grid (every 0.1).
  ctx.strokeStyle = '#1f1f1f';
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const f = i / 10;
    ctx.beginPath();
    ctx.moveTo(ox + sz * f, oy);
    ctx.lineTo(ox + sz * f, oy + sz);
    ctx.moveTo(ox, oy + sz * f);
    ctx.lineTo(ox + sz, oy + sz * f);
    ctx.stroke();
  }

  // Outer 0..1 frame.
  ctx.strokeStyle = '#3a3a4a';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(ox, oy, sz, sz);

  // Axis labels.
  ctx.fillStyle = '#888';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText('U=0', ox - 4, oy + sz + 14);
  ctx.fillText('U=1', ox + sz - 14, oy + sz + 14);
  ctx.fillText('V=0', ox - 28, oy + sz);
  ctx.fillText('V=1', ox - 28, oy + 8);

  // UV polygons. canvas Y is top-down; UV V is bottom-up — flip vertically
  // so V=0 sits at the bottom of the visible square (matches Blender / glTF).
  ctx.strokeStyle = '#5af07a';
  ctx.lineWidth = 1.6;
  for (const poly of polygons) {
    ctx.beginPath();
    poly.forEach(([u, v], i) => {
      const x = ox + u * sz;
      const y = oy + (1 - v) * sz;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
}
