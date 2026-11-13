// composite — the Compositor's viewer/export compositing core (spine 1d).
//
// Two halves, kept apart so the geometry is pure (testable) and only the actual
// pixel draw touches a canvas:
//   - planComposite(): PURE. Given the comp + the resolved layer inputs (authored
//     params already overlaid with their evaluated [[V57]] channel values) + the
//     comp playhead frame, decide which layers are visible (muted / solo / trim)
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

import {
  gpuCompositor,
  gpuUnavailableReason,
  isLinearImage,
  layerInverseMatrix,
  type CompositeImage,
  type GpuDraw,
} from './gpuComposite';
import type { LayerBlendMode } from '../../nodes/types';
import { mediaClipFrameAt, type MediaClipParams } from '../../nodes/MediaClip';
import { layerBarSpan } from './videoTimelineGeometry';

/** A decodable layer source. `kind` discriminates the decode route: 'media' (the
 *  default) = a MediaClip resolved to its OPFS path + metadata; 'comfy' = a
 *  ComfyUIWorkflow generator decoded as a deterministic STUB frame (real ComfyUI
 *  submit is a later inc 3 slice). `path` is the OPFS path (media) or a synthetic
 *  cache key `comfy:<nodeId>` (comfy). */
export interface CompositeSource {
  readonly kind?: 'media' | 'comfy';
  readonly path: string;
  readonly mediaKind: 'video' | 'image';
  readonly width: number;
  readonly height: number;
  readonly srcFps: number;
  readonly srcFrames: number;
  /** A human label drawn into a generator (comfy) stub frame — e.g. the imported
   *  workflow's name. Ignored by media sources. */
  readonly label?: string;
  /** A comfy generator's per-frame compiled workflow (the ComfyUI API json with
   *  this frame's resolved params substituted). The decoder submits it to a real
   *  server when live-generate is on; typed `unknown` to keep composite.ts free of
   *  the comfy data model. */
  readonly comfyWorkflow?: unknown;
  /** A comfy generator's bound image inputs to upload before submit: each OPFS
   *  `path` is read to bytes and sent to ComfyUI under `filename` (the same stable
   *  filename the compiled workflow's LoadImage input was rewritten to reference).
   *  Shape mirrors `ComfyImageUpload` (kept inline so composite.ts stays free of
   *  the comfy data model). Empty/absent when no image input is bound. */
  readonly comfyImageUploads?: readonly { readonly path: string; readonly filename: string }[];
}

/** A resolved video effect to apply to a layer's decoded frame, in apply order
 *  (base → top of the [[V58]] stack). Today only ColorCorrect; new effect types add
 *  a member here + a branch in the GPU grade (gpuComposite.ts) and `effectFilter`. Params are already EVALUATED (channel
 *  overlay) so a keyframed effect param shows in both viewer and export (H40). */
export interface ColorCorrectOp {
  readonly type: 'ColorCorrect';
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
}
export type EffectOp = ColorCorrectOp;

/** The canvas filter that applies an effect chain (base → top, the apply order). '' for an
 *  empty chain. ColorCorrect maps to `brightness()/contrast()/saturate()`. The ONE place an
 *  effect becomes a filter, for a layer's own effects and for a step between layers. PURE. */
export function effectFilter(effects: readonly EffectOp[]): string {
  const filters: string[] = [];
  for (const e of effects) {
    if (e.type === 'ColorCorrect') {
      filters.push(`brightness(${e.brightness}) contrast(${e.contrast}) saturate(${e.saturation})`);
    }
  }
  return filters.join(' ');
}

/** A step between layers (#1879 step 4): an Image→Image operator on the stack's chain. It
 *  adjusts everything drawn below it — the layers under it and the comp background. Muted
 *  steps are not collected. */
export interface ResolvedAdjustInput {
  readonly kind: 'adjust';
  readonly nodeId: string;
  readonly effects: readonly EffectOp[];
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
  /** The layer's effect chain (base → top), already evaluated. Empty = no effects. */
  readonly effects: readonly EffectOp[];
}

/** One entry of the stack at a playhead, back→front: a layer or a step between layers. */
export type ResolvedStackInput = ResolvedLayerInput | ResolvedAdjustInput;

/** Narrow a stack input to a layer input. */
export function isLayerInput(i: ResolvedStackInput): i is ResolvedLayerInput {
  return !('kind' in i);
}

/** A step that applies to the canvas drawn so far. */
export interface AdjustComposite {
  readonly kind: 'adjust';
  readonly nodeId: string;
  readonly effects: readonly EffectOp[];
}

/** What `drawComposite` does, in order: draw a layer, or adjust what is drawn. */
export type CompositeDraw = LayerComposite | AdjustComposite;

/** Narrow a planned draw to a layer draw (the ones that decode a source). */
export function isLayerDraw(d: CompositeDraw): d is LayerComposite {
  return !('kind' in d);
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
  /** The effect chain to apply to the decoded frame (base → top). */
  readonly effects: readonly EffectOp[];
}

/** The cache key for a decoded source frame (path + frame). Effects are applied while
 *  drawing (#1883: on the GPU, in linear light), so one decoded frame serves every grade. */
export function compositeBitmapKey(c: {
  source: CompositeSource;
  sourceFrameIndex: number;
}): string {
  return `${c.source.path}#${c.sourceFrameIndex}`;
}

