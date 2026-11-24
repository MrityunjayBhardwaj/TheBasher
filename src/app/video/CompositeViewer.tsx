// CompositeViewer — the live composite of a Composition at the playhead (spine 1d).
//
// Reads the comp's ordered layers from the DAG, overlays each layer's keyframed
// opacity/rotation via the SAME resolveEvaluatedParam the renderer/inspector use
// (so the viewer shows what is animated — H40), plans the visible set with the
// pure planComposite, decodes each source frame through the MediaDecodeCapability
// (OPFS read → bitmap, cached by path#frame), and draws onto a comp-sized 2D
// canvas. The decode is async; a redraw paints whatever is ready, then signals a
// nonce so a test can wait for a completed frame.
//
// This is the same composite the export (1e) will walk — render==viewport ([[V37]]).
//
// #1734 — the Video space stays mounted, hidden, while another space is shown. Hidden
// (`active` false), the viewer holds the playhead and the graph it last drew and so does no work:
// it re-read, planned, decoded and drew a frame no one could see on every playback frame in the
// 3D view (41 draws in 2 s, p1734). Shown again, it reads both afresh and draws the playhead.
//
// REF: docs/COMPOSITOR-DESIGN.md §6; vyapti V37 + V57 (evaluated overlay) + V80
//      (the viewer surface); hetvabhasa H40; issue #237.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDagStore } from '../../core/dag/store';
import { useTimeStore, FRAMES_PER_SECOND } from '../stores/timeStore';
import type { NodeId } from '../../core/dag/types';
import type { CompositionParams } from '../../nodes/Composition';
import {
  drawComposite,
  isLayerDraw,
  planComposite,
  type CompositeDraw,
  type CompositePath,
} from './composite';
import { collectCompositeInputs, decodeDraws } from './compositeDecode';
import { fitContain } from './composite';
import { renderSourceAt, type ViewerCompare } from './shotCompare';
import { getStorage } from '../boot';
import { globalFrameToCompFrame } from './videoTimelineGeometry';
import { uiEvaluatorCache } from '../uiEvaluatorCache';

