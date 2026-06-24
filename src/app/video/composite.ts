// composite — the Compositor's viewer/export compositing core (spine 1d).
//
// Two halves, kept apart so the geometry is pure (testable) and only the actual
// pixel draw touches a canvas:
//   - planComposite(): PURE. Given the comp + the resolved layer inputs (authored
//     params already overlaid with their evaluated [[V57]] channel values) + the
//     comp playhead frame, decide which layers are visible (enabled / solo / trim)
//     and which source frame each shows. The ONE place the composite's visibility +
//     time-remap rules live, so the live viewer and the export (1e) can't drift
//     ([[V37]] render==viewport).
//   - drawComposite(): the impure 2D-canvas pass — clears, fills the comp
//     background, then draws each visible layer back→top with its opacity / 2D
//     transform / blend. The decode (OPFS read → MediaDecodeCapability) is the
//     caller's concern; this just draws already-decoded bitmaps.
//
// The comp-frame → source-frame remap reuses `mediaClipFrameAt` (the SAME mapping
// the MediaClip evaluator uses) so preview and source agree (no drift — H40).
//
// REF: docs/COMPOSITOR-DESIGN.md §6 (compositing) + §4.4 (time remap); vyapti V37
//      (render==viewport) + V2; sibling: videoTimelineGeometry (layerBarSpan); #237.

import type { LayerBlendMode } from '../../nodes/types';
import { mediaClipFrameAt, type MediaClipParams } from '../../nodes/MediaClip';
import { layerBarSpan } from './videoTimelineGeometry';

/** A decodable layer source (a MediaClip resolved to its OPFS path + metadata). */
export interface CompositeSource {
  readonly path: string;
  readonly mediaKind: 'video' | 'image';
  readonly width: number;
  readonly height: number;
  readonly srcFps: number;
  readonly srcFrames: number;
}

/** A layer's composite inputs at a playhead: authored params with `opacity` +
 *  `rotation` already overlaid by their evaluated channel value (the rest are
 *  authored until 3c-ii makes them keyframeable). `source` is null when the layer
 *  has no decodable source yet (e.g. a not-yet-rendered scene layer). */
export interface ResolvedLayerInput {
  readonly layerId: string;
  readonly enabled: boolean;
  readonly solo: boolean;
  readonly startFrame: number;
  readonly inPoint: number;
  readonly outPoint: number;
  readonly opacity: number;
  readonly rotation: number;
  readonly position: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly blendMode: LayerBlendMode;
  readonly source: CompositeSource | null;
}

/** A visible layer resolved to exactly what `drawComposite` needs to draw it. */
export interface LayerComposite {
  readonly layerId: string;
  readonly source: CompositeSource;
  readonly sourceFrameIndex: number;
  readonly opacity: number;
  readonly rotation: number;
  readonly position: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly blendMode: LayerBlendMode;
}

/** The cache key for a decoded source frame (path + which frame). */
export function compositeBitmapKey(c: {
  source: CompositeSource;
  sourceFrameIndex: number;
}): string {
  return `${c.source.path}#${c.sourceFrameIndex}`;
}

/**
 * The ordered (back→front) list of layers visible at `compFrame`, each resolved to
 * its source frame. PURE. A layer is dropped when it has no source, is hidden (the
 * eyeball / solo rule: if ANY layer solos, only solos draw), or the playhead is
 * outside its trimmed span. `inputs` must be in back→front (comp `layers`) order.
 */
export function planComposite(
  comp: { fps: number; durationFrames: number },
  inputs: readonly ResolvedLayerInput[],
  compFrame: number,
): LayerComposite[] {
  const anySolo = inputs.some((i) => i.solo);
  const fps = comp.fps > 0 ? comp.fps : 30;
  const out: LayerComposite[] = [];
  for (const i of inputs) {
    if (!i.source) continue;
    const visible = anySolo ? i.solo : i.enabled;
    if (!visible) continue;
    const span = layerBarSpan(i, i.source.srcFrames);
    if (compFrame < span.startFrame || compFrame >= span.startFrame + span.lengthFrames) continue;
    // comp frame → source-local seconds → source frame (the SAME map as the
    // MediaClip evaluator; image sources resolve to frame 0).
    const sourceSeconds = (compFrame - i.startFrame + i.inPoint) / fps;
    const sourceFrameIndex = mediaClipFrameAt(
      {
        mediaKind: i.source.mediaKind,
        srcFps: i.source.srcFps,
        srcFrames: i.source.srcFrames,
      } as MediaClipParams,
      sourceSeconds,
    );
    out.push({
      layerId: i.layerId,
      source: i.source,
      sourceFrameIndex,
      opacity: i.opacity,
      rotation: i.rotation,
      position: i.position,
      scale: i.scale,
      blendMode: i.blendMode,
    });
  }
  return out;
}

/** Fit `src` inside `dst` preserving aspect (the AE "fit, don't distort" default).
 *  PURE. Returns the drawn width/height; a degenerate source falls back to dst. */
export function fitContain(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { dw: number; dh: number } {
  if (srcW <= 0 || srcH <= 0) return { dw: dstW, dh: dstH };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  return { dw: srcW * scale, dh: srcH * scale };
}

/** The 2D-canvas blend op for a layer blend mode. PURE. */
export function blendOp(mode: LayerBlendMode): GlobalCompositeOperation {
  switch (mode) {
    case 'add':
      return 'lighter';
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'normal':
    default:
      return 'source-over';
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Draw the composite onto `ctx` (size = comp width×height): clear, fill the comp
 * background, then draw each visible layer back→top. Each layer's source is fitted
 * (contain) and centered, then translated by `position`, rotated, and scaled about
 * the comp centre, with `opacity` + blend applied. A draw whose bitmap is missing
 * (still decoding) is skipped — the next redraw paints it.
 */
export function drawComposite(
  ctx: CanvasRenderingContext2D,
  comp: { width: number; height: number; background: string },
  draws: readonly LayerComposite[],
  bitmaps: ReadonlyMap<string, CanvasImageSource & { width: number; height: number }>,
): void {
  const W = comp.width;
  const H = comp.height;
  ctx.clearRect(0, 0, W, H);
  if (comp.background) {
    ctx.fillStyle = comp.background;
    ctx.fillRect(0, 0, W, H);
  }
  for (const d of draws) {
    const bmp = bitmaps.get(compositeBitmapKey(d));
    if (!bmp) continue;
    ctx.save();
    ctx.globalAlpha = clamp01(d.opacity);
    ctx.globalCompositeOperation = blendOp(d.blendMode);
    ctx.translate(W / 2 + d.position[0], H / 2 + d.position[1]);
    ctx.rotate((d.rotation * Math.PI) / 180);
    ctx.scale(d.scale[0], d.scale[1]);
    const { dw, dh } = fitContain(bmp.width, bmp.height, W, H);
    ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
}
