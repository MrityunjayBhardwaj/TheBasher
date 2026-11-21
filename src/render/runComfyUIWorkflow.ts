// runComfyUIWorkflow — the impure side of P5's AI render bridge.
//
// Walks the frame range described by a ComfyUIWorkflow node, compiles each
// frame of its workflow FILE from the file's Basher markers (#1715 —
// `compileWorkflowFrame`), submits it through the configured
// ComfyUICapability, writes each output's picture through StorageCapability
// at the canonical D-04 path, and reports outputs. A marker fed from one of
// the file's own outputs (`feedback_of`) gets that output's picture from the
// frame before; on the first frame it gets its own file, or black.
//
// Compose ≠ Execute split (krama K10 — extends K4): the DAG describes
// the plan via the Mutator chain (Wave C); this function realizes it.
// V8 file-rooted: NO Op emission from this directory. The caller wraps
// runComfyUIWorkflow with a dispatch seam (src/app/render/runWorkflow.ts
// in B2) so writebacks land through the standard Op pipeline.
//
// Resume contract (D-06 sister): on mid-flight failure, the function
// throws with the failing frame index in the error message and the
// `outputs` array populated up to the last good frame. The caller is
// responsible for writing back `lastGoodFrame = N - 1` via setParam Op.
//
// H19 mitigation: state mutations during async hops are kept local. We
// re-resolve the workflow node from `state.nodes[id]` once at start; if
// the caller wants to react to params changes mid-run it must cancel
// and restart. No captured `dagStore.getState()` snapshots.
//
// REF: project_p5_plan B1; vyapti V6 (capability) + V8 (file-rooted) +
// V10 (defensive defaults); hetvabhasa H19 (stale snapshot), H22 (BFS
// isolation, here under live D-01 stylized output reuse).

import type { ComfyUICapability } from '../core/comfy';
import { createEvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeId } from '../core/dag/types';
import type { StorageCapability } from '../core/storage';
import { WHOLE_WORKFLOW_OUTPUT } from '../nodes/ComfyUIWorkflow';
import {
  framePath,
  outputPathOf,
  runFrameEnd,
  workflowInputsAt,
  workflowNodeOf,
  type CompileWorkflowFn,
  type ControllerValueAt,
} from './dryRun';

export interface RunComfyUIWorkflowDeps {
  readonly capability: ComfyUICapability;
  readonly storage: StorageCapability;
  readonly compileWorkflow: CompileWorkflowFn;
  /**
   * Called after each frame's bytes are written, before advancing to the
   * next frame. The caller is expected to dispatch a setParam Op writing
   * `lastGoodFrame = frame` so a subsequent run resumes correctly.
   *
   * V8: callback contract — runComfyUIWorkflow does NOT dispatch. The
   * caller (src/app/render/runWorkflow.ts) wraps this in dispatchAtomic.
   */
  readonly onFrameComplete: (frame: number) => void;
  /** #1715 — keyed values of unwired number / text inputs (see {@link ControllerValueAt}). */
  readonly controllerValue?: ControllerValueAt;
}

export interface RunComfyUIWorkflowReport {
  readonly workflowId: NodeId;
  readonly framesWritten: number;
  /** Output paths in dispatch order. */
  readonly outputs: readonly string[];
  /** Last frame whose bytes landed successfully. -1 if no frame completed. */
  readonly lastGoodFrame: number;
}

/**
 * Walks frames [max(frameStart, lastGoodFrame + 1), frameEnd] for the
 * ComfyUIWorkflow at `workflowNodeId`. Returns a report listing the
 * paths produced. On failure: throws with a partial-report message;
 * `outputs` populated up to the last good frame; `lastGoodFrame` in
 * the report still reflects the last successful frame.
 */
