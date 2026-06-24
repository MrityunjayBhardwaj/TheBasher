// compositeDecode — the IMPURE half of the composite, shared by the live viewer
// (CompositeViewer, spine 1d) AND the export (exportCompositionAction, 1e) so
// there is exactly ONE collect → decode → draw path. The PURE half (planComposite
// / drawComposite) lives in composite.ts; this module wires the DAG to it:
//   - collectCompositeInputs(): walk the comp's layers (back→front), read authored
//     params and OVERLAY opacity/rotation with their evaluated [[V57]] channel value
//     via resolveEvaluatedParam (the renderer-identical path — animated values show,
//     [[H40]]), and resolve each source MediaClip to its OPFS path + metadata.
//   - decodeDraws(): decode every planned draw's source frame to an ImageBitmap
//     through the MediaDecodeCapability (OPFS read → bitmap), module-cached by
//     path#frame so a scrub / a re-export reuses decodes.
//   - captureCompositeFrame(): the ONE composing site — collect → planComposite →
//     decodeDraws → drawComposite onto a 2D context. The export calls this per
//     frame; the viewer composes the same four functions in its render effect.
//
// Both consumers calling these means the viewer and the export can NEVER produce a
// different composite (the B24 silent-failure: "blend/opacity parity viewer-vs-
// export if 1e doesn't reuse planComposite+drawComposite").
//
// REF: docs/COMPOSITOR-DESIGN.md §6; vyapti V37 (render==viewport) + V57 + H40;
//      dharana B24; src/app/video/composite.ts (the pure core); issue #237.

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
export function collectCompositeInputs(
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
// by its OPFS path, so one decode per path#frame serves every redraw + scrub + export.
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
    console.warn(`composite: failed to decode ${source.path}#${frameIndex}`, err);
    return null;
  }
}

/** Decode every planned draw's source frame, returning a map keyed by
 *  compositeBitmapKey (the same key drawComposite looks up). A draw that fails to
 *  decode is simply absent → drawComposite skips it (no throw, no blank crash). */
export async function decodeDraws(
  draws: readonly LayerComposite[],
): Promise<Map<string, ImageBitmap>> {
  const map = new Map<string, ImageBitmap>();
  await Promise.all(
    draws.map(async (d) => {
      const bmp = await ensureBitmap(d.source, d.sourceFrameIndex);
      if (bmp) map.set(compositeBitmapKey(d), bmp);
    }),
  );
  return map;
}

/**
 * Composite ONE frame onto `ctx` (size = comp width×height): collect → plan →
 * decode → draw, the four shared steps in one place. Returns the planned draws (so
 * the caller can report how many layers drew). The export (1e) calls this per frame;
 * the viewer composes the same functions in its effect. Parity by construction.
 */
export async function captureCompositeFrame(
  state: DagState,
  compId: NodeId,
  comp: CompositionParams,
  compFrame: number,
  ctx: CanvasRenderingContext2D,
): Promise<LayerComposite[]> {
  const fps = comp.fps ?? 30;
  const durationFrames = Math.max(1, comp.durationFrames ?? 150);
  const seconds = fps > 0 ? compFrame / fps : 0;
  const inputs = collectCompositeInputs(state, compId, {
    time: {
      frame: compFrame,
      seconds,
      normalized: durationFrames > 0 ? compFrame / durationFrames : 0,
    },
  });
  const draws = planComposite({ fps, durationFrames }, inputs, compFrame);
  const bitmaps = await decodeDraws(draws);
  drawComposite(
    ctx,
    {
      width: comp.width ?? 1280,
      height: comp.height ?? 720,
      background: comp.background ?? '#000000',
    },
    draws,
    bitmaps,
  );
  return draws;
}
