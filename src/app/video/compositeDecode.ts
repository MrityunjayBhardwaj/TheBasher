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
import { hashValue } from '../../core/dag/hash';
import {
  comfyParamPath,
  compilePreviewFrame,
  importComfyGraph,
  type BakedTrack,
  type ComfyApiJson,
  type ComfyGraphMeta,
} from '../../core/comfy/comfyGraph';
import { getComfyCapability } from '../boot';
import { useSettingsStore } from '../stores/settingsStore';
import { useNotificationStore } from '../stores/notificationStore';
import type { StorageCapability } from '../../core/storage/StorageCapability';
import type { DagState } from '../../core/dag/state';
import type { EvalCtx, NodeId } from '../../core/dag/types';
import type { CompositionParams } from '../../nodes/Composition';
import type { LayerBlendMode } from '../../nodes/types';
import { resolveEvaluatedParam } from '../resolveEvaluatedParam';
import { resolveComfyImageBindings } from './comfyImageBinding';
import { enumerateEffectStack, resolveEffectBase } from '../operatorStack';
import {
  compositeBitmapKey,
  drawComposite,
  planComposite,
  type CompositeSource,
  type EffectOp,
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

interface ResolvedComfy {
  /** The verbatim apiJson (folded into the cache key) — null when no graph. */
  readonly graphJson: unknown;
  readonly name?: string;
  /** Schedulable `<nodeId>.<inputName>` → its value AT THIS FRAME (channel sample
   *  or authored literal). Folded into the cache key so an animated param redraws. */
  readonly values: Record<string, number | string | boolean>;
  /** The first schedulable prompt (CLIPTextEncode.text) value — labels the stub. */
  readonly promptText?: string;
  /** The per-frame compiled workflow (apiJson with the resolved values substituted)
   *  — what a real /prompt submit sends (design §7.2). null when no graph. */
  readonly compiledJson: ComfyApiJson | null;
  /** Bound image inputs to upload before submit: each project-image OPFS `path` →
   *  the stable ComfyUI `name` the LoadImage input was rewritten to reference. */
  readonly imageUploads: readonly { path: string; name: string }[];
}

/** Resolve a ComfyUIWorkflow node's schedulable params at `ctx.time`: each is its
 *  bound V57 channel sample (the render-identical resolveEvaluatedParam path, H40)
 *  or the authored literal when unbound. This is the per-frame PREVIEW read (design
 *  §7.1/§7.2) — the stub renders the resolved prompt; the real submit slice feeds
 *  these into compilePreviewFrame → /prompt. STRUCTURAL params are excluded (they
 *  can't be scheduled — design §7.4). */
function resolveComfyParamsAtFrame(
  state: DagState,
  comfyNodeId: NodeId,
  graphParam: unknown,
  imageBindingsParam: unknown,
  ctx: EvalCtx,
): ResolvedComfy {
  const gp = graphParam as { apiJson?: ComfyApiJson; meta?: ComfyGraphMeta } | null | undefined;
  if (!gp?.apiJson) return { graphJson: null, values: {}, compiledJson: null, imageUploads: [] };
  const meta: ComfyGraphMeta = gp.meta ?? { name: 'workflow', importedAt: '', fps: 30, frames: 1 };
  const graph = importComfyGraph(gp.apiJson, meta);
  const values: Record<string, number | string | boolean> = {};
  const tracks: BakedTrack[] = [];
  let promptText: string | undefined;
  for (const param of graph.params) {
    if (param.scheduleHint !== 'schedulable') continue;
    const r = resolveEvaluatedParam(
      state,
      comfyNodeId,
      comfyParamPath(param.nodeId, param.inputName),
      ctx,
    );
    const v = r ? r.value : param.literal;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      values[`${param.nodeId}.${param.inputName}`] = v;
      tracks.push({ nodeId: param.nodeId, inputName: param.inputName, values: [v] });
    }
    if (
      promptText === undefined &&
      param.classType === 'CLIPTextEncode' &&
      param.inputName === 'text' &&
      typeof v === 'string'
    )
      promptText = v;
  }
  // Static image-input bindings (the generic image-source affordance, §7.1). Each
  // bound project image is treated as ONE more baked track whose value is a stable
  // ComfyUI filename: the LoadImage input is rewritten to `${name}.png`, the bytes
  // are uploaded under `name` at submit. A binding for a node/input that no longer
  // exists is skipped by compilePreviewFrame (it keeps the authored literal). The
  // filename folds into `values` so the cache key busts when the bound image changes.
  // resolveComfyImageBindings is the SHARED rewrite the batched compile reuses
  // (compileComfyBatch) — preview == compiled image handling (V81 thesis).
  const imageUploads: { path: string; filename: string }[] = [];
  for (const b of resolveComfyImageBindings(imageBindingsParam)) {
    values[`${b.nodeId}.${b.inputName}`] = b.filename;
    tracks.push({ nodeId: b.nodeId, inputName: b.inputName, values: [b.filename] });
    imageUploads.push(b.upload);
  }
  // The single-frame compiled workflow: every schedulable param + bound image input
  // substituted with its resolved-at-frame value (preview path, design §7.2).
  const compiledJson = compilePreviewFrame(graph, tracks, 0);
  return { graphJson: gp.apiJson, name: meta.name, values, promptText, compiledJson, imageUploads };
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
    // Position + scale overlay their evaluated [[V57]] channel value too (vec2),
    // so a keyframed 2D transform animates in viewer + export (H40) — same path
    // as opacity/rotation, just a 2-vector.
    const position = vec2(
      resolveEvaluatedParam(state, layerId, 'transform.position', ctx)?.value,
      vec2(t.position, [0, 0]),
    );
    const scale = vec2(
      resolveEvaluatedParam(state, layerId, 'transform.scale', ctx)?.value,
      vec2(t.scale, [1, 1]),
    );

    // The layer's source edge may pass through an EFFECT chain (Image→Image
    // operators on the V58 stack): Layer.source → topEffect … → baseMediaClip.
    // Walk down to the base source, then collect the effect chain (base→top, the
    // apply order) with each effect's EVALUATED params (channel overlay → H40).
    let source: CompositeSource | null = null;
    const effects: EffectOp[] = [];
    const srcId = firstSourceId(layer.inputs?.source);
    if (srcId) {
      const baseId = resolveEffectBase(state, srcId);
      const base = state.nodes[baseId];
      if (base && base.type === 'MediaClip') {
        const sp = base.params as Record<string, unknown>;
        const path = String(sp.src ?? '');
        if (path) {
          source = {
            kind: 'media',
            path,
            mediaKind: (sp.mediaKind as 'video' | 'image') ?? 'image',
            width: num(sp.width, 1),
            height: num(sp.height, 1),
            srcFps: num(sp.srcFps, 30),
            srcFrames: Math.max(1, num(sp.srcFrames, 1)),
          };
        }
      } else if (base && base.type === 'ComfyUIWorkflow') {
        // A ComfyUIWorkflow generator layer (inc 3). Decoded as a deterministic
        // STUB frame (CI-safe, no server) — real /prompt → /view submit is a later
        // slice. Keyframe-any-param (V81): resolve every SCHEDULABLE graph param at
        // THIS frame (a bound V57 channel sample, else the authored literal — the
        // render-identical resolveEvaluatedParam path, H40), so an animated param
        // changes the frame across a scrub. The cache key folds those resolved
        // values + the graph json → an edited or animated workflow re-renders (the
        // spine's bare `comfy:<nodeId>` carry-in fix). The stub draws the prompt.
        const cp = base.params as Record<string, unknown>;
        const resolved = resolveComfyParamsAtFrame(state, baseId, cp.graph, cp.imageBindings, ctx);
        source = {
          kind: 'comfy',
          path: `comfy:${baseId}#${hashValue({ json: resolved.graphJson, vals: resolved.values, imgs: resolved.imageUploads })}`,
          label: resolved.promptText ?? resolved.name ?? 'ComfyUI',
          comfyWorkflow: resolved.compiledJson,
          comfyImageUploads: resolved.imageUploads,
          mediaKind: 'image',
          width: num(cp.width, 512),
          height: num(cp.height, 512),
          srcFps: 30,
          srcFrames: 1,
        };
      }
      for (const entry of enumerateEffectStack(state, baseId)) {
        if (entry.muted) continue; // V58 mute-bypass — passes the frame through
        if (entry.type === 'ColorCorrect') {
          const ep = state.nodes[entry.nodeId].params as Record<string, unknown>;
          effects.push({
            type: 'ColorCorrect',
            brightness: num(
              resolveEvaluatedParam(state, entry.nodeId, 'brightness', ctx)?.value,
              num(ep.brightness, 1),
            ),
            contrast: num(
              resolveEvaluatedParam(state, entry.nodeId, 'contrast', ctx)?.value,
              num(ep.contrast, 1),
            ),
            saturation: num(
              resolveEvaluatedParam(state, entry.nodeId, 'saturation', ctx)?.value,
              num(ep.saturation, 1),
            ),
          });
        }
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
      position,
      scale,
      blendMode: (p.blendMode as LayerBlendMode) ?? 'normal',
      source,
      effects,
    });
  }
  return inputs;
}

