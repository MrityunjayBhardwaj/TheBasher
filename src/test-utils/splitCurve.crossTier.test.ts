// The one place the two curve fixture builders are compared to each other.
//
// WHY THIS FILE EXISTS
// `src/test-utils/splitCurve.ts` (unit) and `tests/e2e/_splitCurve.ts` (end-to-end) build
// the same split pair and DELIBERATELY come to rest at different geometry. The unit helper
// writes no `points`/`resolution`, so a CurveData minted through it takes the schema
// defaults — a gentle S-curve at resolution 16. The e2e helper substitutes a LOPSIDED path
// (one long span, then two tight ones) at resolution 32, chosen so that arc-length
// behaviour is actually exposed: on an evenly spaced curve, parameter-space sampling and
// arc-length sampling agree, and a follow-path spec would pass without measuring anything.
//
// Both files SAY this in a comment. Until now nothing enforced it. A reasonable cleanup —
// "these two builders differ for no reason, let's unify them" — would keep every test in
// the suite green while silently changing the curve that roughly 45 e2e specs measure, and
// the arc-length ones would go on passing against a fixture that can no longer expose the
// bug they were written for. That is the instrument drifting from what it measures, and it
// is invisible to both detectors: no type changes, and grep finds two files that look like
// duplicates.
//
// The divergence needs a home that imports across BOTH tiers, and this is the only kind of
// file that can be one. Vitest's `exclude: ['tests/**/*']` (vitest.config.ts) governs test
// DISCOVERY, not module resolution, so a unit test may import an e2e helper as a plain
// module — and `tests/e2e/_splitCurve.ts` is pure, so nothing browser-shaped comes with it.
// It lives in the unit tier rather than the e2e tier because it needs no browser and the
// e2e suite already runs ~110 minutes.
//
// IF YOU ARE HERE BECAUSE THIS TEST WENT RED: it is not asking you to restore the values.
// It is asking you to decide deliberately. Changing either builder's defaults changes what
// the specs downstream of it measure; if that is what you intend, re-derive the specs and
// then update the expectations here with the new reason.
//
// REF: src/test-utils/splitKinds.ts (the shared op list, and why defaults stayed OUT of it);
//      src/nodes/CurveData.ts (the schema defaults); issues #471, #385.

import { beforeAll, describe, expect, it } from 'vitest';
import { splitCurveOps } from '../../tests/e2e/_splitCurve';
import { emptyDagState } from '../core/dag/state';
import { snapshotRegistry } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { makeSplitCurve } from './splitCurve';

beforeAll(() => {
  registerAllNodes();
});

/** The params the e2e builder DECLARES for the CurveData, before the schema parses them. */
function e2eDataParams(): Record<string, unknown> {
  const ops = splitCurveOps({ objectId: 'n_curve' }) as Array<{
    type: string;
    nodeType?: string;
    params?: Record<string, unknown>;
  }>;
  const add = ops.find((op) => op.type === 'addNode' && op.nodeType === 'CurveData');
  if (!add?.params) throw new Error('splitCurveOps no longer emits an addNode for CurveData');
  return add.params;
}

/** The params a CurveData actually COMES TO REST at through the unit builder (parsed, so
 *  every unwritten param has been filled in with its schema default). */
function unitDataParams(): Record<string, unknown> {
  const { state, dataId } = makeSplitCurve(emptyDagState(), { objectId: 'n_curve' });
  return state.nodes[dataId].params as Record<string, unknown>;
}

describe('the two curve fixture builders diverge on purpose', () => {
  it('the unit builder writes no geometry, so its curve is CurveData s schema default', () => {
    // Guard the guard, twice over. If `addNode` ever stopped filling defaults in, the
    // comparisons below would be reading `undefined` against a number and would "differ"
    // for a reason that has nothing to do with either builder's intent.
    const parsed = snapshotRegistry().CurveData?.paramSchema?.safeParse({});
    expect(parsed?.success, 'CurveData no longer parses an empty param bag').toBe(true);
    const schemaDefaults = (parsed as { data: Record<string, unknown> }).data;

    const unit = unitDataParams();
    expect(
      unit.resolution,
      'the unit builder is supposed to take the schema default resolution, not choose one',
    ).toBe(schemaDefaults.resolution);
    expect(
      unit.points,
      'the unit builder is supposed to take the schema default points, not choose them',
    ).toEqual(schemaDefaults.points);
  });

  it('the e2e builder substitutes a LOPSIDED path at a higher resolution', () => {
    const e2e = e2eDataParams();
    const unit = unitDataParams();

    expect(
      e2e.resolution,
      'the e2e curve fixture resolution changed — roughly 45 specs sample this curve, and ' +
        'the arc-length ones were written against a denser sampling than the schema default',
    ).toBe(32);
    expect(
      e2e.resolution,
      'the two builders now agree on resolution. If that was a deliberate unification, the ' +
        'arc-length specs downstream of the e2e builder need re-deriving first — see the ' +
        'header of this file',
    ).not.toEqual(unit.resolution);

    // The point of the e2e path is that its spans are UNEQUAL: a long first span followed
    // by short ones. Asserting the literal coordinates would just restate the builder, so
    // assert the property the fixture exists to have.
    const pts = e2e.points as Array<{ co: [number, number, number] }>;
    expect(
      pts.length,
      'the e2e curve needs at least three points to have unequal spans',
    ).toBeGreaterThanOrEqual(3);
    const spans: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1].co;
      const b = pts[i].co;
      spans.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    expect(
      Math.max(...spans) / Math.min(...spans),
      'the e2e curve fixture is no longer lopsided — on an evenly spaced curve, parameter ' +
        'sampling and arc-length sampling agree, so every follow-path spec that samples it ' +
        'would pass without being able to expose the bug it was written for',
    ).toBeGreaterThan(2);
  });

  it('the e2e points carry stable ids and the unit points do too (the shape is shared)', () => {
    // What the two builders MUST agree on: the point shape ({id, co}) the schema accepts.
    // Divergence is licensed for the values, never for the contract — a builder that
    // emitted bare Vec3[] would fail validation in the browser and nowhere else.
    const e2ePts = e2eDataParams().points as Array<Record<string, unknown>>;
    const unitPts = unitDataParams().points as Array<Record<string, unknown>>;
    for (const [label, pts] of [
      ['e2e', e2ePts],
      ['unit', unitPts],
    ] as const) {
      expect(pts.length, `${label} points are empty`).toBeGreaterThan(0);
      for (const p of pts) {
        expect(typeof p.id, `${label} control point is missing a stable id`).toBe('string');
        expect(Array.isArray(p.co), `${label} control point is missing its coordinates`).toBe(true);
      }
    }
  });
});