/**
 * The ordered (back→front) draws at `compFrame`: each visible layer resolved to its source
 * frame, and each step between layers that adjusts what is below it. PURE. A layer is
 * dropped when it has no source, is hidden (the eyeball / solo rule: if ANY layer solos,
 * only solos draw), or the playhead is outside its trimmed span. A step has no span; it
 * applies whenever it has an effect, unless a layer is soloed — solo shows the soloed layers
 * as they are, as After Effects hides adjustment layers (user, 2026-11-13). Its own off
 * switch is the stack mute. `inputs` must be in back→front (stack) order.
 */
export function planComposite(
  comp: { fps: number; durationFrames: number },
  inputs: readonly ResolvedStackInput[],
  compFrame: number,
): CompositeDraw[] {
  const anySolo = inputs.some((i) => !('kind' in i) && i.solo);
  const fps = comp.fps > 0 ? comp.fps : 30;
  const out: CompositeDraw[] = [];
  for (const i of inputs) {
    if ('kind' in i) {
      if (!anySolo && effectFilter(i.effects))
        out.push({ kind: 'adjust', nodeId: i.nodeId, effects: i.effects });
      continue;
    }
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
      effects: i.effects,
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

/** Which pass drew a frame: the GPU's linear float pass, or the 2D canvas fallback. */
export type CompositePath = 'gpu' | '2d';

let warnedFallback = false;

/**
 * Draw the composite onto `ctx` (size = comp width×height). On the GPU when it can (#1883):
 * linear light, half float, the background under everything, display encoding once at the
 * end — see gpuComposite.ts. Otherwise the 2D canvas fallback, in display colour, which says
 * so once in the console and in the returned path.
 *
 * Either way: each layer's source is fitted (contain) and centred, then translated by
 * `position`, rotated and scaled about the comp centre, with its own effects, `opacity` and
 * blend applied. A step between layers adjusts everything drawn under it, but not the comp
 * background (the background is not a layer, as in After Effects). A draw whose picture is
 * missing (still decoding) is skipped — the next redraw paints it.
 */
export function drawComposite(
  ctx: CanvasRenderingContext2D,
  comp: { width: number; height: number; background: string },
  draws: readonly CompositeDraw[],
  bitmaps: ReadonlyMap<string, CompositeImage>,
): CompositePath {
  const W = comp.width;
  const H = comp.height;
  const gpu = gpuCompositor();
  if (gpu) {
    const gpuDraws: GpuDraw[] = [];
    for (const d of draws) {
      if (!isLayerDraw(d)) {
        gpuDraws.push({ kind: 'adjust', effects: d.effects });
        continue;
      }
      const key = compositeBitmapKey(d);
      const image = bitmaps.get(key);
      if (!image) continue;
      const { dw, dh } = fitContain(image.width, image.height, W, H);
      const inverse = layerInverseMatrix(W, H, d.position, d.rotation, d.scale, dw, dh);
      if (!inverse) continue;
      gpuDraws.push({
        kind: 'layer',
        image,
        imageKey: key,
        inverse,
        opacity: d.opacity,
        blendMode: d.blendMode,
        effects: d.effects,
      });
    }
    gpu.render(W, H, comp.background, gpuDraws);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.filter = 'none';
    ctx.drawImage(gpu.canvas, 0, 0);
    ctx.restore();
    return 'gpu';
  }
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      `[composite] drawing in display colour on a 2D canvas: ${gpuUnavailableReason() ?? 'no GPU compositor'}`,
    );
  }
  drawComposite2d(ctx, W, H, comp.background, draws, bitmaps);
  return '2d';
}

/** The 2D canvas fallback: display colour, 8 bits, the canvas's own blend modes and filters. */
function drawComposite2d(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  background: string,
  draws: readonly CompositeDraw[],
  bitmaps: ReadonlyMap<string, CompositeImage>,
): void {
  ctx.clearRect(0, 0, W, H);
  for (const d of draws) {
    if (!isLayerDraw(d)) {
      adjustCanvas(ctx, W, H, effectFilter(d.effects));
      continue;
    }
    const bmp = bitmaps.get(compositeBitmapKey(d));
    if (!bmp || isLinearImage(bmp)) continue; // a float picture needs the GPU pass
    ctx.save();
    ctx.globalAlpha = clamp01(d.opacity);
    ctx.globalCompositeOperation = blendOp(d.blendMode);
    ctx.filter = effectFilter(d.effects) || 'none';
    ctx.translate(W / 2 + d.position[0], H / 2 + d.position[1]);
    ctx.rotate((d.rotation * Math.PI) / 180);
    ctx.scale(d.scale[0], d.scale[1]);
    const { dw, dh } = fitContain(bmp.width, bmp.height, W, H);
    ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  if (background) {
    // The background goes UNDER the layers, after the steps, so no step adjusts it.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

/** Re-draw the `W`×`H` canvas behind `ctx` through `filter`, replacing it: a snapshot of what
 *  is drawn, then that snapshot filtered back over it with `copy`. No-op for ''. */
function adjustCanvas(ctx: CanvasRenderingContext2D, W: number, H: number, filter: string): void {
  if (!filter) return;
  const snap = document.createElement('canvas');
  snap.width = W;
  snap.height = H;
  const sctx = snap.getContext('2d');
  if (!sctx) return;
  sctx.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'copy';
  ctx.filter = filter;
  ctx.drawImage(snap, 0, 0);
  ctx.restore();
}
