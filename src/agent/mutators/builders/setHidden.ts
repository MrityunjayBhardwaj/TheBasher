// setHidden Mutator — hide or show nodes, the agent's half of the outliner's eye (#1445).
//
// #334 cut `setHidden` from dag.exec's raw ops along with the other meta ops, which left the
// agent no way to hide anything. This is the verb that replaces it. It asks the SAME
// question the eye asks (`hideRefusal`, #1448): only a scene object or collection that carries
// the visibility params (#1503) can be hidden, because those are what the drawers honour.
// Anywhere else the flag would change and the picture would not, and the turn would report a
// hide nobody can see.
//
// Spec: { targetSelectors, hidden } — sets every target's `viewport` and `render` flags to
// `!hidden`: the director's "hide it" means gone from the picture and the render, as the
// retarget hides its stand-in (#1503).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { setShownOp } from '../../../app/collections';
import { hideRefusal } from '../../../app/sceneVisibility';

const SetHiddenSpec = z.object({
  targetSelectors: z.array(z.string().min(1)).min(1),
  hidden: z.boolean().describe('true hides the targets, false shows them again.'),
});
export type SetHiddenSpec = z.infer<typeof SetHiddenSpec>;

export const setHiddenMutator: MutatorDefinition<SetHiddenSpec> = {
  name: 'mutator.setHidden',
  description:
    'Hide or show objects, lights, cameras and collections in the viewport and the render. The ' +
    'nodes stay in the graph; hidden: false shows them again. A data node or modifier cannot be ' +
    'hidden: hide the object that holds it.',
  spec: SetHiddenSpec,
  specExample: { targetSelectors: ['node_id'], hidden: true },
  contract: {
    requiredEdges: [],
    requiredNodeTypes: [],
    preserves: ['position', 'rotation', 'scale', 'children'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // The ops touch each target's own params and nothing else.
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
      // A flag already in the asked state emits nothing (`setShownOp`), so a repeat is not an edit.
      for (const purpose of ['viewport', 'render'] as const) {
        const op = setShownOp(state, id, purpose, !spec.hidden);
        if (op) ops.push(op);
      }
    }
    return ops;
  },
};
