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
// ── WHY THE STACK IS A MATERIAL OP WITH A MODIFIER ABOVE IT, AND WHY IT IS REWIRED ───
//
// `MaterialOverrideOp` declares `section: 'material'`, so `isModifierNode` is false for it
// and resolving it does NOT enter the arm under test. A geometry modifier must sit ABOVE
// it. The two sections share one physical chain and are transparent to each other
// (`enumerateOperatorStack`, #526), so this order is representable — but MEASURED, the
// add-operator builders do not produce it: `buildAddModifierOps` splices at the top of the
// MODIFIER stack, which sits BELOW the material stack, giving
// `BoxData → ArrayModifier → MaterialOverrideOp → Object` in either insertion order. The
// modifier's source is then the bare data, with one slot, and the arm has nothing to drop.
//
// So the wiring is swapped explicitly here rather than built by the panel's road. That is
// the honest fixture: the order under test is reachable by rewiring (the node editor, or an
// agent `connect`), not by the add buttons, and a test that pretended otherwise would be
// asserting a topology the builders never emit.
//
// REF: src/app/resolveEvaluatedMesh.ts (the modifier arm); src/nodes/MaterialOverrideOp.ts
//      (`materialSlots: [base, composed]` beside `material: composed`); issue #978, #605.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyOp,
  emptyDagState,
  __resetRegistryForTests,
  type DagState,
  type Op,
} from '../core/dag';
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
 * it. Both operators are CREATED through the production builders — so their params, ids and
 * spine sockets are whatever the panel actually produces — and then the three spine edges
 * are re-pointed, because the builders cannot express this order (see the header).
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

  const matRes = buildAddMaterialOpOps(
    seeded.state,
    resolveStackBase(seeded.state, seeded.objectId),
    'MaterialOverrideOp',
    { muted: false, scope: '0-1', color: WIRED_COLOR, overridden: { color: true } },
    'n_matop',
  );
  if (!matRes) throw new Error('buildAddMaterialOpOps returned null');
  const withMat: DagState = matRes.ops.reduce((acc, op) => applyOp(acc, op).next, seeded.state);

  const modRes = buildAddModifierOps(
    withMat,
    resolveStackBase(withMat, seeded.objectId),
    'ArrayModifier',
    { count: 2, offset: [2, 0, 0], muted: false },
    'n_arr',
  );
  if (!modRes) throw new Error('buildAddModifierOps returned null');
  const built: DagState = modRes.ops.reduce((acc, op) => applyOp(acc, op).next, withMat);

  // The builders leave `BoxData → n_arr → n_matop → Object`. Re-point the three edges so the
  // modifier sits ABOVE the material op, which is the order the arm under test is about.
  const rewire: Op[] = [
    {
      type: 'connect',
      from: { node: seeded.dataId, socket: 'out' },
      to: { node: 'n_matop', socket: 'target' },
      replace: true,
    },
    {
      type: 'connect',
      from: { node: 'n_matop', socket: 'out' },
      to: { node: 'n_arr', socket: 'target' },
      replace: true,
    },
    {
      type: 'connect',
      from: { node: 'n_arr', socket: 'out' },
      to: { node: seeded.objectId, socket: 'data' },
      replace: true,
    },
  ];
  const state: DagState = rewire.reduce((acc, op) => applyOp(acc, op).next, built);

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