export async function runComfyUIWorkflow(
  workflowNodeId: NodeId,
  state: DagState,
  deps: RunComfyUIWorkflowDeps,
): Promise<RunComfyUIWorkflowReport> {
  // V10: defensive defaults at every destructured field. Legacy projects
  // may have hydrated without `lastGoodFrame` / `frameEnd` if they were
  // saved before P5 schema landed.
  const { params, sockets, apiJson } = workflowNodeOf(state, workflowNodeId, 'runComfyUIWorkflow');
  const frameStart = params.frameStart ?? 0;
  // #1946 — a still-only workflow runs over its first frame alone.
  const frameEnd = runFrameEnd(params, sockets);
  const lastGoodFrame = params.lastGoodFrame ?? -1;
  const outputPath = params.outputPath ?? '';
  if (!outputPath) {
    throw new Error(
      `runComfyUIWorkflow: workflow "${workflowNodeId}" has empty outputPath. Run the addAIPass Mutator first to author the path.`,
    );
  }

  // Resume: start at lastGoodFrame + 1 (clamped to frameStart on first run).
  const start = Math.max(frameStart, lastGoodFrame + 1);
  if (start > frameEnd) {
    return {
      workflowId: workflowNodeId,
      framesWritten: 0,
      outputs: [],
      lastGoodFrame,
    };
  }

  if (sockets.outputs.length === 0) {
    throw new Error(
      `runComfyUIWorkflow: workflow "${workflowNodeId}"'s file has no Basher output to read.`,
    );
  }

  // #1318 — ONE evaluator cache for the whole run: `state` doesn't change during it, so a
  // pure node (a character's whole-clip retarget above all) is evaluated once, not once per
  // frame. Correct across frames by construction: a time-dependent node's cache key carries
  // the frame, a pure one's doesn't (`evaluator.ts`). Values held are descriptors, not pixels.
  const cache = createEvaluatorCache();
  const outputs: string[] = [];
  let lastCompletedFrame = lastGoodFrame;
  const pathOf = (socket: string) => outputPathOf(outputPath, sockets, socket);

  for (let frame = start; frame <= frameEnd; frame++) {
    const ctx = ctxForFrame(frame);
    const inputs = workflowInputsAt(
      state,
      workflowNodeId,
      sockets,
      ctx,
      cache,
      deps.controllerValue,
    );
    // Feedback: a fed marker reads its output's picture from the frame before. The first frame
    // of the range has none (null); a resumed run still finds the frame before on disk.
    const fed = Object.fromEntries(
      sockets.fed.map((f) => [
        f.nodeId,
        frame > frameStart ? framePath(pathOf(f.from), frame - 1) : null,
      ]),
    );

    const { workflowJson, inputs: compiled } = await deps.compileWorkflow({
      apiJson,
      frame,
      inputs,
      fed,
      workflowOutputPath: outputPath,
    });

    let result;
    try {
      result = await deps.capability.submitBatch(workflowJson, compiled);
    } catch (err) {
      const wrapped =
        err instanceof Error
          ? new Error(
              `runComfyUIWorkflow: capability submit failed at frame ${frame}: ${err.message}`,
            )
          : new Error(`runComfyUIWorkflow: capability submit failed at frame ${frame}`);
      // Stash partial report on the error for diagnostic value; caller
      // can read err.partialReport to learn what was written.
      (wrapped as Error & { partialReport?: RunComfyUIWorkflowReport }).partialReport = {
        workflowId: workflowNodeId,
        framesWritten: outputs.length,
        outputs: outputs.slice(),
        lastGoodFrame: lastCompletedFrame,
      };
      throw wrapped;
    }

    // Each output's picture for this frame, at its own path. The first output's path is the
    // one reported (what the stitch reads).
    for (const [i, out] of sockets.outputs.entries()) {
      const bytes =
        result.framesByNode?.[out.nodeId]?.[0] ??
        (i === 0 || out.nodeId === WHOLE_WORKFLOW_OUTPUT ? result.frames[0] : undefined);
      if (!bytes) {
        throw new Error(
          `runComfyUIWorkflow: ComfyUI returned no picture for "${out.socket}" at frame ${frame}.`,
        );
      }
      const path = framePath(pathOf(out.socket), frame);
      await deps.storage.write(path, bytes);
      if (i === 0) outputs.push(path);
    }
    lastCompletedFrame = frame;
    deps.onFrameComplete(frame);
  }

  return {
    workflowId: workflowNodeId,
    framesWritten: outputs.length,
    outputs,
    lastGoodFrame: lastCompletedFrame,
  };
}

/**
 * Constructs an EvalCtx for a given frame at the workflow's fixed 30fps
 * cadence (THESIS §49: time enters as a socket). The ComfyUIWorkflow
 * node DOES NOT carry an `fps` param — it inherits 30 from the project
 * convention (matching RenderJob default). v0.6 broadens this if a
 * per-workflow fps becomes a real ask.
 */
function ctxForFrame(frame: number): EvalCtx {
  const fps = 30;
  return {
    time: { frame, seconds: frame / fps, normalized: 0 },
  };
}
