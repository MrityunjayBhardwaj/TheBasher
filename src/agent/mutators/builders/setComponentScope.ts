// setComponentScope Mutator — restrict a scoped operator to a subset of its mesh (#667).
//
// Six operators carry a component `scope`: five over faces, `BevelModifier` over edges.
// A director has been able to type one since #872 (the param declares its control on the
// schema). This is the agent's counterpart, and the reason it exists is that the only
// agent road until now was a raw `dag.exec` setParam — which works and is schema-checked,
// but skips the five gates and the Mutator diff flow every other authoring action uses.
//
// 🔴 THE ELIGIBLE OPERATORS ARE DERIVED, NOT LISTED. This issue's own text said "four
// operators declare a scope" and it was six by the time anyone read it. A hardcoded list
// here would decay the same way and fail OPEN — refusing a node that is in fact scopeable,
// or worse, accepting one that is not. So `preconditions` asks the registry whether the
// target's paramSchema declares the field, which is the same question the inspector and
// the agent's gate 2 ask. A seventh scoped operator needs no edit here.
//
// `contract.requiredNodeTypes` is deliberately EMPTY for the same reason: gate 4 demands
// at least one of EACH listed type inside the closure, so naming all six would refuse
// every plan. The type check that matters is the schema question in `preconditions`.
//
// REF: src/nodes/componentSelection.ts (`SCOPE_PARAM`, `scopeParam()` — the one helper all
//      six call); src/nodes/scopeQuery.ts (the grammar and its named refusals);
//      src/agent/strategy/catalog.ts (`componentScope` — how the agent learns it exists).

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { Op } from '../../../core/dag/types';
import { getNodeType } from '../../../core/dag/registry';
import { SCOPE_PARAM } from '../../../nodes/componentSelection';

const SetComponentScopeSpec = z.object({
  /** The scoped operator whose subset to set. */
  nodeId: z.string().min(1),
  /**
   * The scope query. Blank clears it back to the whole mesh — the default these operators
   * had before scope existed, and an authoring intent in its own right, so it is NOT
   * refused as an empty string.
   */
  scope: z.string(),
});
export type SetComponentScopeSpec = z.infer<typeof SetComponentScopeSpec>;

/** The declared `scope` field on a node type, or undefined if it declares none. */
function scopeFieldOf(nodeType: string): z.ZodTypeAny | undefined {
  const schema = getNodeType(nodeType)?.paramSchema;
  if (!(schema instanceof z.ZodObject)) return undefined;
  return (schema.shape as Record<string, z.ZodTypeAny>)[SCOPE_PARAM];
}

export const setComponentScopeMutator: MutatorDefinition<SetComponentScopeSpec> = {
  name: 'mutator.setComponentScope',
  description:
    'Restrict a scoped operator to a subset of its mesh, written as a component range ' +
    "query (e.g. '0-5', '0-10:2', '0-9 ^3', '!0-4'). Blank clears the scope back to the " +
    'whole mesh. Five operators scope over FACES (Array/Mask/Mirror/MaterialOverride/' +
    'SetMaterial) and BevelModifier scopes over EDGES. Call ' +
    "agent.getStrategy({ topic: 'componentScope' }) for the grammar and what it refuses.",
  spec: SetComponentScopeSpec,
  specExample: {
    nodeId: 'node_id',
    scope: '0-5',
  },
  contract: {
    requiredEdges: [],
    // Empty by construction — see the header. The eligibility check is in preconditions.
    requiredNodeTypes: [],
    // A scope changes WHICH components the operator acts on. It moves nothing and
    // re-times nothing, but on the two material operators it changes which faces carry
    // which material — so `material` is NOT claimed here. Certifying it would be the
    // false-token failure the uniqueness gate was widened to catch.
    preserves: [
      'position',
      'rotation',
      'scale',
      'animation',
      'children',
      'animation-shape',
      'keyframe-density',
    ],
    lossy: [
      {
        kind: 'prior-component-scope',
        reason:
          "replaces the operator's component subset; the previously scoped elements are no longer the ones it acts on.",
      },
    ],
  },
  buildClosureSpec(spec): ClosureSpec {
    return { rootSelectors: [spec.nodeId], followedEdges: [] };
  },
  preconditions(spec, _closure, state) {
    const node = state.nodes[spec.nodeId];
    if (!node) return { ok: false, reason: `nodeId "${spec.nodeId}" not in DAG.` };

    const field = scopeFieldOf(node.type);
    if (field === undefined) {
      return {
        ok: false,
        reason: `nodeId "${spec.nodeId}" is ${node.type}, which declares no '${SCOPE_PARAM}' param — it cannot be restricted to a component subset.`,
      };
    }

    // Refuse an unparsable query HERE, with the schema's own message, rather than letting
    // gate 2 report it as a generic zod failure. The field is the authority on what it
    // accepts; re-implementing the grammar check would be a second answer to one question.
    const parsed = field.safeParse(spec.scope);
    if (!parsed.success) {
      return {
        ok: false,
        reason: `scope "${spec.scope}" is not accepted by ${node.type}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, _state: DagState): Op[] {
    return [{ type: 'setParam', nodeId: spec.nodeId, paramPath: SCOPE_PARAM, value: spec.scope }];
  },
};
