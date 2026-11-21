// regenerateWorkflow — Regenerate on a ComfyUI workflow node: run every stale workflow it depends
// on first, then the node, each once, and record what each was made from (#1718).
//
// The order is the graph's (`regenerateOrder`): a shot whose first frame is wired from a still
// workflow runs the still first when the still is not current, because the shot reads the
// still's picture off its wire (`ImageValue.storedAt`). Nothing here knows about stills or shots.
//
// Each run goes through `runWorkflow` (the one road, with its in-flight guard and its
// `lastGoodFrame` writeback). Regenerate means "make it again", so the resume sentinel is reset
// first: a finished run's `lastGoodFrame` would otherwise make the next run a no-op. When a run
// lands, `madeFrom` records the hash of the state it ran from (read in the same tick
// `runWorkflow` reads it, so the two cannot differ). A failed run stops the chain: what depends
// on it would read a picture that is not there.
//
// V8: app layer — it dispatches; src/render/ never does.
//
// REF: src/nodes/comfyWorkflowMade.ts (the order); src/app/render/workflowMadeFrom.ts (the hash, over
//      every frame the workflow makes, #1717); src/app/render/runWorkflow.ts.

import { createEvaluatorCache } from '../../core/dag/evaluator';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import { regenerateOrderOf, workflowMadeFrom } from './workflowMadeFrom';
import { runWorkflow, type RunWorkflowDeps } from './runWorkflow';

export type RegenerateResult =
  | { readonly status: 'completed'; readonly ran: readonly NodeId[] }
  | {
      readonly status: 'failed' | 'busy';
      /** The workflows that landed before the one that did not. */
      readonly ran: readonly NodeId[];
      readonly at: NodeId;
      readonly error?: Error;
    };

function setRenderParam(nodeId: NodeId, paramPath: string, value: unknown, label: string) {
  useDagStore.getState().dispatch({ type: 'setParam', nodeId, paramPath, value }, 'render', label);
}

/** Run `id` and every stale workflow it depends on, dependencies first. */
export async function regenerateWorkflow(
  id: NodeId,
  deps: RunWorkflowDeps,
): Promise<RegenerateResult> {
  // A fresh cache per state read: the state moves between runs, and one read evaluates every
  // upstream workflow (shared inputs once).
  const order = regenerateOrderOf(useDagStore.getState().state, id, createEvaluatorCache());
  const ran: NodeId[] = [];
  for (const nodeId of order) {
    const params = useDagStore.getState().state.nodes[nodeId]?.params as
      | { lastGoodFrame?: number }
      | undefined;
    if ((params?.lastGoodFrame ?? -1) !== -1) {
      setRenderParam(nodeId, 'lastGoodFrame', -1, 'regenerate: start over');
    }
    // Read in the same tick `runWorkflow` reads the state it runs.
    const madeFrom = workflowMadeFrom(useDagStore.getState().state, nodeId, createEvaluatorCache());
    const result = await runWorkflow(nodeId, deps);
    if (result.status !== 'completed') {
      return {
        status: result.status,
        ran,
        at: nodeId,
        ...(result.status === 'failed' ? { error: result.error } : {}),
      };
    }
    setRenderParam(nodeId, 'madeFrom', madeFrom, `made ← ${madeFrom ?? 'nothing'}`);
    ran.push(nodeId);
  }
  return { status: 'completed', ran };
}