export function CompositeViewer({
  compId,
  comp,
  active = true,
}: {
  compId: NodeId;
  comp: CompositionParams;
  /** False while the Video space is hidden: hold what was last drawn, read nothing new. */
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Hidden, each selector returns what it returned last, so neither store re-renders the viewer.
  const held = useRef<{
    state: ReturnType<typeof useDagStore.getState>['state'];
    time: { frame: number; seconds: number; normalized: number };
  } | null>(null);
  const dagState = useDagStore((s) => (active || !held.current ? s.state : held.current.state));
  const time = useTimeStore(
    useShallow((s) =>
      active || !held.current
        ? { frame: s.frame, seconds: s.seconds, normalized: s.normalized }
        : held.current.time,
    ),
  );
  held.current = { state: dagState, time };
  const { frame, seconds, normalized } = time;
  const [nonce, setNonce] = useState(0);
  // #1883 — which pass drew the last frame: 'gpu' (linear float) or '2d' (the fallback).
  const [path, setPath] = useState<CompositePath | ''>('');

  const W = comp.width ?? 1280;
  const H = comp.height ?? 720;
  const fps = comp.fps ?? 30;
  const durationFrames = Math.max(1, comp.durationFrames ?? 150);
  const background = comp.background ?? '#000000';
  // The global playhead → this comp's frame, via the ONE shared map the ruler
  // playhead + the transport readout also use (H95: the composited frame, the
  // drawn playhead and the readout can never disagree).
  const compFrame = globalFrameToCompFrame(frame, FRAMES_PER_SECOND, fps, durationFrames);

  // The shared UI cache (#1389, #1315): the layer reads re-run per frame, and a layer param
  // driven through pure nodes would otherwise re-run them every frame.
  const cache = uiEvaluatorCache;
  const inputs = useMemo(
    () => collectCompositeInputs(dagState, compId, { time: { frame, seconds, normalized } }, cache),
    [dagState, compId, frame, seconds, normalized, cache],
  );
  const draws: CompositeDraw[] = useMemo(
    () => planComposite({ fps, durationFrames }, inputs, compFrame),
    [inputs, fps, durationFrames, compFrame],
  );

  // #1717 — Generated, the 3D render it came from, or a wipe between them.
  const [compare, setCompare] = useState<ViewerCompare>('generated');
  const [wipe, setWipe] = useState(0.5);
  const renderSource = useMemo(
    () => (compare === 'generated' ? null : renderSourceAt(dagState, compId, compFrame)),
    [compare, dagState, compId, compFrame],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [map, render] = await Promise.all([
        decodeDraws(draws),
        renderSource ? loadRenderBitmap(renderSource.path, renderSource.version) : null,
      ]);
      if (cancelled) return;
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      setPath(drawComposite(ctx, { width: W, height: H, background }, draws, map));
      if (compare !== 'generated') drawRenderSide(ctx, W, H, background, compare, wipe, render);
      setNonce((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [draws, W, H, background, compare, wipe, renderSource]);

  return (
    <div
      data-testid="video-mode-viewer"
      className="relative flex flex-1 items-center justify-center overflow-hidden bg-bg-2 p-2"
      style={{ minHeight: 0 }}
    >
      <ViewerCompareBar
        compare={compare}
        onCompare={setCompare}
        wipe={wipe}
        onWipe={setWipe}
        hasRender={renderSource !== null}
      />
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        data-testid="composite-canvas"
        data-composite-draws={draws.filter(isLayerDraw).length}
        data-composite-path={path}
        data-composite-nonce={nonce}
        data-viewer-compare={compare}
        className="max-h-full max-w-full rounded"
        style={{ aspectRatio: `${W} / ${H}` }}
      />
    </div>
  );
}

// #1717 — the 3D render a shot came from, decoded once per file version.
const renderBitmaps = new Map<string, Promise<ImageBitmap | null>>();
const MAX_RENDER_BITMAPS = 32;

function loadRenderBitmap(path: string, version: string): Promise<ImageBitmap | null> {
  const key = `${path}#${version}`;
  const known = renderBitmaps.get(key);
  if (known) return known;
  const work = (async () => {
    const storage = await getStorage();
    if (!(await storage.exists(path))) return null;
    const bytes = await storage.read(path);
    return createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  })().catch(() => null);
  renderBitmaps.set(key, work);
  while (renderBitmaps.size > MAX_RENDER_BITMAPS) {
    const oldest = renderBitmaps.keys().next().value as string;
    void renderBitmaps.get(oldest)?.then((b) => b?.close());
    renderBitmaps.delete(oldest);
  }
  return work;
}

/** Draw the 3D render over the composite: the whole frame ('render'), or left of the wipe line
 *  ('wipe'). With no render for this frame, say so where it would be. */
function drawRenderSide(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  background: string,
  compare: ViewerCompare,
  wipe: number,
  render: ImageBitmap | null,
): void {
  const splitX = compare === 'render' ? W : Math.round(Math.min(1, Math.max(0, wipe)) * W);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, splitX, H);
  ctx.clip();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, splitX, H);
  if (render) {
    const { dw, dh } = fitContain(render.width, render.height, W, H);
    ctx.drawImage(render, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `${Math.max(14, Math.round(H / 24))}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('No 3D render for this frame yet', Math.round(W / 24), Math.round(H / 2));
  }
  ctx.restore();
  if (compare === 'wipe') {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(splitX - 1, 0, 2, H);
  }
}

const compareButton = (on: boolean) =>
  `px-2 py-0.5 text-[10px] ${on ? 'bg-accent/15 text-fg' : 'text-fg/70 hover:text-fg'} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent`;

/** Generated · 3D render · Wipe, over the viewer. */
function ViewerCompareBar({
  compare,
  onCompare,
  wipe,
  onWipe,
  hasRender,
}: {
  compare: ViewerCompare;
  onCompare: (c: ViewerCompare) => void;
  wipe: number;
  onWipe: (w: number) => void;
  hasRender: boolean;
}) {
  const modes: [ViewerCompare, string][] = [
    ['generated', 'Generated'],
    ['render', '3D render'],
    ['wipe', 'Wipe'],
  ];
  return (
    <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded border border-border bg-bg/80 px-1 py-0.5">
      <div role="radiogroup" aria-label="Compare" className="flex overflow-hidden rounded">
        {modes.map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={compare === mode}
            data-testid={`video-viewer-compare-${mode}`}
            onClick={() => onCompare(mode)}
            className={compareButton(compare === mode)}
          >
            {label}
          </button>
        ))}
      </div>
      {compare === 'wipe' && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={wipe}
          aria-label="Wipe position"
          data-testid="video-viewer-wipe"
          onChange={(e) => onWipe(Number(e.target.value))}
          className="w-24"
        />
      )}
      {compare !== 'generated' && !hasRender && (
        <span className="text-[10px] text-fg-dim" data-testid="video-viewer-no-render">
          no shot clip here
        </span>
      )}
    </div>
  );
}
