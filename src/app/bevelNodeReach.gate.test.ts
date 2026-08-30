// bevelNodeReach — THE NODE'S PASSTHROUGH ARM AND THE BUILDER'S REFUSAL ARE ONE PREDICATE,
// SPELLED TWICE (#818 over #814).
//
// ── WHAT THIS FILE EXISTS FOR, STATED BEFORE ANY ROW ───────────────────────────────────
//
// `bevelGeometryRef` THROWS on a non-positive amount, by design and with a measured reason:
// at `0` the build declares 24 topological points and welds to 8, and at `-0.1` it welds to
// 24 and draws an inside-out shell with nothing said. `BevelModifier.evaluate` passes its
// source through on exactly the same condition, so that throw is unreachable from the node.
//
// 🔴 THE HAZARD IS THAT NOTHING RELATES THE TWO. They live in different files, the types say
// nothing about either, and `evaluate` runs on the render walk with NO `try` above it and no
// node-error surface in this project. So a widening on one side — a schema that starts
// admitting a value the builder still refuses, or a builder that tightens — is a crash on the
// render path reachable by dragging a slider, and it is a crash that no count, hash or
// membership census anywhere in this repo can see.
//
// The check below does not compare the two SPELLINGS, which would be a grep that goes green
// the moment someone writes the same condition differently. It runs both over a shared set of
// values and compares the ANSWERS: for every amount the schema admits, the node must pass
// through exactly when the builder would refuse.
//
// ── WHY THE ZERO ARM IS PASSTHROUGH AND NOT A REFUSAL ──────────────────────────────────
//
// Taken from the reference rather than from preference. `MOD_bevel.cc:303-307`:
//
//     static bool is_disabled(const Scene *, ModifierData *md, bool)
//     { BevelModifierData *bmd = ...; return (bmd->value == 0.0f); }
//
// A disabled modifier is SKIPPED by Blender's stack. So a zero-amount bevel is transparent —
// the same stance an unconfigured Mask takes, and for the same reason: the state is an
// authoring step on the way to something, not an operator that should not be in the chain.
//
// REF: src/nodes/BevelModifier.ts (the node and the arm); src/app/modifierGeometry.ts
//      (`bevelGeometryRef` and the refusal); src/app/bevelLayout.ts; issues #818, #814, #817.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { getNodeType } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { evaluateNodeAlone } from '../test-utils/evaluateNodeAlone';
import { boxGeometryRef, bevelGeometryRef } from './modifierGeometry';
import { BevelModifierParams } from '../nodes/BevelModifier';
import type { ObjectData } from '../nodes/types';

const box = () => boxGeometryRef([1, 1, 1], null);

const source = (): ObjectData =>
  ({ kind: 'MeshData', geometry: box(), material: null, attributeKey: null }) as ObjectData;

/**
 * The amounts probed on BOTH roads. Chosen to straddle every boundary either side could
 * plausibly draw: the two sentinels the builder's message names by hand (`0`, a negative),
 * a value smaller than any epsilon anybody would be tempted to introduce, the schema's
 * default, and one past #817's measured `0.5` collapse point for a unit cube.
 */
const AMOUNTS = [-1, -0.1, 0, 1e-9, 0.001, 0.1, 0.25, 0.5, 0.9, 3] as const;

/** Does the BUILDER accept this amount? Asked by calling it, never by reading its condition. */
function builderAccepts(amount: number): boolean {
  try {
    bevelGeometryRef(box(), amount);
    return true;
  } catch {
    return false;
  }
}

/** Does the SCHEMA admit this amount? The gate between an author and the node. */
function schemaAdmits(amount: number): boolean {
  return BevelModifierParams.safeParse({ amount }).success;
}

/**
 * What the NODE did with it: `'passthrough'` when it handed the spine value back by
 * reference, `'built'` when it produced a `ModifiedData`, `'threw'` when it reached the
 * builder's refusal — which is the outcome this whole file exists to prove impossible.
 */
