// The spring network as `buildSpringOps` wrote it before a spring was a Spring template (#1559):
// a Solver owning nine nodes, and the driver reading its `outVec`. For tests about a Solver and
// its sub-network (delete, duplicate, scope), which need that shape and not a template instance.

import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { nextDriverOrder } from '../app/paramDrivers';
import { springBodyOps, type SpringNodeKey } from '../app/springBody';

export function rawSpringOps(
  state: DagState,
  req: { targetId: string; controllerId: string; idFor: (key: SpringNodeKey) => string },
): Op[] {
  const { targetId, controllerId, idFor } = req;
  return [
    ...springBodyOps({ controllerId, stiffness: 0.12, damping: 0.14, seedFrame: 0, idFor }),
    {
      type: 'addNode',
      nodeId: idFor('driver'),
      nodeType: 'ParamDriver',
      params: {
        target: targetId,
        paramPath: 'position',
        blendMode: 'replace',
        order: nextDriverOrder(state.nodes, targetId, 'position'),
      },
    },
    {
      type: 'connect',
      from: { node: idFor('solver'), socket: 'outVec' },
      to: { node: idFor('driver'), socket: 'in' },
    },
  ];
}
