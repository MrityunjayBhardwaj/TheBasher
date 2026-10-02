// setHidden Mutator — hide or show nodes, the agent's half of the outliner's eye (#1445).
//
// #334 cut `setHidden` from dag.exec's raw ops along with the other meta ops, which left the
// agent no way to hide anything. This is the verb that replaces it. It asks the SAME
// question the eye asks (`hideRefusal`, #1448): only a direct child or light of the scene,
// never a camera, can be hidden, because those are the only places the renderer skips a
// hidden node. Anywhere else the flag would change and the picture would not, and the turn
// would report a hide nobody can see.
//
// Spec: { targetSelectors, hidden } — sets every target's visibility to `hidden`.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { hideRefusal } from '../../../app/sceneVisibility';

const SetHiddenSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  hidden: z.boolean().describe('true hides the targets, false shows them again.'),
});
export type SetHiddenSpec = z.infer<typeof SetHiddenSpec>;

export const setHiddenMutator: MutatorDefinition<SetHiddenSpec> = {
  name: 'mutator.setHidden',
  description:
    'Hide or show objects and lights in the scene and the render. The nodes stay in the ' +
    'graph; hidden: false shows them again. Cameras and nested parts cannot be hidden.',
  spec: SetHiddenSpec,
  specExample: { targetSelectors: ['node_id'], hidden: true },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    preserves: ['position', 'rotation', 'scale', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // The op touches each target's own meta and nothing else.
    return { rootSelectors: spec.targetSelectors, followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    for (const id of spec.targetSelectors) {
      const reason = hideRefusal(state, id);
      if (reason) return { ok: false, reason };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const ops: Op[] = [];
    for (const id of spec.targetSelectors) {
      // A target already in the asked state emits nothing, so a repeat is not an edit.
      const now = state.nodes[id]?.meta?.hidden ?? false;
      if (now !== spec.hidden) ops.push({ type: 'setHidden', nodeId: id, hidden: spec.hidden });
    }
    return ops;
  },
};