// Decode is impure + cached module-wide. A still source (image) is content-addressed
// by its OPFS path, so one decode per path#frame serves every redraw + scrub + export.
const bitmapCache = new Map<string, ImageBitmap>();
const decoder = pickMediaDecode();
let storagePromise: Promise<StorageCapability> | null = null;

/** A deterministic RGB derived from a seed string (FNV-ish), so a ComfyUIWorkflow
 *  layer's stub frame is a stable, distinct colour per node. */
function stubColor(seed: string): [number, number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++)
    h = (Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0) >>> 0;
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff];
}

/** Decode a ComfyUIWorkflow layer's STUB frame (inc 3 spine): a deterministic
 *  solid colour (from the synthetic `comfy:<nodeId>` path) with a "ComfyUI" label,
 *  so the generator layer composites a real, distinct, CI-safe frame before the
 *  server submit lands. */
async function decodeComfyStub(source: CompositeSource): Promise<ImageBitmap | null> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, source.width);
  canvas.height = Math.max(1, source.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const [r, g, b] = stubColor(source.path);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = `${Math.max(14, Math.round(canvas.height / 16))}px sans-serif`;
  ctx.textBaseline = 'middle';
  const raw = source.label ?? 'ComfyUI';
  const label = raw.length > 26 ? `${raw.slice(0, 25)}…` : raw;
  ctx.fillText(label, Math.round(canvas.width / 12), Math.round(canvas.height / 2));
  return await createImageBitmap(canvas);
}

