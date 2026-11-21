// comfyWorkflowMade — whether a ComfyUI workflow's pictures are made from what it would make now,
// and what regenerating one runs (#1718).
//
// ─────────────────────────────────────────────────────────────────────────────
// STALE IS ALREADY A FACT OF THE GRAPH — THIS ONLY NAMES IT
// ─────────────────────────────────────────────────────────────────────────────
// #1721's answer for a generated run, taken for a workflow: the result records the hash it was
// made from (`madeFrom`, written when a run lands), and the node computes its current one (its
// first output's `sourceHash` at its first frame). The two differ exactly when something that
// decides the picture moved: the file (a prompt or seed default), the image bindings, or any
// wired input. A wired input enters by ITS hash, so a still workflow's edit changes the still's
// hash, which changes the hash of every workflow its still is wired into. A shot goes stale when
// the still it starts from does, with no rule here that knows about stills or shots.
//
// What `workflowSourceHash` does not see: a run of frames from a render pass enters at the run's
// first frame only (the hash is read there), and the graph is evaluated without its keyframe
// channels, so the camera a render pass films with is the camera switch's authored one at every
// frame. #1717 answers both in the app (`src/app/render/workflowMadeFrom.ts`, which reads every
// frame the way the render draws it), and the app passes that hash here (`hashOf`). Every reader
// that records or compares `madeFrom` must use the same one.
//
// ─────────────────────────────────────────────────────────────────────────────
// REGENERATING RUNS WHAT IT DEPENDS ON FIRST
// ─────────────────────────────────────────────────────────────────────────────
// `regenerateOrder` is the workflows upstream of a node, in dependency order (the graph's own
// `topoSort`), keeping each one that is not current, and the node itself last, always (Regenerate
// is asked for). A node appears once however many paths lead to it.
//
// REF: src/nodes/motionGenerateRuns.ts (#1721, the same comparison for a generated run);
//      src/nodes/ComfyUIWorkflow.ts (`madeFrom`, and the hash it is compared with);
//      src/app/render/regenerateWorkflow.ts (the road that runs the order and records `madeFrom`).

import { evaluate, topoSort, type EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { NodeId } from '../core/dag/types';
import { workflowSocketsOf, type ComfyUIWorkflowParams } from './ComfyUIWorkflow';
import type { ImageValue } from './types';

/** The hash a workflow's pictures are made from (null: it cannot run). `workflowSourceHash` here;
 *  the app's `workflowMadeFrom` (#1717), which covers every frame. */
export type WorkflowHashFn = (state: DagState, id: NodeId, cache?: EvaluatorCache) => string | null;

/** `unmade`: never landed. `current`: made from what it would make now. `stale`: an input
 *  moved since. `cannot-run`: no workflow file, or a file with no Basher output. */
export type WorkflowMadeState = 'unmade' | 'current' | 'stale' | 'cannot-run';

function isWorkflow(state: DagState, id: NodeId): boolean {
  return state.nodes[id]?.type === 'ComfyUIWorkflow';
}

/**
 * The hash of what the workflow at `id` would make now: its first output's `sourceHash` at its
 * first frame. Null when it cannot run (no node, no file, no output).
 */
export function workflowSourceHash(
  state: DagState,
  id: NodeId,
  cache?: EvaluatorCache,
): string | null {
  const node = state.nodes[id];
  if (!node || node.type !== 'ComfyUIWorkflow') return null;
  const params = node.params as Partial<ComfyUIWorkflowParams>;
  if (!params.graph) return null;
  const first = workflowSocketsOf(params).outputs[0];
  if (!first) return null;
  const frame = params.frameStart ?? 0;
  const value = evaluate(state, id, {
    socket: first.socket,
    cache,
    ctx: { time: { frame, seconds: frame / 30, normalized: 0 } },
  }).value as ImageValue | undefined;
  return typeof value?.sourceHash === 'string' ? value.sourceHash : null;
}

/** Whether the workflow at `id` has pictures, and whether they are what it would make now. */
export function workflowMadeState(
  state: DagState,
  id: NodeId,
  cache?: EvaluatorCache,
  hashOf: WorkflowHashFn = workflowSourceHash,
): WorkflowMadeState {
  const now = hashOf(state, id, cache);
  if (now === null) return 'cannot-run';
  const made = (state.nodes[id]!.params as Partial<ComfyUIWorkflowParams>).madeFrom ?? null;
  if (made === null) return 'unmade';
  return made === now ? 'current' : 'stale';
}

/**
 * The workflows regenerating `id` runs, in the order to run them: every workflow upstream of it
 * that is not current (dependencies first), then `id` itself. Each appears once.
 */
export function regenerateOrder(
  state: DagState,
  id: NodeId,
  cache?: EvaluatorCache,
  hashOf: WorkflowHashFn = workflowSourceHash,
): NodeId[] {
  if (!isWorkflow(state, id)) return [];
  return topoSort(state, id).filter(
    (n) =>
      n === id ||
      (isWorkflow(state, n) && workflowMadeState(state, n, cache, hashOf) !== 'current'),
  );
}
