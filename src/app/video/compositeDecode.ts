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
  isComfyLink,
  type ComfyApiJson,
  type ComfyGraphMeta,
  type ComfyInputValue,
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
import { resolveComfyImageBindings, type ComfyImageUpload } from './comfyImageBinding';
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
  /** The submittable workflow: the imported apiJson with bound media inputs applied.
   *  STATIC (no per-frame param substitution — the inference preview compiler is
   *  retired); scalar animation is observed via 🎬 Render coherent clip. null = no graph. */
  readonly compiledJson: ComfyApiJson | null;
  /** Bound media inputs to upload before submit: each project-asset OPFS `path` → the
   *  stable ComfyUI `filename` the LoadImage/LoadVideo input was rewritten to reference. */
  readonly imageUploads: readonly ComfyImageUpload[];
}

/** Build a ComfyUIWorkflow layer's STATIC composite source: the imported graph with its
 *  bound media inputs applied (the generic image/video affordance), ready to STUB or
 *  submit ONCE. No per-frame param substitution — the comfy layer is a static preview (a
 *  stub, or a single live render), stable across a scrub. Keyframed scalar params are
 *  observed via 🎬 Render coherent clip (the auto-injected-controller batch), NOT a
 *  per-frame scrub: the legacy inference preview compiler (importComfyGraph +
 *  compilePreviewFrame) is retired (docs/COMFYUI-BASHER-NODES.md). The media-binding
 *  rewrite mirrors the coherent render's applyComfyImageBindings (preview == compiled). */
function resolveComfySource(graphParam: unknown, imageBindingsParam: unknown): ResolvedComfy {
  const gp = graphParam as { apiJson?: ComfyApiJson; meta?: ComfyGraphMeta } | null | undefined;
  if (!gp?.apiJson) return { graphJson: null, compiledJson: null, imageUploads: [] };
  const meta: ComfyGraphMeta = gp.meta ?? { name: 'workflow', importedAt: '', fps: 30, frames: 1 };
  // Apply each bound media input onto a clone (the SAME rewrite the coherent render does).
  // A binding whose node is missing / now wired is skipped (keeps the authored literal).
  const compiledJson = structuredClone(gp.apiJson) as ComfyApiJson;
  const imageUploads: ComfyImageUpload[] = [];
  for (const b of resolveComfyImageBindings(imageBindingsParam)) {
    const target = compiledJson[b.nodeId];
    if (!target || !target.inputs || isComfyLink(target.inputs[b.inputName])) continue;
    (target.inputs as Record<string, ComfyInputValue>)[b.inputName] = b.filename;
    imageUploads.push(b.upload);
  }
  return { graphJson: gp.apiJson, name: meta.name, compiledJson, imageUploads };
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
        // A ComfyUIWorkflow generator layer. Decoded as a deterministic STUB frame
        // (CI-safe, no server), or a SINGLE live render when comfyLiveGenerate is on.
        // STATIC: the comfy layer no longer recompiles per frame — keyframed scalar
        // params are observed via 🎬 Render coherent clip (the auto-injected-controller
        // batch), not a per-frame scrub (the inference preview compiler is retired). The
        // cache key folds the graph json + bound media → an edited workflow or a changed
        // binding re-renders, but a scrub does not. The stub draws the workflow name.
        const cp = base.params as Record<string, unknown>;
        const resolved = resolveComfySource(cp.graph, cp.imageBindings);
        source = {
          kind: 'comfy',
          path: `comfy:${baseId}#${hashValue({ json: resolved.graphJson, imgs: resolved.imageUploads })}`,
          label: resolved.name ?? 'ComfyUI',
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

// A BOUNDED, LRU ImageBitmap cache (#253). ImageBitmaps hold decoded/GPU memory that
// only `.close()` releases; an unbounded Map (the old caches) grew one entry per
// decoded frame, so a long scrub or — fatally — a full video EXPORT (thousands of
// frames) climbed until the tab was OOM-killed. LRU with a cap: the working set for
// one composited frame (its layers) plus scrub headroom stays hot; older frames are
// evicted and their bitmaps closed as new ones arrive. The cap must exceed the layer
// count of any single frame (a frame's draws are all set before it's drawn, so an
// undersized cap could close a bitmap still needed this frame) — 64 is far above any
// realistic simultaneous-layer count while bounding export memory.
const MAX_CACHED_BITMAPS = 64;

export class BitmapLRU {
  private map = new Map<string, ImageBitmap>();
  constructor(private readonly max: number) {}
  get(key: string): ImageBitmap | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key); // re-insert → most-recently-used (moves to the end)
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, bmp: ImageBitmap): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, bmp);
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value as string;
      const old = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      old?.close?.(); // release the decoded/GPU memory promptly (not just GC)
    }
  }
  /** Close every cached bitmap and empty the cache (project switch / teardown). */
  clear(): void {
    for (const b of this.map.values()) b.close?.();
    this.map.clear();
  }
}

// Decode is impure + cached module-wide. A still source (image) is content-addressed
// by its OPFS path, so one decode per path#frame serves every redraw + scrub + export.
const bitmapCache = new BitmapLRU(MAX_CACHED_BITMAPS);
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
    // V38 — a decode failure must SURFACE, not silently blank the layer. Route to
    // the app-root toast (NOT assetErrorStore — its banner mounts in the view3d
    // slot the compositor COVERS in VIDEO mode, [[H122]], so it'd be invisible
    // exactly here). notify() dedups on (severity, message), so we key the message
    // to the SOURCE (label/path), not the frame index — a whole unreadable clip
    // raises ONE toast, not one per exported frame. (#254)
    console.warn(`composite: failed to decode ${source.path}#${frameIndex}`, err);
    const name = source.label ?? source.path;
    useNotificationStore
      .getState()
      .notify({ severity: 'error', message: `Video layer failed to decode: ${name}` });
    return null;
  }
}

// Graded frames are cached separately from the base decodes, keyed by the FULL
// compositeBitmapKey (path#frame#effectChain) — so a re-scrub / re-export with the
// same grade reuses the graded bitmap, and a param change (new effectsKey) misses.
// Bounded LRU for the same OOM reason as bitmapCache (#253).
const gradedCache = new BitmapLRU(MAX_CACHED_BITMAPS);

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
