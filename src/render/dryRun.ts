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
import type { ComfyApiJson } from '../core/comfy/comfyGraph';
import type { WorkflowSockets } from '../core/comfy/workflowSockets';
import { createEvaluatorCache, evaluateInputRef, type EvaluatorCache } from '../core/dag/evaluator';
import { getNodeType } from '../core/dag/registry';
import { inputAvailable } from '../core/dag/socketAvailability';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, NodeId, NodeRef } from '../core/dag/types';
import type { StorageCapability } from '../core/storage';
import { workflowSocketsOf, type ComfyUIWorkflowParams } from '../nodes/ComfyUIWorkflow';

/**
 * #1715 — what one frame of a workflow node is compiled from. The compiler (by default the
 * generic `compileWorkflowFrame`) fills the file's Basher markers from these and returns a
 * submittable (workflowJson, inputs). Injectable so tests substitute a deterministic stub.
 */
export interface CompileWorkflowArgs {
  /** The workflow file the node holds. */
  readonly apiJson: ComfyApiJson;
  readonly frame: number;
  /** Each input socket's value at this frame: what arrives on its wire, or for an unwired
   *  number / text input its keyed value. Absent = nothing wired, nothing keyed. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Each fed input (its marker's node id) → the path of the picture its output made on the
   *  frame before, or null on the first frame of the range. */
  readonly fed: Readonly<Record<string, string | null>>;
  /** The node's `outputPath`; the job directory it sits in holds the render passes (D-04). */
  readonly workflowOutputPath: string;
}

export interface CompileWorkflowFn {
  (args: CompileWorkflowArgs): Promise<{
    workflowJson: ComfyWorkflowJson;
    inputs: ComfyInputs;
  }>;
}

/** An unwired number / text input's keyed value at a frame (the caller reads the channel on
 *  `controller:<markerNodeId>`); undefined when nothing is keyed. Lives with the caller because
 *  keys live off the graph and src/render reads no app state. */
export type ControllerValueAt = (
  markerNodeId: string,
  frame: number,
) => number | string | undefined;

/** The workflow node at `workflowNodeId`, its params and its file's sockets, or the refusal. */
export function workflowNodeOf(
  state: DagState,
  workflowNodeId: NodeId,
  who: string,
): { params: Partial<ComfyUIWorkflowParams>; sockets: WorkflowSockets; apiJson: ComfyApiJson } {
  const node = state.nodes[workflowNodeId];
  if (!node) throw new Error(`${who}: unknown workflowNodeId "${workflowNodeId}"`);
  if (node.type !== 'ComfyUIWorkflow') {
    throw new Error(`${who}: node "${workflowNodeId}" is not a ComfyUIWorkflow (got ${node.type})`);
  }
  const params = node.params as Partial<ComfyUIWorkflowParams>;
  const apiJson = params.graph?.apiJson as ComfyApiJson | undefined;
  if (!apiJson) {
    throw new Error(`${who}: workflow "${workflowNodeId}" has no workflow file. Pick one first.`);
  }
  return { params, sockets: workflowSocketsOf(params), apiJson };
}

/**
 * #1715 — every input socket's value at `ctx`: each wired one through the evaluator's own arrival
 * (`evaluateInputRef`, so frames into a still input are the picked frame, #1716), each unwired
 * number / text one from its keys. A broken wire (on a socket the file no longer has) is read as
 * unconnected, as the evaluator reads it.
 */
export function workflowInputsAt(
  state: DagState,
  workflowNodeId: NodeId,
  sockets: WorkflowSockets,
  ctx: EvalCtx,
  cache: EvaluatorCache,
  controllerValue?: ControllerValueAt,
): Record<string, unknown> {
  const node = state.nodes[workflowNodeId]!;
  const def = getNodeType(node.type)!;
  const out: Record<string, unknown> = {};
  for (const input of sockets.inputs) {
    const binding = node.inputs[input.socket];
    const ref = (Array.isArray(binding) ? binding[0] : binding) as NodeRef | undefined;
    if (ref && inputAvailable(def, node.params, input.socket)) {
      out[input.socket] = evaluateInputRef(state, workflowNodeId, input.socket, ref, {
        ctx,
        cache,
      }).value;
      continue;
    }
    if (input.type === 'number' || input.type === 'text') {
      const keyed = controllerValue?.(input.nodeId, ctx.time.frame);
      if (keyed !== undefined) out[input.socket] = keyed;
    }
  }
  return out;
}

