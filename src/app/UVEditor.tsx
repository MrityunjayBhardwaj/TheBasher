// UVEditor — 2D HTML canvas editor that shows the REAL UV layout of the
// currently-selected mesh. Read-only (THESIS §58 item 3: "view + transform, not
// surgery" — per-vertex / seam / unwrap stays in Blender via the glTF round-trip).
// Lives in src/app/ (file-rooted V8); never touches the DAG.
//
// v0.6 #3 (#181, W1): promoted from synthetic Box/Sphere unfolds (uvLayout.ts)
// to REAL islands for EVERY producer. Islands are topological connected components
// (a display grouping; Blender shows islands too), NOT seam/unwrap edit.
//
// #406: the layout and the texture backdrop resolve through the ONE
// `resolveMeshUVSpace` projection over the (mesh, material) pair — the SAME path the
// __basher_uv_islands / __basher_uv_texture seams read, so the panel and the seams
// never drift (H40). Previously two independent resolvers with two independent
// useMemos over identical deps; that symmetry was the tell that it was one query.
//
// The component is mounted as a sibling to the 3D Viewport in Layout.tsx;
// visibility flips via display:none so the Canvas (and its GPU state) survives the
// space toggle (K1 step 6 discipline).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';
import { resolveMeshUVSpace } from './resolveMeshUVSpace';
import { usePanZoomCanvas } from './usePanZoomCanvas';

// Opacity of the texture backdrop. Dimmed (Blender default) so the bright island
// outlines stay readable on top of the image.
const TEXTURE_DIM = 0.6;

export function UVEditor() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const primaryId = useSelectionStore((s) => s.primaryNodeId);
  const dagState = useDagStore((s) => s.state);
  const node = primaryId ? dagState.nodes[primaryId] : null;
  // Retry trigger: async geometry (glTF clone / baked OPFS) may not be ready on
  // first render — re-resolve once while loading so it fills in (A-3, no stale).
  const [retry, setRetry] = useState(0);
  // User toggle for the texture backdrop (defaults on; only meaningful when a
  // texture actually resolves — the control hides otherwise).
  const [showTexture, setShowTexture] = useState(true);

  // ONE resolve for the (mesh, material) pair (#406) — the layout and the backdrop are
  // facets of a single query, so they can no longer disagree about what the selection is
  // or whether its source is ready.
  const space = useMemo(
    () =>
      primaryId
        ? resolveMeshUVSpace(dagState, primaryId)
        : {
            uvs: { uvs: null, status: 'none' as const },
            texture: { image: null, flipY: false, width: 0, height: 0, status: 'none' as const },
          },
    // retry forces a re-resolve when an async source was still loading last pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dagState, primaryId, retry],
  );
  const source = space.uvs;
  const texture = space.texture;

  useEffect(() => {
    // Re-resolve while EITHER the UV geometry or the texture bytes are still
    // loading (glTF clone register / baked OPFS read) so both fill in (A-3).
    if (source.status !== 'loading' && texture.status !== 'loading') return;
    const id = window.setTimeout(() => setRetry((r) => r + 1), 120);
    return () => window.clearTimeout(id);
  }, [source.status, texture.status, retry]);

  const polygons = useMemo(() => {
    if (!source.uvs) return [] as (readonly (readonly [number, number])[])[];
    return source.uvs.islands.flatMap((isl) => isl.polylines);
  }, [source.uvs]);

  const hasTexture = texture.status === 'ok' && texture.image !== null;
  const texNote = hasTexture ? ` · ${texture.width}×${texture.height} texture` : '';

  const status = !node
    ? 'Select a mesh to view UVs.'
    : source.status === 'loading'
      ? `${node.id} · ${node.type} — loading geometry…`
      : source.uvs && source.uvs.islands.length > 0
        ? `${node.id} · ${node.type} — ${source.uvs.islands.length} island${
            source.uvs.islands.length === 1 ? '' : 's'
          } · ${source.uvs.triangleCount} tris${
            source.uvs.sampled ? ' (sampled)' : ''
          }${texNote} (read-only).`
        : `${node.id} · ${node.type} — no UV layout.`;

  // Pan/zoom + all the canvas boilerplate (DPR sizing, ResizeObserver, the view
  // transform) live in the ONE shared hook; this pane supplies only its fit-draw.
  // zoom is passed so the grid/island hairlines and labels stay crisp/constant
  // while the texture backdrop scales (divide by zoom).
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, cssW: number, cssH: number, zoom: number) => {
      const backdrop = showTexture && texture.image ? texture : null;
      drawUVCanvas(ctx, cssW, cssH, polygons, backdrop, zoom);
    },
    [polygons, texture, showTexture],
  );
  const { reset } = usePanZoomCanvas(canvasRef, draw);

  return (
    <div data-testid="uv-editor" className="flex h-full w-full flex-col bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-fg/70">
        <span className="flex items-center gap-2">
          <span>UV Editor</span>
          {hasTexture && (
            <button
              type="button"
              data-testid="uv-editor-texture-toggle"
              aria-pressed={showTexture}
              onClick={() => setShowTexture((v) => !v)}
              className={`rounded px-1.5 py-0.5 text-[10px] normal-case transition-colors ${
                showTexture
                  ? 'bg-accent/15 text-accent'
                  : 'bg-transparent text-fg/50 hover:text-fg/70'
              }`}
              title="Toggle the bound base-color texture backdrop"
            >
              Texture
            </button>
          )}
          <button
            type="button"
            data-testid="uv-editor-fit"
            onClick={reset}
            className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] normal-case text-fg/50 transition-colors hover:text-fg/80"
            title="Fit to view (or double-click the canvas)"
          >
            ⤢ Fit
          </button>
        </span>
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
 *  Pure given (width, height, polygons, backdrop, zoom). The view transform
 *  (pan/zoom) is applied by the canvas before this runs; `zoom` lets the
 *  hairlines + labels stay constant on-screen (divide by zoom) while the
 *  texture backdrop scales — so zooming in inspects texels, not fat lines. */
