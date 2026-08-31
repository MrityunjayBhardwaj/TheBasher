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
import {
  buildAddModifierOps,
  operatorTypesInSection,
  resolveStackBase,
} from '../../../app/operatorStack';
import { canModifyGeometry } from '../../../app/modifierGeometry';

// THE ONE MEMBERSHIP LIST ns-2 step 7 LEAVES IN PLACE, and the reason is the type system,
// not habit. `z.enum` needs a LITERAL tuple at schema-construction time to produce a literal
// union; a set derived from the registry yields `string`, and `specParams` below narrows on
// `spec.modifierType === 'ArrayModifier'` to scope Array's params away from Mirror's. Derive
// this and that narrowing collapses — the same structural reason `MATERIAL_LANE_TYPES` keeps
// its tuple. The two honest alternatives were measured and both cost more than they save:
// the spec is built at MODULE scope (so a lazy per-call schema would change the mutator
// contract for every mutator in the repo), and `z.string().refine(...)` removes the
// enumerated options from the JSON schema the model actually reads, which is a real
// regression in what the agent can address.
//
// ⇒ it is KEPT and PINNED instead: `operatorMembership.gate.test.ts` asserts this enum's
// members set-equal the registry-derived `'modifier'` set exactly, with a minted liar
// proving the cross-check can fail. Forgetting a new modifier here is therefore loud in CI
// rather than silent — but it is NOT unconstructible, and that difference is recorded in
// the blindness census rather than glossed: this surface is still one a new operator is
// invisible to.
const ModifierType = z.enum(['ArrayModifier', 'MirrorModifier', 'MaskModifier', 'BevelModifier']);
type ModifierType = z.infer<typeof ModifierType>;

const AddModifierSpec = z.object({
  /** The mesh to modify (or any modifier in its stack — the op resolves the base). */
  target: z.string().min(1),
  modifierType: ModifierType,
  /** Array params (optional — the node schema defaults count=3, offset=[2,0,0]). */
  count: z.number().int().positive().optional(),
  offset: z.tuple([z.number(), z.number(), z.number()]).optional(),
  /** Mirror param (optional — the node schema defaults axis='x'). */
  axis: z.enum(['x', 'y', 'z']).optional(),
  /**
   * Bevel param (optional — the node schema defaults amount=0.1).
   *
   * `.min(0)` rather than `.positive()`, mirroring the node's own schema for the reason its
   * header states: zero is the reference's `is_disabled` state, which the operator answers by
   * passing its source through. A negative one has no reading at all and is refused here so
   * it never reaches a builder that would throw on the render walk.
   */
  amount: z.number().min(0).optional(),
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
  // Scope params to the modifier type so a cross-type param (e.g. Array's Vec3
  // `offset`) never lands on a node whose schema expects a different shape.
  const p: Record<string, unknown> = {};
  if (spec.modifierType === 'ArrayModifier') {
    if (spec.count !== undefined) p.count = spec.count;
    if (spec.offset !== undefined) p.offset = spec.offset;
  } else if (spec.modifierType === 'MirrorModifier') {
    if (spec.axis !== undefined) p.axis = spec.axis;
  } else if (spec.modifierType === 'BevelModifier') {
    if (spec.amount !== undefined) p.amount = spec.amount;
  }
  return p;
}

export const addModifierMutator: MutatorDefinition<AddModifierSpec> = {
  name: 'mutator.geometry.addModifier',
  description:
    'Add a geometry MODIFIER (the SOP / geometry-operator stack) on top of a ' +
    "mesh's modifier stack — a non-destructive, re-orderable operation over the " +
    'mesh geometry. modifierType "ArrayModifier" replicates the mesh `count` ' +
    'times along `offset` (local space) and merges; "MirrorModifier" reflects the ' +
    'mesh across the local-origin plane on `axis` (x|y|z) and merges → a symmetric ' +
    'whole; "MaskModifier" keeps the faces its `scope` names and drops the rest (or ' +
    'the reverse, via `keep`); "BevelModifier" chamfers every edge by `amount` in ' +
    'local units, which MINTS faces — a quad per source edge and an n-gon per source ' +
    "point — and drops the source's per-face materials, so an amount of 0 leaves the " +
    'mesh untouched. target may be the mesh or any modifier already in its stack (the base ' +
    'is resolved automatically). Returns a deterministic modifierId; tune it later ' +
    'with dag.exec setParam (count / offset / axis / amount / keep / muted) or stack it with ' +
    'another addModifier call.',
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
    // Asked of the DERIVATION, not of the enum: the enum has already accepted the value by
    // the time preconditions run, so re-asking it would check the spec against itself. This
    // asks whether a modifier of that type is actually registered and declares the modifier
    // section — the question the builder downstream depends on.
    if (!operatorTypesInSection('modifier').includes(spec.modifierType)) {
      return { ok: false, reason: `unknown modifierType "${spec.modifierType}".` };
    }
    if (spec.modifierId !== undefined && state.nodes[spec.modifierId]) {
      return { ok: false, reason: `modifierId "${spec.modifierId}" already exists.` };
    }
    // #498 — the same refusal `buildAddModifierOps` now makes, asked here so the agent
    // gets a structured reason instead of `build` throwing a misleading "not in DAG".
    // Asked through `canModifyGeometry` (the modifier's own accept predicate) rather
    // than a type list, so this cannot drift from what the builder will actually do.
    const base = resolveStackBase(state, spec.target);
    if (!canModifyGeometry(state, base)) {
      return {
        ok: false,
        reason:
          `"${spec.target}" resolves to data that a geometry modifier cannot reshape. ` +
          `Modifiers apply to mesh data (box, sphere, baked, or another modifier's output); ` +
          `curve, light and camera data have no geometry to rewrite.`,
      };
    }
    return { ok: true };
  },
  build(spec, _closure: ClosureSet, state: DagState): Op[] {
    const used = new Set<NodeId>(Object.keys(state.nodes));
    const modifierId = spec.modifierId ?? defaultModifierId(spec.target, spec.modifierType, used);
    // #415 — the agent names the OBJECT ("cube"), which is the right thing for it to
    // name; the stack lives on that object's DATA. Resolving through the same
    // `resolveStackBase` the panel uses is what keeps the agent op and the UI on one
    // wiring road — passing `spec.target` straight through would have wired the Object's
    // `out` into a socket that no longer accepts it.
    const res = buildAddModifierOps(
      state,
      resolveStackBase(state, spec.target),
      spec.modifierType,
      specParams(spec),
      modifierId,
    );
    if (!res) {
      throw new Error(
        `addModifier.build: target "${spec.target}" not in DAG (preconditions should have caught).`,
      );
    }
    return res.ops;
  },
};
