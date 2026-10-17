// setOutput Mutator — choose which node the app draws (`scene`) or renders (`render`) (#1550).
//
// The question is asked once, in `setOutputOps`, which the UI's door asks too. One scene at a
// time (#1674): binding either output keeps the render output reading the scene output.
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
    'output a render uses (output "render", a RenderOutput node). The render output always ' +
    'renders the scene output, so binding one moves the other with it. Undo puts both back.',
  spec: SetOutputSpec,
  specExample: { output: 'render', targetSelectors: ['node_id'] },
  contract: { requiredEdges: [], requiredNodeTypes: [], preserves: [] },
  buildClosureSpec(spec): ClosureSpec {
    // The node being bound, the nodes bound now (a new scene rewires the render output, #1674)
    // and, one hop up, the scene a new render output reads, which comes with it.
    return {
      rootSelectors: spec.targetSelectors,
      followedEdges: ['outputs', 'children'],
      depthByKind: { children: 1 },
    };
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
