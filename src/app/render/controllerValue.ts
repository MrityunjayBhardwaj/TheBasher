// #1715 — the keyed value of a workflow node's unwired number / text input at a frame.
//
// Such an input is keyed on `controller:<markerNodeId>` (the same path the Controls rows and the
// I key use, `comfyControllerPath`). The frame runner lives in src/render and reads no app state,
// so the app hands it this reader. Unkeyed reads as undefined, and the runner then uses the
// marker's own default from the workflow file (which an un-keyed edit writes into).

import { comfyControllerPath } from '../../core/comfy/basherControllers';
import { createEvaluatorCache } from '../../core/dag/evaluator';
import type { DagState } from '../../core/dag/state';
import type { NodeId } from '../../core/dag/types';
import type { ControllerValueAt } from '../../render/dryRun';
import { resolveEvaluatedParam } from '../resolveEvaluatedParam';

export function controllerValueReader(state: DagState, workflowNodeId: NodeId): ControllerValueAt {
  const cache = createEvaluatorCache();
  return (markerNodeId, frame) => {
    const r = resolveEvaluatedParam(
      state,
      workflowNodeId,
      comfyControllerPath(markerNodeId),
      { time: { frame, seconds: frame / 30, normalized: 0 } },
      cache,
      undefined,
      true,
    );
    const v = r?.value;
    return typeof v === 'number' || typeof v === 'string' ? v : undefined;
  };
}
