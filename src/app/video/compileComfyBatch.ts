// compileComfyBatch — the COMPILED COHERENT path (design §7.3 / §12, Inc 4). Unlike
// the per-frame preview decode (compositeDecode.decodeComfy → N independent /prompt
// runs, incoherent), this is a deliberate, heavy "Render coherent clip" ACTION: it
// bakes every keyframed schedulable param over the node's [frameStart, frameEnd]
// range into ONE batched workflow (compileBatchedWorkflow), submits it as a single
// batch (cap.submitBatch → N frames), and stitches the frames into an MP4 — reusing
// the SAME createMp4Sink the 3D Render Animation uses. The MP4 is written to OPFS and
// registered as a project video MediaClip (the shipped saveRenderPassesToProject
// on-ramp), so the coherent clip becomes a droppable video layer — the loop closes.
//
// ONE baker feeds preview == compiled (the V81 thesis): both sample each param via
// the render-identical resolveEvaluatedParam (H40). Preview bakes at one frame; this
// bakes the array over the range.
//
// Coherence is delegated to the imported workflow's temporal model (AnimateDiff /
// native video) — BasherValueSchedule only injects the per-frame array (design §3;
// the bridge node is an arm's-length GPL extension, never vendored). On a plain
// text2img graph the batch is N independent latents; coherence needs a temporal
// workflow + its models (Slice 4, license-gated).
//
// REF: docs/COMFYUI-KEYFRAME-COMPILER-DESIGN.md §7.1/§7.3/§8/§12; src/core/comfy/
//      comfyGraph.ts (compileBatchedWorkflow); src/render/renderAnimation.ts
//      (createMp4Sink); src/app/saveRenderPassesToProject.ts (the MediaClip on-ramp);
//      vyapti V81; hetvabhasa H122 (toast, not banner) / H125 (in-flight dedup).

import { useDagStore } from '../../core/dag/store';
import { pickStorage } from '../../core/storage';
import { comfyHasNodeTypes, type ComfyProgressEvent } from '../../core/comfy';
import { getComfyCapability } from '../boot';
import { useNotificationStore } from '../stores/notificationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useComfyRenderProgressStore } from '../stores/comfyRenderProgressStore';
import { buildMediaClipOps, freshMediaClipId } from '../asset/importMediaClip';
import { resolveEvaluatedParam } from '../resolveEvaluatedParam';
import { resolveComfyImageBindings, type ComfyImageUpload } from './comfyImageBinding';
import {
  comfyControllerPath,
  hasBasherControllers,
  isScalarControllerKind,
  scanBasherControllers,
  writeBasherControllerValues,
  type BasherControllerDecl,
} from '../../core/comfy/basherControllers';
import { scanBasherExports } from '../../core/comfy/basherExports';
import { createMp4Sink } from '../../render/renderAnimation';
import {
  compileBatchedWorkflow,
  comfyParamPath,
  importComfyGraph,
  isComfyLink,
  type BatchedTrack,
  type ComfyApiJson,
  type ComfyGraph,
  type ComfyGraphMeta,
  type ComfyInputValue,
  type ScheduleDemotion,
} from '../../core/comfy/comfyGraph';
import type { DagState } from '../../core/dag/state';
import type { EvalCtx, NodeId, Op } from '../../core/dag/types';
import type { MediaProbe } from '../../core/media';

export interface CompileComfyBatchResult {
  readonly ok: boolean;
  /** Number of frames the batch produced (= range length on success). */
  readonly frameCount: number;
  /** The OPFS path the stitched clip was written to (on success). */
  readonly path?: string;
  /** The MediaClip node registered for the clip (on success). */
  readonly clipId?: NodeId;
  /** Params the compiler could not schedule in-graph — surfaced, never silent (§7.4). */
  readonly demotions: readonly ScheduleDemotion[];
  readonly reason?: string;
}

/** Bake every SCHEDULABLE param of an imported workflow to a per-frame array over
 *  [frameStart, frameEnd] — the batched generalization of resolveComfyParamsAtFrame's
 *  single-frame read. Each frame samples the render-identical resolveEvaluatedParam
 *  (a bound V57 channel sample, else the authored literal — H40), so the compiled
 *  batch matches preview + dopesheet. classType + valueKind ride along so the compiler
 *  can pick the schedule-node variant and demote what it can't schedule. */