/** Where output `socket` of a workflow node writes its frames: the first output at the node's
 *  `outputPath` (what the stitch and the compositor read), every other one beside it. */
export function outputPathOf(outputPath: string, sockets: WorkflowSockets, socket: string): string {
  const first = sockets.outputs[0]?.socket;
  if (socket === first) return outputPath;
  return `${outputPath.replace(/\/+$/, '')}__${socket.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export interface DryRunDeps {
  readonly capability: ComfyUICapability;
  readonly storage: StorageCapability;
  readonly compileWorkflow: CompileWorkflowFn;
  /** #1715 — keyed values of unwired number / text inputs (see {@link ControllerValueAt}). */
  readonly controllerValue?: ControllerValueAt;
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
 *   - a node holding no workflow file, or a file with no Basher output
 *   - capability rejection (rethrown)
 */
export async function dryRun(
  workflowNodeId: NodeId,
  state: DagState,
  deps: DryRunDeps,
): Promise<DryRunReport> {
  const { params, sockets, apiJson } = workflowNodeOf(state, workflowNodeId, 'dryRun');
  // V10 guard — defensive defaults for a project that lacks frameStart / frameEnd / outputPath.
  const frameStart = params.frameStart ?? 0;
  const frameEnd = params.frameEnd ?? 60;
  const outputPath = params.outputPath ?? '';
  if (!outputPath) {
    throw new Error(
      `dryRun: workflow "${workflowNodeId}" has empty outputPath. The Mutator must set it before dryRun.`,
    );
  }
  if (sockets.outputs.length === 0) {
    throw new Error(`dryRun: workflow "${workflowNodeId}"'s file has no Basher output to read.`);
  }

  // Probe frame = frameStart, the first of the range: its fed inputs get their first-frame
  // picture. One evaluator cache for every input (#1318).
  const probeFrame = frameStart;
  const ctx: EvalCtx = {
    time: { frame: probeFrame, seconds: probeFrame / 30, normalized: 0 },
  };
  const cache = createEvaluatorCache();
  const inputs = workflowInputsAt(state, workflowNodeId, sockets, ctx, cache, deps.controllerValue);
  const fed = Object.fromEntries(sockets.fed.map((f) => [f.nodeId, null]));
  const compiled = await deps.compileWorkflow({
    apiJson,
    frame: probeFrame,
    inputs,
    fed,
    workflowOutputPath: outputPath,
  });

  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const result = await deps.capability.submitBatch(compiled.workflowJson, compiled.inputs);
  const elapsedMs = Math.max(0, now() - t0);

  // Persist probe bytes at the D-04 path for the workflow's frameStart so
  // the cache parity claim (probe → execute frame 0) holds: identical
  // (workflowJson, inputs) deterministically reproduces the same
  // sourceHash → execute reads the existing bytes.
  const first = sockets.outputs[0];
  const bytes = result.framesByNode?.[first.nodeId]?.[0] ?? result.frames[0];
  if (!bytes) throw new Error(`dryRun: ComfyUI returned no picture for "${first.socket}".`);
  const samplePath = framePath(outputPath, probeFrame);
  await deps.storage.write(samplePath, bytes);

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
 * The Mutator sets outputPath to `renders/${jobId}/stylized_<workflow>`;
 * dryRun + runComfyUIWorkflow append `_${pad4(frame)}.png`. Stylized
 * frames live at the same OPFS prefix as raw passes per D-04 (parallel
 * tree decision) — the `stylized_` prefix prevents collision
 * with `${passKind}_NNNN.png` (raw passes from runRenderJob).
 */
export function framePath(outputPath: string, frame: number): string {
  const trimmed = outputPath.replace(/\/+$/, '');
  const padded = frame.toString().padStart(4, '0');
  return `${trimmed}_${padded}.png`;
}
