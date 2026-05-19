// dryRun — cost preview probe for ComfyUIWorkflow nodes.
//
// D-06 (locked): one-frame probe + extrapolate. Submits frame `frameStart`
// through the real ComfyUICapability, times it, multiplies by the frame
// count, returns a report. The probe result is written to the canonical
// D-04 stylized-output path so subsequent runComfyUIWorkflow execution
// cache-hits frame 0 by sourceHash identity (THESIS §51 — caching
// correctness). The probe is the workflow.
//
// dryRun is exported as a function, NOT mounted on NodeDefinition.evaluate
// — keeps the evaluator signature stable and respects pure: false's
// declared impurity scope (network/filesystem stays out of the
// evaluator).
//
// V8 (file-rooted dispatch): src/render/* MUST NOT emit Ops. dryRun reads
// DagState + writes to StorageCapability. It never calls
// dagStore.dispatch / setState.
//
// REF: project_p5_context D-06; THESIS §28, §44, §51; vyapti V6 + V8.

import type { ComfyInputs, ComfyUICapability, ComfyWorkflowJson } from '../core/comfy';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeId } from '../core/dag/types';
import type { StorageCapability } from '../core/storage';
import type { ComfyUIWorkflowParams } from '../nodes/ComfyUIWorkflow';
import type { ImageValue, PromptValue } from '../nodes/types';

/**
 * Compiles a (presetId, prompt, frame-N inputs) tuple into a ComfyUI-
 * submittable (workflowJson, inputs). Wave C wires the real
 * implementation from src/agent/strategy/presets/<id>; Wave A's tests
 * inject a stub. Async to leave room for storage reads (loading raw
 * pass bytes from disk before submission).
 *
 * `prevFrameStylizedPath` is the OPFS path of the previous frame's
 * stylized output for temporal coherence (ControlNet img2img on N-1).
 * `null` means there is no previous frame in this run — the compiler
 * substitutes a zero/black image. dryRun always passes null
 * (frameStart probe has no antecedent).
 */
export interface CompileWorkflowArgs {
  readonly presetId: string;
  readonly prompt: PromptValue;
  readonly passes: readonly ImageValue[];
  readonly frame: number;
  readonly prevFrameStylizedPath?: string | null;
  /**
   * The workflow node's `outputPath` param value (e.g.
   * `'renders/job1/stylized_stylizedRealism'`). Presets use this to
   * derive the sibling raw-pass directory — raw passes from the same
   * job live at `${parentDir}/${passKind}_${pad4(frame)}.png`. The
   * Mutator authors both paths so they share the `${jobId}` prefix.
   */
  readonly workflowOutputPath: string;
}

export interface CompileWorkflowFn {
  (args: CompileWorkflowArgs): Promise<{
    workflowJson: ComfyWorkflowJson;
    inputs: ComfyInputs;
  }>;
}

export interface DryRunDeps {
  readonly capability: ComfyUICapability;
  readonly storage: StorageCapability;
  readonly compileWorkflow: CompileWorkflowFn;
  /** Test injection — defaults to Date.now. Returns elapsed ms via diff. */
  readonly now?: () => number;
}

export interface DryRunReport {
  readonly workflowId: NodeId;
  /** Total frames the full workflow would produce (frameEnd - frameStart + 1). */
  readonly frames: number;
  /** Extrapolated wall-clock time for the full range, given the probe's per-frame time. */
  readonly estimatedSeconds: number;
  /** OPFS path the probe frame's bytes were written to (D-04). */
  readonly samplePath: string;
  /** Server-assigned id of the probe submit. Useful for diagnostics. */
  readonly probeJobId: string;
}

/**
 * One-frame probe + extrapolate cost preview for the workflow at
 * `workflowNodeId`. Submits frame `frameStart` through the configured
 * capability, times it, writes the probe bytes to the D-04 path, and
 * returns the extrapolation. Throws on:
 *   - unknown / wrong-typed workflowNodeId
 *   - empty outputPath (Mutator must set it before dryRun)
 *   - missing prompt input
 *   - capability rejection (rethrown)
 */
