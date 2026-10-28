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
import { drawComposite, planComposite, type LayerComposite } from './composite';
import { collectCompositeInputs, decodeDraws } from './compositeDecode';
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
  const draws: LayerComposite[] = useMemo(
    () => planComposite({ fps, durationFrames }, inputs, compFrame),
    [inputs, fps, durationFrames, compFrame],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const map = await decodeDraws(draws);
      if (cancelled) return;
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) return;
      drawComposite(ctx, { width: W, height: H, background }, draws, map);
      setNonce((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [draws, W, H, background]);

  return (
    <div
      data-testid="video-mode-viewer"
      className="flex flex-1 items-center justify-center overflow-hidden bg-bg-2 p-2"
      style={{ minHeight: 0 }}
    >
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        data-testid="composite-canvas"
        data-composite-draws={draws.length}
        data-composite-nonce={nonce}
        className="max-h-full max-w-full rounded"
        style={{ aspectRatio: `${W} / ${H}` }}
      />
    </div>
  );
}