/** Submit a comfy layer's per-frame compiled workflow to a REAL ComfyUI server and
 *  decode the returned PNG (inc 3 real submit). Only when `comfyLiveGenerate` is on
 *  AND the capability resolved to a reachable HTTP server; otherwise (CI / offline /
 *  opt-out) the deterministic GPU-free stub. A submit failure surfaces to the asset
 *  error store (B23/B24: never silently blank) and falls back to the stub. */
async function decodeComfy(source: CompositeSource): Promise<ImageBitmap | null> {
  const live = useSettingsStore.getState().comfyLiveGenerate;
  if (live && source.comfyWorkflow) {
    try {
      const cap = await getComfyCapability();
      if (cap.kind === 'http') {
        // Read each bound image's OPFS bytes → upload under its stable name (the
        // workflow's LoadImage input was already rewritten to `${name}.png`). A
        // missing/unreadable file is skipped (the input keeps its authored literal).
        const images: Record<string, Uint8Array> = {};
        for (const up of source.comfyImageUploads ?? []) {
          try {
            storagePromise ??= pickStorage();
            images[up.filename] = await (await storagePromise).read(up.path);
          } catch (e) {
            console.warn(`composite: bound image ${up.path} unreadable`, e);
          }
        }
        const { frame } = await cap.submit(source.comfyWorkflow, { images, scalars: {} });
        const blob = new Blob([frame.slice()], { type: 'image/png' });
        return await createImageBitmap(blob);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'ComfyUI submit failed';
      // The app-root TOAST, NOT assetErrorStore — that banner mounts in the view3d
      // slot the compositor COVERS in VIDEO mode ([[H122]]), so a live-generate error
      // would be invisible exactly where it happens. notify() dedups (severity,message).
      useNotificationStore
        .getState()
        .notify({ severity: 'error', message: `ComfyUI generate failed: ${msg}` });
      // fall through to the stub so the layer still shows SOMETHING (not blank)
    }
  }
  return await decodeComfyStub(source);
}

// In-flight decodes deduped by `path#frame`. A comfy live submit takes SECONDS, and
// the composite re-renders many times meanwhile — without this, each re-render fires
// ANOTHER /prompt, piling redundant jobs on a serial GPU until each blows past the
// submit timeout and NO frame ever displays (OBSERVED: the live cube stuck on the
// stub). One decode per key in flight; concurrent callers await the same promise,
// then hit the bitmap cache.
const inFlight = new Map<string, Promise<ImageBitmap | null>>();

async function ensureBitmap(
  source: CompositeSource,
  frameIndex: number,
): Promise<ImageBitmap | null> {
  const key = `${source.path}#${frameIndex}`;
  const cached = bitmapCache.get(key);
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = decodeBitmap(source, frameIndex, key).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function decodeBitmap(
  source: CompositeSource,
  frameIndex: number,
  key: string,
): Promise<ImageBitmap | null> {
  // A ComfyUIWorkflow generator. Real submit (opt-in `comfyLiveGenerate` + a
  // reachable server) → the per-frame compiled workflow is sent to ComfyUI and a
  // REAL frame composited; otherwise the deterministic GPU-free stub (CI/offline).
  if (source.kind === 'comfy') {
    const bmp = await decodeComfy(source);
    if (bmp) bitmapCache.set(key, bmp);
    return bmp;
  }
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

// Graded frames are cached separately from the base decodes, keyed by the FULL
// compositeBitmapKey (path#frame#effectChain) — so a re-scrub / re-export with the
// same grade reuses the graded bitmap, and a param change (new effectsKey) misses.
const gradedCache = new Map<string, ImageBitmap>();

/** Apply a layer's effect chain (base → top) to a decoded frame, returning a new
 *  graded bitmap. Local effects are pure GPU canvas filters (the [[V58]] "local
 *  effects = shaders" path); the apply order is the chain order. ColorCorrect maps
 *  to canvas `brightness()/contrast()/saturate()`. PURE of the DAG. */
async function applyEffects(bmp: ImageBitmap, effects: readonly EffectOp[]): Promise<ImageBitmap> {
  const filters: string[] = [];
  for (const e of effects) {
    if (e.type === 'ColorCorrect') {
      filters.push(`brightness(${e.brightness}) contrast(${e.contrast}) saturate(${e.saturation})`);
    }
  }
  if (!filters.length) return bmp;
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return bmp;
  ctx.filter = filters.join(' ');
  ctx.drawImage(bmp, 0, 0);
  return await createImageBitmap(canvas);
}

/** Decode every planned draw's source frame (and apply its effect chain), returning
 *  a map keyed by compositeBitmapKey (the same key drawComposite looks up — now
 *  effect-aware). A draw that fails to decode is simply absent → drawComposite skips
 *  it (no throw, no blank crash). */
export async function decodeDraws(
  draws: readonly LayerComposite[],
): Promise<Map<string, ImageBitmap>> {
  const map = new Map<string, ImageBitmap>();
  await Promise.all(
    draws.map(async (d) => {
      const key = compositeBitmapKey(d);
      const cachedGraded = gradedCache.get(key);
      if (cachedGraded) {
        map.set(key, cachedGraded);
        return;
      }
      const base = await ensureBitmap(d.source, d.sourceFrameIndex);
      if (!base) return;
      if (!d.effects.length) {
        map.set(key, base); // no grade → the base IS the frame (key ends in '#')
        return;
      }
      const graded = await applyEffects(base, d.effects);
      gradedCache.set(key, graded);
      map.set(key, graded);
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