export async function dryRun(
  workflowNodeId: NodeId,
  state: DagState,
  deps: DryRunDeps,
): Promise<DryRunReport> {
  const node = state.nodes[workflowNodeId];
  if (!node) throw new Error(`dryRun: unknown workflowNodeId "${workflowNodeId}"`);
  if (node.type !== 'ComfyUIWorkflow') {
    throw new Error(`dryRun: node "${workflowNodeId}" is not a ComfyUIWorkflow (got ${node.type})`);
  }

  // V10 guard — defensive defaults. params may have been hydrated from a
  // legacy project that lacks frameStart / frameEnd / outputPath.
  const params = node.params as Partial<ComfyUIWorkflowParams>;
  const presetId = params.presetId ?? 'stylizedRealism';
  const frameStart = params.frameStart ?? 0;
  const frameEnd = params.frameEnd ?? 60;
  const outputPath = params.outputPath ?? '';
  if (!outputPath) {
    throw new Error(
      `dryRun: workflow "${workflowNodeId}" has empty outputPath. The Mutator must set it before dryRun.`,
    );
  }

  // Probe frame = frameStart. Time advances through the Time socket so
  // the upstream pass evaluators produce frame-0 metadata.
  const probeFrame = frameStart;
  const ctx: EvalCtx = {
    time: { frame: probeFrame, seconds: probeFrame / 30, normalized: 0 },
  };

  // Resolve the Prompt + pass inputs at the probe frame.
  const promptBinding = node.inputs.prompt;
  if (!promptBinding || Array.isArray(promptBinding)) {
    throw new Error(
      `dryRun: workflow "${workflowNodeId}" missing single Prompt input — wire one with a connect op.`,
    );
  }
  const prompt = evaluate(state, promptBinding.node, {
    ctx,
    socket: promptBinding.socket,
  }).value as PromptValue;

  const passBinding = node.inputs['pass-input'];
  const passRefs =
    passBinding === undefined ? [] : Array.isArray(passBinding) ? passBinding : [passBinding];
  const passes = passRefs.map(
    (ref) => evaluate(state, ref.node, { ctx, socket: ref.socket }).value as ImageValue,
  );

  // Compile + submit. The compiler is injectable so Wave C wires the real
  // preset compiler and tests substitute a deterministic stub.
  const { workflowJson, inputs } = await deps.compileWorkflow({
    presetId,
    prompt,
    passes,
    frame: probeFrame,
    // dryRun is always frame 0 of a new run — no antecedent stylized
    // output to feed ControlNet. Compiler substitutes a zero image.
    prevFrameStylizedPath: null,
    workflowOutputPath: outputPath,
  });

  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const result = await deps.capability.submit(workflowJson, inputs);
  const elapsedMs = Math.max(0, now() - t0);

  // Persist probe bytes at the D-04 path for the workflow's frameStart so
  // the cache parity claim (probe → execute frame 0) holds: identical
  // (workflowJson, inputs) deterministically reproduces the same
  // sourceHash → execute reads the existing bytes.
  const samplePath = framePath(outputPath, probeFrame);
  await deps.storage.write(samplePath, result.frame);

  const frameCount = Math.max(0, frameEnd - frameStart + 1);
  return {
    workflowId: workflowNodeId,
    frames: frameCount,
    estimatedSeconds: (elapsedMs / 1000) * frameCount,
    samplePath,
    probeJobId: result.jobId,
  };
}

/**
 * D-04 frame path formula: `${outputPath}_${pad4(frame)}.png`.
 *
 * The Mutator sets outputPath to `renders/${jobId}/stylized_${presetId}`;
 * dryRun + runComfyUIWorkflow append `_${pad4(frame)}.png`. Stylized
 * frames live at the same OPFS prefix as raw passes per D-04 (parallel
 * tree decision) — `stylized_${presetId}` prefix prevents collision
 * with `${passKind}_NNNN.png` (raw passes from runRenderJob).
 */
export function framePath(outputPath: string, frame: number): string {
  const trimmed = outputPath.replace(/\/+$/, '');
  const padded = frame.toString().padStart(4, '0');
  return `${trimmed}_${padded}.png`;
}
