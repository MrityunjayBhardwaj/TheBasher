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
import { getComfyCapability } from '../boot';
import { useNotificationStore } from '../stores/notificationStore';
import { buildMediaClipOps, freshMediaClipId } from '../asset/importMediaClip';
import { resolveEvaluatedParam } from '../resolveEvaluatedParam';
import { createMp4Sink } from '../../render/renderAnimation';
import {
  compileBatchedWorkflow,
  comfyParamPath,
  importComfyGraph,
  type BatchedTrack,
  type ComfyApiJson,
  type ComfyGraph,
  type ComfyGraphMeta,
  type ScheduleDemotion,
} from '../../core/comfy/comfyGraph';
import type { DagState } from '../../core/dag/state';
import type { EvalCtx, NodeId } from '../../core/dag/types';
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
  const graph = importComfyGraph(gp.apiJson, meta);

  const frameStart = Math.max(0, Math.floor(numParam(params.frameStart, 0)));
  const frameEnd = Math.max(frameStart, Math.floor(numParam(params.frameEnd, 60)));
  const fps = meta.fps > 0 ? meta.fps : 30;
  const frameCount = frameEnd - frameStart + 1;
  const width = Math.max(2, Math.floor(numParam(params.width, 512)));
  const height = Math.max(2, Math.floor(numParam(params.height, 512)));

  const tracks = bakeComfyBatchedTracks(
    state,
    comfyNodeId,
    graph,
    frameStart,
    frameEnd,
    fps,
    frameCount,
  );
  const compiled = compileBatchedWorkflow(graph, tracks, { frameCount });

  // §7.4 — surface every demotion (a param that can't be scheduled in-graph keeps its
  // first-frame literal). Never a silent "it all animates".
  if (compiled.demotions.length) {
    const names = compiled.demotions.map((d) => `${d.nodeId}.${d.inputName}`).join(', ');
    notify({
      severity: 'warn',
      message: `${compiled.demotions.length} param(s) preview-only in the coherent render (kept at frame ${frameStart}): ${names}`,
    });
  }

  let frames: readonly Uint8Array[];
  try {
    const cap = await getComfyCapability();
    const res = await cap.submitBatch(compiled.apiJson, { images: {}, scalars: {} });
    frames = res.frames;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'batch submit failed';
    notify({ severity: 'error', message: `Coherent render failed: ${msg}` });
    return { ok: false, frameCount, demotions: compiled.demotions, reason: 'submit-failed' };
  }
  if (frames.length === 0) {
    notify({ severity: 'error', message: 'Coherent render produced no frames.' });
    return { ok: false, frameCount, demotions: compiled.demotions, reason: 'no-frames' };
  }

  // Stitch the batch into an MP4 (the SAME encoder the 3D Render Animation uses). If
  // WebCodecs H.264 is unavailable, fall back honestly to a notify rather than
  // mis-registering a non-video blob as a video clip (V38: never a silent degrade).
  const sink = await createMp4Sink(width, height, fps);
  if (!sink) {
    notify({
      severity: 'error',
      message: 'MP4 encoding unavailable in this browser — coherent render needs WebCodecs H.264.',
    });
    return { ok: false, frameCount, demotions: compiled.demotions, reason: 'no-mp4' };
  }
  let out;
  try {
    for (let i = 0; i < frames.length; i++) {
      const canvas = await frameToCanvas(frames[i], width, height);
      await sink.addFrame(canvas, i);
    }
    out = await sink.finish(frames.length);
  } catch (err) {
    sink.abort();
    const msg = err instanceof Error ? err.message : 'encode failed';
    notify({ severity: 'error', message: `Coherent render encode failed: ${msg}` });
    return { ok: false, frameCount, demotions: compiled.demotions, reason: 'encode-failed' };
  }

  // Persist + register as a project video MediaClip — the clip becomes a droppable
  // video layer (the on-ramp saveRenderPassesToProject uses for image passes).
  const path = `renders/comfy_batch_${comfyNodeId}.${out.ext}`;
  const storage = await pickStorage();
  await storage.write(path, new Uint8Array(await out.blob.arrayBuffer()));
  const probe: MediaProbe = {
    mediaKind: 'video',
    width,
    height,
    srcFps: fps,
    srcFrames: frames.length,
    durationSeconds: frames.length / fps,
  };
  const usedIds = new Set<string>(Object.keys(useDagStore.getState().state.nodes));
  const clipId = freshMediaClipId(usedIds);
  const name = `${meta.name} clip (${frames.length}f)`;
  useDagStore
    .getState()
    .dispatchAtomic(
      buildMediaClipOps(clipId, name, path, probe),
      'user',
      `comfy coherent render ${comfyNodeId}`,
    );
  notify({
    severity: 'success',
    message: `Rendered ${frames.length}-frame coherent clip → project (${name})`,
  });
  return { ok: true, frameCount: frames.length, path, clipId, demotions: compiled.demotions };
}

function numParam(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
