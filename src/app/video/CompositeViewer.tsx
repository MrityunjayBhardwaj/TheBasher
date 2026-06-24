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
import { pickStorage } from '../../core/storage';
import { pickMediaDecode, type MediaProbe } from '../../core/media';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import type { DagState } from '../../core/dag/state';
import type { EvalCtx, NodeId } from '../../core/dag/types';
import type { CompositionParams } from '../../nodes/Composition';
import type { LayerBlendMode } from '../../nodes/types';
import { resolveEvaluatedParam } from '../resolveEvaluatedParam';
import {
  compositeBitmapKey,
  drawComposite,
  planComposite,
  type CompositeSource,
  type LayerComposite,
  type ResolvedLayerInput,
} from './composite';

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function vec2(v: unknown, fallback: readonly [number, number]): readonly [number, number] {
  return Array.isArray(v) && v.length >= 2
    ? [num(v[0], fallback[0]), num(v[1], fallback[1])]
    : fallback;
}

function firstSourceId(binding: unknown): NodeId | undefined {
  if (Array.isArray(binding)) return (binding[0] as { node: NodeId } | undefined)?.node;
  if (binding && typeof binding === 'object' && 'node' in binding)
    return (binding as { node: NodeId }).node;
  return undefined;
}

/** Resolve the comp's layers (back→front) to composite inputs: authored params with
 *  opacity + rotation overlaid by their evaluated channel value, and the source
 *  MediaClip resolved to its OPFS path + metadata (null when not yet decodable). */
function collectCompositeInputs(
  state: DagState,
  compId: NodeId,
  ctx: EvalCtx,
): ResolvedLayerInput[] {
  const comp = state.nodes[compId];
  if (!comp) return [];
  const binding = comp.inputs?.layers;
  const layerIds = Array.isArray(binding)
    ? binding.map((r) => (r as { node: NodeId }).node)
    : binding
      ? [(binding as { node: NodeId }).node]
      : [];
  const inputs: ResolvedLayerInput[] = [];
  for (const layerId of layerIds) {
    const layer = state.nodes[layerId];
    if (!layer || layer.type !== 'Layer') continue;
    const p = layer.params as Record<string, unknown>;
    const t = (p.transform ?? {}) as Record<string, unknown>;

    const opacity = num(
      resolveEvaluatedParam(state, layerId, 'opacity', ctx)?.value,
      num(p.opacity, 1),
    );
    const rotation = num(
      resolveEvaluatedParam(state, layerId, 'transform.rotation', ctx)?.value,
      num(t.rotation, 0),
    );

    let source: CompositeSource | null = null;
    const srcId = firstSourceId(layer.inputs?.source);
    const src = srcId ? state.nodes[srcId] : undefined;
    if (src && src.type === 'MediaClip') {
      const sp = src.params as Record<string, unknown>;
      const path = String(sp.src ?? '');
      if (path) {
        source = {
          path,
          mediaKind: (sp.mediaKind as 'video' | 'image') ?? 'image',
          width: num(sp.width, 1),
          height: num(sp.height, 1),
          srcFps: num(sp.srcFps, 30),
          srcFrames: Math.max(1, num(sp.srcFrames, 1)),
        };
      }
    }

    inputs.push({
      layerId,
      enabled: p.enabled !== false,
      solo: p.solo === true,
      startFrame: num(p.startFrame, 0),
      inPoint: num(p.inPoint, 0),
      outPoint: num(p.outPoint, -1),
      opacity,
      rotation,
      position: vec2(t.position, [0, 0]),
      scale: vec2(t.scale, [1, 1]),
      blendMode: (p.blendMode as LayerBlendMode) ?? 'normal',
      source,
    });
  }
  return inputs;
}

// Decode is impure + cached module-wide. A still source (image) is content-addressed
// by its OPFS path, so one decode per path#frame serves every redraw + scrub.
const bitmapCache = new Map<string, ImageBitmap>();
const decoder = pickMediaDecode();
let storagePromise: Promise<StorageCapability> | null = null;

async function ensureBitmap(
  source: CompositeSource,
  frameIndex: number,
): Promise<ImageBitmap | null> {
  const key = `${source.path}#${frameIndex}`;
  const cached = bitmapCache.get(key);
  if (cached) return cached;
  try {
    storagePromise ??= pickStorage();
    const bytes = await (await storagePromise).read(source.path);
    const probe: MediaProbe = {
      mediaKind: source.mediaKind,
      width: source.width,
      height: source.height,
      srcFps: source.srcFps,
      srcFrames: source.srcFrames,
      durationSeconds: source.mediaKind === 'image' ? 0 : source.srcFrames / source.srcFps,
    };
    const frame = await decoder.decodeFrame(bytes, probe, frameIndex);
    let bmp: ImageBitmap | null = frame.bitmap;
    if (!bmp && frame.rgba) {
      // The stub/headless path yields raw rgba — copy into a fresh (ArrayBuffer-
      // backed) buffer so ImageData accepts it, then rasterize to a bitmap.
      const data = new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height);
      bmp = await createImageBitmap(data);
    }
    if (bmp) bitmapCache.set(key, bmp);
    return bmp;
  } catch (err) {
    console.warn(`CompositeViewer: failed to decode ${source.path}#${frameIndex}`, err);
    return null;
  }
}

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
  const compFrame = clamp(Math.round((frame / FRAMES_PER_SECOND) * fps), 0, durationFrames);

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
      const map = new Map<string, ImageBitmap>();
      await Promise.all(
        draws.map(async (d) => {
          const bmp = await ensureBitmap(d.source, d.sourceFrameIndex);
          if (bmp) map.set(compositeBitmapKey(d), bmp);
        }),
      );
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