export function bakeComfyBatchedTracks(
  state: DagState,
  comfyNodeId: NodeId,
  graph: ComfyGraph,
  frameStart: number,
  frameEnd: number,
  fps: number,
  durationFrames: number,
): BatchedTrack[] {
  const n = Math.max(1, frameEnd - frameStart + 1);
  const tracks: BatchedTrack[] = [];
  for (const param of graph.params) {
    if (param.scheduleHint !== 'schedulable') continue;
    const values: (number | string | boolean)[] = [];
    for (let i = 0; i < n; i++) {
      const frame = frameStart + i;
      const seconds = fps > 0 ? frame / fps : 0;
      const ctx: EvalCtx = {
        time: { frame, seconds, normalized: durationFrames > 0 ? frame / durationFrames : 0 },
      };
      const r = resolveEvaluatedParam(
        state,
        comfyNodeId,
        comfyParamPath(param.nodeId, param.inputName),
        ctx,
      );
      const v = r ? r.value : param.literal;
      values.push(
        typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
          ? v
          : param.literal,
      );
    }
    // An image param is handled by the dedicated image-binding rewrite (a static
    // bound image → ONE upload, the same filename every frame — applyComfyImageBindings),
    // not an in-graph schedule. Only surface it as a track here when it genuinely
    // VARIES across the range — a reference-travel (KeyframeChannelImage) the compiler
    // can't schedule yet, so it must demote honestly (§7.4) rather than be dropped. A
    // CONSTANT image (the authored literal, or a static binding) needs no track: the
    // binding rewrite sets it, and an unbound literal stays as authored.
    if (param.valueKind === 'image' && values.every((x) => x === values[0])) continue;
    tracks.push({
      nodeId: param.nodeId,
      inputName: param.inputName,
      classType: param.classType,
      valueKind: param.valueKind,
      values,
    });
  }
  return tracks;
}

/** Bake each scalar `basher_controller`'s curve to a per-frame array over [frameStart,
 *  frameEnd] — the Mode-A (controller contract) generalization of bakeComfyBatchedTracks.
 *  Each frame samples the render-identical resolveEvaluatedParam on the controller's V57
 *  paramPath (`controller:<nodeId>`), falling back to the controller's declared default
 *  when no channel is bound (an un-animated render → a constant array → a single value).
 *  Returns the node-id → array map writeBasherControllerValues injects. No manifest, no
 *  classification, no rewire — the author already wired the controller to its target. */
export function bakeBasherControllerValues(
  state: DagState,
  comfyNodeId: NodeId,
  decls: readonly BasherControllerDecl[],
  frameStart: number,
  frameEnd: number,
  fps: number,
  durationFrames: number,
): Record<string, (number | string | boolean)[]> {
  const n = Math.max(1, frameEnd - frameStart + 1);
  const out: Record<string, (number | string | boolean)[]> = {};
  for (const decl of decls) {
    const values: (number | string | boolean)[] = [];
    for (let i = 0; i < n; i++) {
      const frame = frameStart + i;
      const seconds = fps > 0 ? frame / fps : 0;
      const ctx: EvalCtx = {
        time: { frame, seconds, normalized: durationFrames > 0 ? frame / durationFrames : 0 },
      };
      const r = resolveEvaluatedParam(state, comfyNodeId, comfyControllerPath(decl.nodeId), ctx);
      const v = r ? r.value : decl.defaultValue;
      values.push(
        typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
          ? v
          : decl.defaultValue,
      );
    }
    out[decl.nodeId] = values;
  }
  return out;
}

/** Rewrite each statically-bound image input in a compiled batched workflow to its
 *  stable upload filename (mutating `apiJson` in place) and return the uploads to read
 *  + send. A binding whose node is missing or whose input is now wired is skipped (it
 *  keeps the authored literal) — the SAME guard compilePreviewFrame applies, so the
 *  batched image handling matches the per-frame preview (the V81 preview==compiled
 *  thesis). A static bound image is constant across the batch → ONE upload, the same
 *  name on every frame; a keyframed/varying image is reference-travel, demoted by the
 *  compiler and never reaching here. */
export function applyComfyImageBindings(
  apiJson: ComfyApiJson,
  imageBindingsParam: unknown,
): ComfyImageUpload[] {
  const uploads: ComfyImageUpload[] = [];
  for (const b of resolveComfyImageBindings(imageBindingsParam)) {
    const target = apiJson[b.nodeId];
    if (!target || !target.inputs || isComfyLink(target.inputs[b.inputName])) continue;
    (target.inputs as Record<string, ComfyInputValue>)[b.inputName] = b.filename;
    uploads.push(b.upload);
  }
  return uploads;
}

