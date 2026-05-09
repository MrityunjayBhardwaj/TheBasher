// runComfyUIWorkflow — the impure side of P5's AI render bridge.
//
// Walks the frame range described by a ComfyUIWorkflow node, submits each
// frame through the configured ComfyUICapability (passes the prev frame's
// stylized output as ControlNet conditioning when available), writes
// bytes through StorageCapability at the canonical D-04 path, and
// reports outputs.
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
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeId } from '../core/dag/types';
import type { StorageCapability } from '../core/storage';
import type { ComfyUIWorkflowParams } from '../nodes/ComfyUIWorkflow';
import type { ImageValue, PromptValue } from '../nodes/types';
import { framePath, type CompileWorkflowFn } from './dryRun';

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
}

export interface RunComfyUIWorkflowReport {
  readonly workflowId: NodeId;
  readonly framesWritten: number;
  /** Output paths in dispatch order. */
  readonly outputs: readonly string[];
  /** Last frame whose bytes landed successfully. -1 if no frame completed. */
  readonly lastGoodFrame: number;
}

/** Sanitize presetId / outputPath for OPFS — THREE-reserved-chars rules
 *  applied here as defense-in-depth even though THREE isn't in the path
 *  (memory: feedback_three_reserved_chars). The Mutator already pre-
 *  sanitizes; this is the second guard. */
function sanitizePathSegment(s: string): string {
  return s.replace(/[[\].:/]/g, '_');
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
  const node = state.nodes[workflowNodeId];
  if (!node) throw new Error(`runComfyUIWorkflow: unknown workflowNodeId "${workflowNodeId}"`);
  if (node.type !== 'ComfyUIWorkflow') {
    throw new Error(
      `runComfyUIWorkflow: node "${workflowNodeId}" is not a ComfyUIWorkflow (got ${node.type})`,
    );
  }

  // V10: defensive defaults at every destructured field. Legacy projects
  // may have hydrated without `lastGoodFrame` / `frameEnd` if they were
  // saved before P5 schema landed.
  const params = node.params as Partial<ComfyUIWorkflowParams>;
  const presetId = sanitizePathSegment(params.presetId ?? 'stylizedRealism');
  const frameStart = params.frameStart ?? 0;
  const frameEnd = params.frameEnd ?? 60;
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

  const promptBinding = node.inputs.prompt;
  if (!promptBinding || Array.isArray(promptBinding)) {
    throw new Error(
      `runComfyUIWorkflow: workflow "${workflowNodeId}" missing single Prompt input.`,
    );
  }

  const passBinding = node.inputs['pass-input'];
  const passRefs =
    passBinding === undefined ? [] : Array.isArray(passBinding) ? passBinding : [passBinding];

  const outputs: string[] = [];
  let lastCompletedFrame = lastGoodFrame;

  for (let frame = start; frame <= frameEnd; frame++) {
    const ctx = ctxForFrame(frame);
    const prompt = evaluate(state, promptBinding.node, {
      ctx,
      socket: promptBinding.socket,
    }).value as PromptValue;
    const passes = passRefs.map(
      (ref) => evaluate(state, ref.node, { ctx, socket: ref.socket }).value as ImageValue,
    );

    // Prev-frame plumbing: frame N consumes frame N-1's stylized output
    // for ControlNet temporal coherence. First frame in the run (frame
    // === start) → null; the compiler substitutes a zero/black image.
    const prevFrameStylizedPath = frame > start ? framePath(outputPath, frame - 1) : null;

    const { workflowJson, inputs } = await deps.compileWorkflow({
      presetId,
      prompt,
      passes,
      frame,
      prevFrameStylizedPath,
    });

    let result;
    try {
      result = await deps.capability.submit(workflowJson, inputs);
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

    const path = framePath(outputPath, frame);
    await deps.storage.write(path, result.frame);
    outputs.push(path);
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
