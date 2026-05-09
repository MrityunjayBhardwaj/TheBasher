// runWorkflow — the V8-friendly seam that runs a ComfyUIWorkflow node
// against the configured capability + storage. Wraps src/render/runComfy
// UIWorkflow's onFrameComplete callback with a setParam Op dispatched
// through useDagStore (V8: src/render/* never dispatches; src/app/*
// does).
//
// Concurrency: useRenderJobsStore tracks which workflow ids are
// in-flight. Concurrent calls for the same id are no-ops (with a warn).
// Other workflows can run side-by-side.
//
// Failure handling: on capability rejection, the Op chain still records
// the last good frame (callback fired before the error), and the error
// surfaces to the caller with the partial report attached.
//
// REF: project_p5_plan B2; vyapti V8 (file-rooted), V1 (op-as-only
// mutation path).

import type { ComfyUICapability } from '../../core/comfy';
import { useDagStore } from '../../core/dag/store';
import type { DagState } from '../../core/dag/state';
import type { NodeId } from '../../core/dag/types';
import type { StorageCapability } from '../../core/storage';
import type { CompileWorkflowFn } from '../../render/dryRun';
import {
  runComfyUIWorkflow,
  type RunComfyUIWorkflowReport,
} from '../../render/runComfyUIWorkflow';
import { useRenderJobsStore } from '../stores/renderJobsStore';

export interface RunWorkflowDeps {
  readonly capability: ComfyUICapability;
  readonly storage: StorageCapability;
  readonly compileWorkflow: CompileWorkflowFn;
}

export type RunWorkflowResult =
  | { readonly status: 'completed'; readonly report: RunComfyUIWorkflowReport }
  | { readonly status: 'busy'; readonly workflowId: NodeId }
  | { readonly status: 'failed'; readonly error: Error; readonly partialReport?: RunComfyUIWorkflowReport };

/**
 * Run the ComfyUIWorkflow at `workflowNodeId` against the configured
 * capability + storage. The function:
 *
 *   1. Marks the workflow in-flight in useRenderJobsStore (returns
 *      'busy' if already in-flight).
 *   2. Reads a fresh DagState snapshot from useDagStore — H19 mitigation,
 *      no captured snapshots across the async hop.
 *   3. Calls runComfyUIWorkflow with an onFrameComplete callback that
 *      dispatches `setParam` Ops to advance lastGoodFrame after each
 *      frame.
 *   4. Always clears the in-flight flag in a finally block, even on
 *      error.
 */
export async function runWorkflow(
  workflowNodeId: NodeId,
  deps: RunWorkflowDeps,
): Promise<RunWorkflowResult> {
  const jobs = useRenderJobsStore.getState();
  if (!jobs.markInFlight(workflowNodeId)) {
    return { status: 'busy', workflowId: workflowNodeId };
  }
  try {
    // H19: read state fresh at each access. The DagState we pass into
    // runComfyUIWorkflow is a single fresh read; runComfyUIWorkflow
    // itself does not subscribe to subsequent mutations (those would
    // race with its in-flight per-frame work).
    const state: DagState = useDagStore.getState().state;
    const report = await runComfyUIWorkflow(workflowNodeId, state, {
      capability: deps.capability,
      storage: deps.storage,
      compileWorkflow: deps.compileWorkflow,
      onFrameComplete: (frame) => {
        // V1 + V8: writeback happens through the standard Op pipeline.
        useDagStore.getState().dispatch(
          {
            type: 'setParam',
            nodeId: workflowNodeId,
            paramPath: 'lastGoodFrame',
            value: frame,
          },
          'render',
          `lastGoodFrame ← ${frame}`,
        );
      },
    });
    return { status: 'completed', report };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const partialReport = (error as Error & { partialReport?: RunComfyUIWorkflowReport })
      .partialReport;
    return { status: 'failed', error, partialReport };
  } finally {
    useRenderJobsStore.getState().clearInFlight(workflowNodeId);
  }
}