/** Draw a decoded PNG frame onto a fixed width×height canvas (the comfy node's output
 *  descriptor). Stub frames are 1×1 → scaled to fill; real frames match → 1:1. The
 *  fixed size keeps the MP4 encoder's config valid across the whole batch. */
async function frameToCanvas(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const blob = new Blob([bytes.slice()], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  return canvas;
}

/**
 * Render the selected ComfyUIWorkflow layer's keyframes as ONE coherent batched clip.
 * bake → compileBatchedWorkflow → submitBatch → MP4 → OPFS → project video MediaClip.
 * Surfaces every outcome (including compile demotions and an unreachable/stub server)
 * through the app-root toast — never the view3d-covered banner (H122), never silent.
 */
export async function compileComfyBatch(comfyNodeId: NodeId): Promise<CompileComfyBatchResult> {
  const notify = useNotificationStore.getState().notify;
  const state = useDagStore.getState().state;
  const node = state.nodes[comfyNodeId];
  const params = (node?.params ?? {}) as Record<string, unknown>;
  const gp = params.graph as { apiJson?: ComfyApiJson; meta?: ComfyGraphMeta } | null | undefined;
  if (!gp?.apiJson) {
    notify({ severity: 'error', message: 'No workflow to render — import or add a graph first.' });
    return { ok: false, frameCount: 0, demotions: [], reason: 'no-graph' };
  }
  const meta: ComfyGraphMeta = gp.meta ?? { name: 'workflow', importedAt: '', fps: 30, frames: 1 };

  const frameStart = Math.max(0, Math.floor(numParam(params.frameStart, 0)));
  const frameEnd = Math.max(frameStart, Math.floor(numParam(params.frameEnd, 60)));
  const fps = meta.fps > 0 ? meta.fps : 30;
  const frameCount = frameEnd - frameStart + 1;
  const width = Math.max(2, Math.floor(numParam(params.width, 512)));
  const height = Math.max(2, Math.floor(numParam(params.height, 512)));

  // DISPATCH (docs/COMFYUI-BASHER-NODES.md): a workflow that declares basher_controller
  // nodes opts into the CONTROLLER CONTRACT (Mode A) — Basher drives the author-declared
  // nodes and never walks the foreign graph. Otherwise fall back to the legacy inference
  // compiler (Mode B — the previous approach). Both yield {apiJson, scheduleNodeIds,
  // demotions} so the submit → MP4 → MediaClip tail is shared.
  let compiled: {
    apiJson: ComfyApiJson;
    scheduleNodeIds: readonly string[];
    demotions: readonly ScheduleDemotion[];
  };
  if (hasBasherControllers(gp.apiJson)) {
    // Mode A — the author wired each basher_controller into its target. Bake every
    // SCALAR controller's channel and write its array onto the node (the inline
    // transport); IMAGE controllers travel out-of-band — their bound bytes upload +
    // their `image` input rewrites via the shared applyComfyImageBindings below (the
    // SAME machinery Mode-B LoadImage rows use), so nothing extra is needed here.
    const allDecls = scanBasherControllers(gp.apiJson);
    const scalarDecls = allDecls.filter((d) => isScalarControllerKind(d.kind));
    const valuesById = bakeBasherControllerValues(
      state,
      comfyNodeId,
      scalarDecls,
      frameStart,
      frameEnd,
      fps,
      frameCount,
    );
    compiled = {
      apiJson: writeBasherControllerValues(gp.apiJson, valuesById),
      // EVERY basher_controller (scalar OR media) is authored INTO the graph, so the
      // extension must be installed — surface ALL of them via the presence check (else
      // an image-only controller workflow would skip the check and 400 opaquely).
      scheduleNodeIds: allDecls.map((d) => d.nodeId),
      demotions: [],
    };
  } else {
    // Mode B — the legacy inference compiler (the previous approach).
    const graph = importComfyGraph(gp.apiJson, meta);
    const tracks = bakeComfyBatchedTracks(
      state,
      comfyNodeId,
      graph,
      frameStart,
      frameEnd,
      fps,
      frameCount,
    );
    compiled = compileBatchedWorkflow(graph, tracks, { frameCount });
  }

  // Image inputs (the 3D-scene-as-control-rig thesis: a depth/normal pass bound to a
  // LoadImage → img2img). Rewrite each statically-bound image input in the compiled
  // batch to its stable upload filename and collect the bytes to read — the SAME
  // rewrite the per-frame preview decode applies, so "Render coherent clip" is driven
  // by the bound passes end-to-end, not just the live scrub preview.
  const imageUploads = applyComfyImageBindings(compiled.apiJson, params.imageBindings);

  // The OUTPUT half of the contract (docs/COMFYUI-BASHER-NODES.md): a declared
  // basher_export is the author's collection point. When present, each export's frames
  // become their OWN project MediaClip (routed via the submit result's framesByNode);
  // absent → the legacy "every output image → one clip" path. Export nodes are authored
  // INTO the graph, so the extension must be installed — fold their ids into the
  // presence check alongside the controllers.
  const exportDecls = scanBasherExports(gp.apiJson);
  const extensionNodeIds = [...compiled.scheduleNodeIds, ...exportDecls.map((e) => e.nodeId)];

  // §7.4 — surface every demotion (a param that can't be scheduled in-graph keeps its
  // first-frame literal). Never a silent "it all animates".
  if (compiled.demotions.length) {
    const names = compiled.demotions.map((d) => `${d.nodeId}.${d.inputName}`).join(', ');
    notify({
      severity: 'warn',
      message: `${compiled.demotions.length} param(s) preview-only in the coherent render (kept at frame ${frameStart}): ${names}`,
    });
  }

  // Live progress surface (slice 5b): begin now, feed the /ws stream into the store,
  // and end() in the outer finally so the bar clears on EVERY exit (success or any
  // early-return failure). The store reads fresh state per event (the captured handle
  // would be stale for executing's value/max carry-over).
  const progress = useComfyRenderProgressStore.getState();
  progress.begin(meta.name);
  const onProgress = (e: ComfyProgressEvent) => {
    const st = useComfyRenderProgressStore.getState();
    if (e.kind === 'progress') st.setProgress(e.value, e.max, e.node);
    else if (e.kind === 'executing') st.setProgress(st.value, st.max, e.node);
    else if (e.kind === 'preview') st.setPreview(e.bytes, e.mime);
  };
  try {
    let frames: readonly Uint8Array[];
    let framesByNode: Readonly<Record<string, readonly Uint8Array[]>> | undefined;
    try {
      const cap = await getComfyCapability();
      // A compiled batch with schedule nodes needs the BasherSchedule extension
      // installed on a REAL server — else /prompt rejects the unknown node type with
      // an opaque 400. Detect it up front (the stub accepts anything → skip the check)
      // and surface an actionable message instead of an opaque failure (§16 Q-E).
      if (cap.kind === 'http' && extensionNodeIds.length > 0) {
        const types = extensionNodeIds.map((id) => compiled.apiJson[id].class_type);
        const { comfyUrl, comfyAuthHeader } = useSettingsStore.getState();
        const installed = await comfyHasNodeTypes(types, comfyUrl, {
          authHeader: comfyAuthHeader || undefined,
        });
        if (!installed) {
          notify({
            severity: 'error',
            message:
              'Coherent render needs the BasherSchedule extension — install it in ComfyUI/custom_nodes and restart, or remove the animated params.',
          });
          return { ok: false, frameCount, demotions: compiled.demotions, reason: 'bridge-missing' };
        }
      }
      // Read each bound image's OPFS bytes → upload under its stable name (the
      // workflow's LoadImage input was already rewritten to `${name}.png`). A
      // missing/unreadable file is skipped (surfaced via console.warn) → the server
      // errors on the absent filename → the submit catch toasts it (never silent).
      const images: Record<string, Uint8Array> = {};
      if (imageUploads.length) {
        const storage = await pickStorage();
        for (const up of imageUploads) {
          try {
            images[up.filename] = await storage.read(up.path);
          } catch (e) {
            console.warn(`comfy batch: bound image ${up.path} unreadable`, e);
          }
        }
      }
      const res = await cap.submitBatch(compiled.apiJson, { images, scalars: {} }, onProgress);
      frames = res.frames;
      framesByNode = res.framesByNode;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'batch submit failed';
      notify({ severity: 'error', message: `Coherent render failed: ${msg}` });
      return { ok: false, frameCount, demotions: compiled.demotions, reason: 'submit-failed' };
    }
    if (frames.length === 0) {
      notify({ severity: 'error', message: 'Coherent render produced no frames.' });
      return { ok: false, frameCount, demotions: compiled.demotions, reason: 'no-frames' };
    }

    // Plan the clips to register. With declared basher_export sinks → ONE clip per
    // export, from that export node's frames (the author-declared collection); else ONE
    // clip from the flat frames (the legacy collect-everything path). A declared export
    // that produced no frames is dropped with a warning (never silently — §7.4/V38).
    interface ClipPlan {
      readonly frames: readonly Uint8Array[];
      readonly name: string;
      readonly suffix: string;
    }
    let plans: ClipPlan[];
    if (exportDecls.length > 0) {
      plans = exportDecls
        .map((e) => ({
          frames: framesByNode?.[e.nodeId] ?? [],
          name: e.name,
          suffix: `_${e.nodeId}`,
        }))
        .filter((p) => p.frames.length > 0);
      const empty = exportDecls.length - plans.length;
      if (empty > 0) {
        notify({
          severity: 'warn',
          message: `${empty} basher_export node(s) produced no frames (skipped).`,
        });
      }
      if (plans.length === 0) {
        notify({
          severity: 'error',
          message: 'Coherent render produced no frames for the declared basher_export node(s).',
        });
        return { ok: false, frameCount, demotions: compiled.demotions, reason: 'no-frames' };
      }
    } else {
      plans = [{ frames, name: `${meta.name} clip`, suffix: '' }];
    }

    // Stitch each plan into an MP4 (the SAME encoder the 3D Render Animation uses) and
    // register it as a project video MediaClip — the clip becomes a droppable layer (the
    // on-ramp saveRenderPassesToProject uses). All clips land in ONE atomic dispatch (one
    // undo). WebCodecs absence → an honest notify, never a mis-registered non-video blob.
    const storage = await pickStorage();
    const usedIds = new Set<string>(Object.keys(useDagStore.getState().state.nodes));
    const ops: Op[] = [];
    const registered: { name: string; path: string; clipId: NodeId; count: number }[] = [];
    for (const plan of plans) {
      const sink = await createMp4Sink(width, height, fps);
      if (!sink) {
        notify({
          severity: 'error',
          message:
            'MP4 encoding unavailable in this browser — coherent render needs WebCodecs H.264.',
        });
        return { ok: false, frameCount, demotions: compiled.demotions, reason: 'no-mp4' };
      }
      let out;
      try {
        for (let i = 0; i < plan.frames.length; i++) {
          const canvas = await frameToCanvas(plan.frames[i], width, height);
          await sink.addFrame(canvas, i);
        }
        out = await sink.finish(plan.frames.length);
      } catch (err) {
        sink.abort();
        const msg = err instanceof Error ? err.message : 'encode failed';
        notify({ severity: 'error', message: `Coherent render encode failed: ${msg}` });
        return { ok: false, frameCount, demotions: compiled.demotions, reason: 'encode-failed' };
      }
      const path = `renders/comfy_batch_${comfyNodeId}${plan.suffix}.${out.ext}`;
      await storage.write(path, new Uint8Array(await out.blob.arrayBuffer()));
      const probe: MediaProbe = {
        mediaKind: 'video',
        width,
        height,
        srcFps: fps,
        srcFrames: plan.frames.length,
        durationSeconds: plan.frames.length / fps,
      };
      const clipId = freshMediaClipId(usedIds);
      usedIds.add(clipId);
      const name = `${plan.name} (${plan.frames.length}f)`;
      ops.push(...buildMediaClipOps(clipId, name, path, probe));
      registered.push({ name, path, clipId, count: plan.frames.length });
    }
    useDagStore.getState().dispatchAtomic(ops, 'user', `comfy coherent render ${comfyNodeId}`);
    const first = registered[0];
    notify({
      severity: 'success',
      message:
        registered.length === 1
          ? `Rendered ${first.count}-frame coherent clip → project (${first.name})`
          : `Rendered ${registered.length} coherent clips → project (${registered.map((r) => r.name).join(', ')})`,
    });
    return {
      ok: true,
      frameCount: first.count,
      path: first.path,
      clipId: first.clipId,
      demotions: compiled.demotions,
    };
  } finally {
    progress.end();
  }
}

function numParam(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
