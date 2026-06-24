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
// REF: docs/COMPOSITOR-DESIGN.md §6; vyapti V37 + V57 (evaluated overlay) + V80
//      (the viewer surface); hetvabhasa H40; issue #237.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDagStore } from '../../core/dag/store';
import { useTimeStore, FRAMES_PER_SECOND } from '../stores/timeStore';
import type { NodeId } from '../../core/dag/types';
import type { CompositionParams } from '../../nodes/Composition';
import { drawComposite, planComposite, type LayerComposite } from './composite';
import { collectCompositeInputs, decodeDraws } from './compositeDecode';
import { globalFrameToCompFrame } from './videoTimelineGeometry';

export function CompositeViewer({ compId, comp }: { compId: NodeId; comp: CompositionParams }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dagState = useDagStore((s) => s.state);
  const frame = useTimeStore((s) => s.frame);
  const seconds = useTimeStore((s) => s.seconds);
  const normalized = useTimeStore((s) => s.normalized);
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

  const inputs = useMemo(
    () => collectCompositeInputs(dagState, compId, { time: { frame, seconds, normalized } }),
    [dagState, compId, frame, seconds, normalized],
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