function nodeOutcome(amount: number): 'passthrough' | 'built' | 'threw' {
  const src = source();
  try {
    const out = evaluateNodeAlone('BevelModifier', { amount, muted: false }, { target: src });
    return out === src ? 'passthrough' : 'built';
  } catch {
    return 'threw';
  }
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#818 — the node cannot reach the builder’s refusal', () => {
  it('THE INSTRUMENT CONTROL: both roads answered, and they disagree somewhere', () => {
    // A probe where one road silently answers the same thing for everything would make every
    // row below pass while examining nothing. Both partitions must be non-trivial.
    const accepted = AMOUNTS.filter(builderAccepts);
    const refused = AMOUNTS.filter((a) => !builderAccepts(a));
    expect({
      examined: AMOUNTS.length,
      accepted: accepted.length,
      refused: refused.length,
    }).toEqual({ examined: 10, accepted: 7, refused: 3 });

    // And the node is really registered and really evaluated — an unregistered type would
    // throw on every row and read as "the arm is missing" rather than "the probe is broken".
    expect(getNodeType('BevelModifier')).toBeDefined();
    expect(nodeOutcome(0.1)).toBe('built');
  });

  it('🔴 THE CLAIM: for every amount the SCHEMA admits, the node never reaches the throw', () => {
    // The whole file in one row. Not a comparison of two conditions — a comparison of two
    // ANSWERS, so re-spelling either side cannot make it pass.
    const admitted = AMOUNTS.filter(schemaAdmits);
    const reached = admitted.filter((a) => nodeOutcome(a) === 'threw');
    expect({ admitted: admitted.length, reached }).toEqual({ admitted: 8, reached: [] });
  });

  it('🔴 …and the two partitions are the SAME partition: passthrough exactly where refused', () => {
    // The half that cannot pass vacuously. A node that passed everything through would satisfy
    // the row above and fail here, and so would one that built everything.
    const rows = AMOUNTS.filter(schemaAdmits).map((amount) => ({
      amount,
      outcome: nodeOutcome(amount),
      builder: builderAccepts(amount) ? 'accepts' : 'refuses',
    }));
    expect(rows).toEqual([
      // The one admitted amount the builder refuses — the reference's `is_disabled` state.
      { amount: 0, outcome: 'passthrough', builder: 'refuses' },
      { amount: 1e-9, outcome: 'built', builder: 'accepts' },
      { amount: 0.001, outcome: 'built', builder: 'accepts' },
      { amount: 0.1, outcome: 'built', builder: 'accepts' },
      { amount: 0.25, outcome: 'built', builder: 'accepts' },
      // ⚠️ PAST #817's MEASURED COLLAPSE POINT AND STILL 'built'. That is the truth about this
      // operator today and it is pinned rather than hidden: the amount has no upper bound, the
      // shell self-intersects, and past the crossing point the count comes back RIGHT so
      // nothing warns. #817 owns the fix; this row is what will move when it lands.
      { amount: 0.5, outcome: 'built', builder: 'accepts' },
      { amount: 0.9, outcome: 'built', builder: 'accepts' },
      { amount: 3, outcome: 'built', builder: 'accepts' },
    ]);
  });

  it('the SCHEMA is the first gate: a negative amount never becomes params at all', () => {
    // So the node's arm is the SECOND line and not the only one. Both are asserted, because a
    // schema floor alone leaves a direct `evaluate` call — which the bypass-honouring gate
    // makes on purpose — able to hand a negative straight to the builder.
    expect(AMOUNTS.filter((a) => !schemaAdmits(a))).toEqual([-1, -0.1]);
    expect(schemaAdmits(0)).toBe(true);

    // The default is inside the accepted set, so a freshly-dropped Bevel builds rather than
    // sitting transparent — the reference's behaviour, and the reason it is `0.1` and not `0`.
    const defaulted = BevelModifierParams.parse({});
    expect(defaulted.amount).toBe(0.1);
    expect(builderAccepts(defaulted.amount)).toBe(true);
  });

  it('THE MUST-RED: the builder really does refuse, by name, on the values the arm covers', () => {
    // Stated positively so this file cannot go green by the refusal quietly disappearing —
    // which would make every `passthrough` above a coincidence rather than a guard.
    expect(() => bevelGeometryRef(box(), 0)).toThrow(/positive amount and got 0/);
    expect(() => bevelGeometryRef(box(), -0.1)).toThrow(/positive amount and got -0\.1/);
  });

  it('a bevel carries NO attribute component, so the node’s slot table cancels itself', () => {
    // #814 decided this and `modifierGeometry.ts` argues it: a bevel genuinely does not express
    // its source's per-face assignment, so two differently-assigned sources SHOULD share one
    // build. Asserted here because `BevelModifier.evaluate` calls `slotTableThrough` anyway,
    // and that call is only correct while this holds — the day a bevel gains an attribute
    // component, the node starts emitting a table for geometry whose faces mostly have no
    // source, and this row is what says so first.
    expect(bevelGeometryRef(box(), 0.1).attributeKey).toBeUndefined();
    const built = evaluateNodeAlone(
      'BevelModifier',
      { amount: 0.1, muted: false },
      { target: source() },
    ) as { materialSlots?: unknown; attributeKey?: unknown };
    expect(Object.keys(built)).toEqual(['kind', 'geometry', 'material']);
  });
});
