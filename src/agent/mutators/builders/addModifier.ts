// addModifier Mutator — the agent's authoring op for the geometry OperatorStack
// (epic #201, #209, V58). The agent counterpart of the UI's "+ Add Modifier"
// (ModifierStackControls): it inserts a geometry modifier at the TOP of a mesh's
// stack through the SAME operatorStack.buildAddModifierOps the panel uses — one
// wiring authority, no second road. §2.2's "add a Subdivide / add a Track-To"
// agent op, instantiated for the geometry stack.
//
// Closure: rootSelectors = [target]; followedEdges = ['parent'] so the consumer
// the modifier splices in front of (Scene / the existing top modifier) sits in
// scope alongside the base — the re-wire touches base + consumer, both reachable
// consumer-side from the root, and the fresh modifier id is gate-3 allowed.
//
// REF: src/app/operatorStack.ts; src/nodes/ArrayModifier.ts;
//      src/agent/mutators/builders/addPass.ts (the wiring-mutator template);
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §2.2/§5; vyapti V58.

import { z } from 'zod';
import type { MutatorDefinition } from '../types';
import type { ClosureSet, ClosureSpec } from '../../closure/types';
import type { DagState } from '../../../core/dag/state';
import type { NodeId, Op } from '../../../core/dag/types';
import { buildAddModifierOps, MODIFIER_NODE_TYPES } from '../../../app/operatorStack';

// v1: the one geometry modifier. New modifiers join MODIFIER_NODE_TYPES + this enum.
const ModifierType = z.enum(['ArrayModifier']);
type ModifierType = z.infer<typeof ModifierType>;

const AddModifierSpec = z.object({
  /** The mesh to modify (or any modifier in its stack — the op resolves the base). */
  target: z.string().min(1),
  modifierType: ModifierType,
  /** Array params (optional — the node schema defaults count=3, offset=[2,0,0]). */
  count: z.number().int().positive().optional(),
  offset: z.tuple([z.number(), z.number(), z.number()]).optional(),
  /** Caller-supplied modifier id; auto-derived from target + type when omitted. */
  modifierId: z.string().optional(),
});
export type AddModifierSpec = z.infer<typeof AddModifierSpec>;

/** A deterministic, collision-free modifier id (target + short type + counter). */
function defaultModifierId(target: NodeId, modifierType: string, used: Set<NodeId>): NodeId {
  const short = modifierType.replace(/Modifier$/, '').toLowerCase(); // ArrayModifier → array
  const base = `${target}_${short}`;
  if (!used.has(base)) return base;
  let n = 1;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function specParams(spec: AddModifierSpec): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (spec.count !== undefined) p.count = spec.count;
  if (spec.offset !== undefined) p.offset = spec.offset;
  return p;
}

export const addModifierMutator: MutatorDefinition<AddModifierSpec> = {
  name: 'mutator.geometry.addModifier',
  description:
    'Add a geometry MODIFIER (the SOP / geometry-operator stack) on top of a ' +
    "mesh's modifier stack — a non-destructive, re-orderable operation over the " +
    'mesh geometry. modifierType "ArrayModifier" replicates the mesh `count` ' +
    'times along `offset` (local space) and merges. target may be the mesh or any ' +
    'modifier already in its stack (the base is resolved automatically). Returns a ' +
    'deterministic modifierId; tune it later with dag.exec setParam (count / ' +
    'offset / muted) or stack it with another addModifier call.',
  spec: AddModifierSpec,
  specExample: {
    target: 'cube',
    modifierType: 'ArrayModifier',
    count: 3,
    offset: [2, 0, 0],
    modifierId: 'cube_array',
  },
  contract: {
    // The modifier splices into the base→consumer edge; no specific input socket is
    // REQUIRED (the closure roots on the target and walks consumer-side).
    requiredEdges: [],
    requiredNodeTypes: [],
    // The base mesh's own TRS + material bands are untouched (the modifier inherits
    // them). NOT 'children': the op re-routes the consumer's child edge through the
    // modifier, so what the consumer renders changes — the honest discriminator vs
    // addChannel (which preserves all five), satisfying V14 non-redundancy.
    preserves: ['position', 'rotation', 'scale', 'material'],
  },
  buildClosureSpec(spec): ClosureSpec {
    // Root on the target; walk consumer-side ('parent') so the node the modifier
    // splices in front of (Scene / the existing top modifier) is in scope.
    return { rootSelectors: [spec.target], followedEdges: ['parent'] };
  },
  preconditions(spec, _closure, state) {
    if (!state.nodes[spec.target]) {
      return { ok: false, reason: `target "${spec.target}" not in DAG.` };
    }
    if (!MODIFIER_NODE_TYPES.has(spec.modifierType)) {
      return { ok: false, reason: `unknown modifierType "${spec.modifierType}".` };
    }
    if (spec.modifierId !== undefined && state.nodes[spec.modifierId]) {
      return { ok: false, reason: `modifierId "${spec.modifierId}" already exists.` };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const used = new Set<NodeId>(Object.keys(state.nodes));
    const modifierId = spec.modifierId ?? defaultModifierId(spec.target, spec.modifierType, used);
    const res = buildAddModifierOps(state, spec.target, spec.modifierType, specParams(spec), modifierId);
    if (!res) {
      throw new Error(`addModifier.build: target "${spec.target}" not in DAG (preconditions should have caught).`);
    }
    return res.ops;
  },
};
