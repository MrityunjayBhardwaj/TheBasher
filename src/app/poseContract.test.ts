// The pose contract (object↔data split, Phase 2 · #362, design §9).
//
// THE PIN THAT ENDS THE CLASS: a node that OFFERS a Constraints panel must
// actually be POSABLE — it must carry a `position` the engine can move. "Posable"
// is not a UI label a positionless node can wear. When the label and the pose
// drift, a kind is constrainable in the UI yet inert in the engine (#356): the
// panel adds a Track-To that moves nothing.
//
// This is what `inspectorSectionsRegistry.test.ts` "should have been": that file
// pins section DECLARATIONS against each other (a 'transform' node also declares
// 'constraint'); it never checks the declaration is BACKED by a pose — which is
// exactly why glTF/AmbientLight/Scatter sailed through advertising a Constraints
// panel over a positionless value.
//
// HOW it checks, without a fragile per-type param builder:
//   - Value-level (the strongest form) for every node that spawns from its schema
//     defaults: evaluate it and assert the VALUE the engine consumes carries a
//     Vec3 `position`. This catches AmbientLight/Scatter at the exact thing posed.
//   - Schema-level fallback for nodes with a domain-required param (BoxMesh needs
//     `size`, glTF needs `assetRef`, a baked mesh needs its geometry ref): assert
//     the param schema declares a top-level `position`. No construction, no blind
//     spot — an unconstructable node is checked, not silently skipped.
//
// The exception is DERIVED, not a name list: a relational pose OPERATOR (Track-To,
// Follow-Path) IS the constraint — it writes a target's pose and does not evaluate
// to a self-posed value — so it declares 'constraint' without carrying a position.
// `isRelationalPoseNode` is the same species predicate the section pin uses (#339),
// so the next operator joins without editing this test.
//
// REF: docs/OBJECT-DATA-SPLIT-DESIGN.md §9; src/nodes/ObjectNode.ts (the posable
// node this contract is built around); #356 (the defect it makes unrepresentable).

import { beforeAll, describe, expect, it } from 'vitest';
import type { ZodObject, ZodRawShape } from 'zod';
import { __resetRegistryForTests, snapshotRegistry } from '../core/dag/registry';
import { isRelationalPoseNode } from './nodeConstraints';
import { registerAllNodes } from '../nodes/registerAll';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/** True iff the node carries a pose the engine can move. Value-level when the node
 *  spawns from schema defaults (the value is what gets posed); schema-level when a
 *  domain-required param blocks default construction (the `position` param is the
 *  same pose, one layer up — every posable node emits `position: params.position`). */
function carriesPose(def: {
  paramSchema: ZodObject<ZodRawShape>;
  evaluate: (p: unknown, i: unknown) => unknown;
}): boolean {
  const parsed = def.paramSchema.safeParse({});
  if (parsed.success) {
    const value = def.evaluate(parsed.data, {}) as { position?: unknown };
    return isVec3(value?.position);
  }
  return 'position' in def.paramSchema.shape;
}

describe('the pose contract (§9)', () => {
  it('every constraint-declaring node is posable (carries a position)', () => {
    const snap = snapshotRegistry();
    const offenders: string[] = [];
    for (const [type, def] of Object.entries(snap)) {
      if (!def.inspectorSections?.includes('constraint')) continue;
      // The operator IS the constraint (writes a target's pose, not its own value).
      if (isRelationalPoseNode({ type })) continue;
      if (!carriesPose(def as never)) offenders.push(type);
    }
    expect(
      offenders,
      `these nodes offer a Constraints panel but carry no pose — constrainable in the UI, inert in the engine (#356): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