function drawUVCanvas(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  polygons: (readonly (readonly [number, number])[])[],
  backdrop: { image: CanvasImageSource | null; flipY: boolean } | null,
  zoom: number,
) {
  const hair = 1 / zoom; // a 1px hairline regardless of zoom
  // Background.
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, cssW, cssH);

  // Frame the 0..1 UV square in the center, leaving padding for labels.
  const pad = 32;
  const sz = Math.min(cssW, cssH) - pad * 2;
  const ox = (cssW - sz) / 2;
  const oy = (cssH - sz) / 2;

  // Base-color texture backdrop (UX #10), under the grid + islands. The vertical
  // orientation follows the texture's flipY so the texel a UV vertex samples sits
  // BEHIND that vertex (V48): islands draw V-up via (1-v); a flipY=false (glTF,
  // top-left origin) map must be flipped, a flipY=true (OpenGL) map drawn upright.
  if (backdrop?.image) {
    ctx.save();
    ctx.globalAlpha = TEXTURE_DIM;
    if (backdrop.flipY) {
      ctx.drawImage(backdrop.image, ox, oy, sz, sz);
    } else {
      ctx.translate(ox, oy + sz);
      ctx.scale(1, -1);
      ctx.drawImage(backdrop.image, 0, 0, sz, sz);
    }
    ctx.restore();
  }

  // Sub-grid (every 0.1).
  ctx.strokeStyle = '#1f1f1f';
  ctx.lineWidth = hair;
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
  ctx.lineWidth = 1.4 * hair;
  ctx.strokeRect(ox, oy, sz, sz);

  // Axis labels — kept constant on-screen (font + offsets divided by zoom).
  ctx.fillStyle = '#888';
  ctx.font = `${10 * hair}px ui-monospace, monospace`;
  ctx.fillText('U=0', ox - 4 * hair, oy + sz + 14 * hair);
  ctx.fillText('U=1', ox + sz - 14 * hair, oy + sz + 14 * hair);
  ctx.fillText('V=0', ox - 28 * hair, oy + sz);
  ctx.fillText('V=1', ox - 28 * hair, oy + 8 * hair);

  // UV polygons. canvas Y is top-down; UV V is bottom-up — flip vertically
  // so V=0 sits at the bottom of the visible square (matches Blender / glTF).
  ctx.strokeStyle = '#5af07a';
  ctx.lineWidth = hair;
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
