// #978 — the modifier arm of `resolveEvaluatedMesh` reads its materials at the depth its
// source offers, which is what the two sibling arms already do.
//
// ── WHY THIS IS A DAG TEST AND NOT A CALL TO `materialAssignmentOf` ───────────────────
//
// The defect was a SPELLING at one call site, so a unit test over that helper cannot see
// it: both the right and the wrong spelling return a well-formed `MaterialAssignment`.
// What discriminates is which spelling the ARM reaches for, and the only way to observe
// that is to resolve a real modifier node over a real two-slot source.
//
// ── WHY THE STACK IS A MATERIAL OP WITH A MODIFIER ABOVE IT, AND WHY THE ORDER OF THE
//    TWO ADD CALLS IS THE WHOLE FIXTURE ───────────────────────────────────────────────
//
// `MaterialOverrideOp` declares `section: 'material'`, so `isModifierNode` is false for it
// and resolving it does NOT enter the arm under test. A geometry modifier must sit ABOVE
// it. The two sections share one physical chain and are transparent to each other
// (`enumerateOperatorStack`, #526), and each builder splices at the top of ITS OWN section.
//
// 🔴 SO THE TWO INSERTION ORDERS ARE NOT SYMMETRIC, AND ASSUMING THEY WERE IS WHAT MADE
// THIS FIXTURE WRONG ONCE ALREADY. Measured, both orders, on this fixture's own nodes:
//
//     material op FIRST, then modifier   →  BoxData → ArrayModifier → MaterialOverrideOp
//     modifier FIRST, then material op   →  BoxData → MaterialOverrideOp → ArrayModifier
//
// Only the second puts the modifier over a source that carries a table. It is built by the
// panel's own add buttons, in that order, with no rewiring — which is why this file adds the
// MODIFIER first and the material op second, and why swapping those two calls silently turns
// every row below into a test of the wrong topology.
//
// REF: src/app/resolveEvaluatedMesh.ts (the modifier arm); src/nodes/MaterialOverrideOp.ts
//      (`materialSlots: [base, composed]` beside `material: composed`); issue #978, #605.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, emptyDagState, __resetRegistryForTests, type DagState } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { buildAddMaterialOpOps, buildAddModifierOps, resolveStackBase } from './operatorStack';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import { assignedMaterials, primaryMaterial } from './materialAssignment';

const SOURCE_COLOR = '#ff0000';
const WIRED_COLOR = '#00ff00';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };

const colorOf = (m: unknown): string | null => {
  const base = (m as { base?: { color?: unknown } } | null)?.base;
  return typeof base?.color === 'string' ? base.color : null;
};

/**
 * A split cube wearing a PARTIAL-RANGE `MaterialOverrideOp` with an `ArrayModifier` above
 * it — built entirely through the production builders, in the order the panel would use, so
 * the topology is what a director actually gets rather than a second description of it.
 *
 * `overridden: { color: true }` is what makes the composition non-identity — without a
 * field marked, the op composes to the source and BOTH slots would hold the same colour,
 * so the assertions below could not tell a correct answer from the collapsed one.
 */
function cubeWithScopedOverrideThenArray(): {
  state: DagState;
  objectId: string;
  matOpId: string;
  modifierId: string;
} {
  const seeded = makeSplitCube(emptyDagState(), {
    objectId: 'n_box',
    size: [1, 1, 1],
    color: SOURCE_COLOR,
  });

  // THE MODIFIER GOES ON FIRST. See the header: this order is the fixture.
  const modRes = buildAddModifierOps(
    seeded.state,
    resolveStackBase(seeded.state, seeded.objectId),
    'ArrayModifier',
    { count: 2, offset: [2, 0, 0], muted: false },
    'n_arr',
  );
  if (!modRes) throw new Error('buildAddModifierOps returned null');
  const withMod: DagState = modRes.ops.reduce((acc, op) => applyOp(acc, op).next, seeded.state);

  const matRes = buildAddMaterialOpOps(
    withMod,
    resolveStackBase(withMod, seeded.objectId),
    'MaterialOverrideOp',
    { muted: false, scope: '0-1', color: WIRED_COLOR, overridden: { color: true } },
    'n_matop',
  );
  if (!matRes) throw new Error('buildAddMaterialOpOps returned null');
  const state: DagState = matRes.ops.reduce((acc, op) => applyOp(acc, op).next, withMod);

  return { state, objectId: seeded.objectId, matOpId: 'n_matop', modifierId: 'n_arr' };
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#978 — a modifier over a partial-range material op', () => {
  it('THE INSTRUMENT CONTROL: the fixture really does produce a two-slot source', () => {
    // A probe that lost its subject reports the same clean answer as a fixed defect. If
    // the material op ever stops appending a table, every row below would pass for a
    // reason that has nothing to do with the arm under test.
    const { state, objectId } = cubeWithScopedOverrideThenArray();
    const viaObject = resolveEvaluatedMesh(state, objectId, ctx);
    expect(viaObject).not.toBeNull();
    expect(viaObject!.materials.slots).toHaveLength(2);
    expect(colorOf(viaObject!.materials.slots[0])).toBe(SOURCE_COLOR);
    expect(colorOf(viaObject!.materials.slots[1])).toBe(WIRED_COLOR);
  });

  it('reports BOTH slots, not the one the collapsed spelling carried', () => {
    const { state, modifierId } = cubeWithScopedOverrideThenArray();
    const mesh = resolveEvaluatedMesh(state, modifierId, ctx);
    expect(mesh).not.toBeNull();
    expect(mesh!.materials.slots).toHaveLength(2);
  });

  it('🔴 resolves the RIGHT material — the defect was a wrong answer, not a missing one', () => {
    // The collapse spelled `[source.material]`, and a material op emits `material` = the
    // COMPOSED spec, i.e. slot ONE. So the old arm answered green where red is correct.
    // This row is the discriminator: a fix that restored the slot COUNT but kept reading
    // `source.material` for slot 0 would still fail here.
    const { state, modifierId } = cubeWithScopedOverrideThenArray();
    const mesh = resolveEvaluatedMesh(state, modifierId, ctx);
    expect(colorOf(primaryMaterial(mesh!.materials))).toBe(SOURCE_COLOR);
  });

  it('agrees with the Object road about what the mesh is made of', () => {
    // The arm borrows the wearing Object for its POSE for exactly this reason; materials
    // are now read the same way, so the two roads cannot disagree about one mesh.
    const { state, objectId, modifierId } = cubeWithScopedOverrideThenArray();
    const viaModifier = resolveEvaluatedMesh(state, modifierId, ctx);
    const viaObject = resolveEvaluatedMesh(state, objectId, ctx);
    expect(assignedMaterials(viaModifier!.materials).map(colorOf)).toEqual(
      assignedMaterials(viaObject!.materials).map(colorOf),
    );
  });

  it('carries the per-face index, so the assignment is addressable and not just counted', () => {
    // `indices: null` with two slots would report two materials and be unable to say which
    // face wears which — the shape the literal `null` key produced.
    const { state, modifierId } = cubeWithScopedOverrideThenArray();
    const mesh = resolveEvaluatedMesh(state, modifierId, ctx);
    expect(mesh!.materials.indices).not.toBeNull();
  });
});
