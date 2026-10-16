// setOutput Mutator — choose which node the app draws (`scene`) or renders (`render`) (#1550).
//
// Houdini's display and render flags. The question is asked once, in `setOutputOps`, which the
// UI's door asks too.
//
// Spec: { output, targetSelectors: [nodeId] }.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { setOutputOps } from '../../../app/outputBinding';

const SetOutputSpec = z.object({
  output: z
    .enum(['scene', 'render'])
    .describe('scene: what the viewport draws. render: what a render renders.'),
  targetSelectors: z.array(z.string().min(1)).length(1),
});
export type SetOutputSpec = z.infer<typeof SetOutputSpec>;

export const setOutputMutator: MutatorDefinition<SetOutputSpec> = {
  name: 'mutator.setOutput',
  description:
    'Make a node the scene the viewport draws (output "scene", a Scene node) or the render ' +
    'output a render uses (output "render", a RenderOutput node). Undo puts the old one back.',
  spec: SetOutputSpec,
  specExample: { output: 'render', targetSelectors: ['node_id'] },
  contract: { requiredEdges: [], requiredNodeTypes: [], preserves: [] },
  buildClosureSpec(spec): ClosureSpec {
    // The op names only the node being bound.
    return { rootSelectors: spec.targetSelectors, followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const result = setOutputOps(state, spec.output, spec.targetSelectors[0]);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const result = setOutputOps(state, spec.output, spec.targetSelectors[0]);
    if (!result.ok) throw new Error(result.reason);
    return result.ops;
  },
};
