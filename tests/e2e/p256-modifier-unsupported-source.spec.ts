// #256 (V38) — a geometry modifier only reshapes MESH data; on non-mesh data it passes
// THROUGH unchanged. That silent no-op read as "the modifier is broken", so the modifier
// inspector surfaces the limitation and the pass-through becomes EXPECTED, not a bug.
//
// ⚠️ #415 SHRANK WHAT THIS SPEC CAN TEST, and the shrinking is the finding.
//
// It used to wire `Group.out → ArrayModifier.target` — the #256 case exactly, an
// unsupported source passing through with a banner to explain it. That wiring is now
// IMPOSSIBLE: on the data lane `target` takes `ObjectData`, a Group emits `SceneObject`,
// and `ops.ts` compares socket types by exact string equality with no widening. The
// connect is refused. So the class of confusion #256 was filed about — "I dropped an Array
// on my imported asset and nothing happened" — cannot occur any more; the type system says
// what the banner used to say in prose, at the moment of the attempt rather than after it.
//
// What survives is genuine and narrower: a CURVE's data can be wired to a modifier (both
// sides are `ObjectData`) and is correctly left alone, because a curve is not a mesh face.
// Measured, not assumed — Blender 5.1.1 accepts 55 modifier types on a mesh and none of
// the geometry ones on a curve's behalf here (`GROUND_TRUTH_BLENDER_MODIFIER_DATA.md` §9).
//
// Both halves are asserted: the banner appears for non-mesh DATA, and the old Group wiring
// is REFUSED rather than silently accepted. The refusal is the important one — if that
// connect ever succeeds again, the socket has been widened and this whole slice is undone.
//
// Falsifiable: remove the unsupported-source note → the banner assertion fails.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCurveDataId, splitCurveOps } from './_splitCurve';
import { modifierChainOps } from './_modifierStack';

interface W {
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown, a?: string, l?: string) => unknown;
      dispatchAtomic: (ops: unknown[], a?: string, l?: string) => unknown;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
}

const CURVE = 'p256_curve';
const CURVE_DATA = splitCurveDataId(CURVE);
const MOD = 'p256_arr';

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_dag), {
    timeout: 15000,
  });
  await page.waitForTimeout(400);
}

test('modifier stack warns when its source is non-mesh data (passes through)', async ({ page }) => {
  await ready(page);
  await page.evaluate(
    ({ ops, chain }) => {
      (window as unknown as W)
        .__basher_dag!.getState()
        .dispatchAtomic(
          [...(ops as unknown[]), ...(chain as unknown[])],
          'e2e',
          'curve data → array → object',
        );
    },
    {
      ops: splitCurveOps({ objectId: CURVE }),
      chain: modifierChainOps({
        objectId: CURVE,
        dataId: CURVE_DATA,
        modifiers: [
          { id: MOD, nodeType: 'ArrayModifier', params: { count: 3, offset: [2, 0, 0] } },
        ],
      }),
    },
  );

  // Selecting the modifier shows the 'modifier' inspector section; its base resolves to
  // the CurveData → the unsupported-source note appears.
  await page.evaluate(
    (mod) => (window as unknown as W).__basher_selection!.getState().select(mod),
    MOD,
  );
  await expect(page.getByTestId('modifier-unsupported-source')).toBeVisible();
  await expect(page.getByTestId('modifier-unsupported-source')).toContainText('CurveData');
});

test('#415 — a scene object cannot be wired to a modifier at all (the socket refuses it)', async ({
  page,
}) => {
  await ready(page);
  // The pre-#415 shape: a Group feeding a modifier's `target`. It used to connect and pass
  // through with a banner; now the connect itself must fail. Asserting the REFUSAL is what
  // keeps the narrowing above honest — without it, "the banner no longer covers Groups"
  // would be indistinguishable from "Groups silently stopped being checked".
  const refused = await page.evaluate(() => {
    const dag = (window as unknown as W).__basher_dag!.getState();
    dag.dispatch({ type: 'addNode', nodeId: 'p256_grp', nodeType: 'Group', params: {} });
    dag.dispatch({
      type: 'addNode',
      nodeId: 'p256_bad',
      nodeType: 'ArrayModifier',
      params: { count: 3, offset: [2, 0, 0] },
    });
    try {
      dag.dispatch({
        type: 'connect',
        from: { node: 'p256_grp', socket: 'out' },
        to: { node: 'p256_bad', socket: 'target' },
      });
      return { threw: false, message: '' };
    } catch (e) {
      return { threw: true, message: String((e as Error).message ?? e) };
    }
  });
  expect(refused.threw).toBe(true);
  // Named explicitly: a generic throw could come from anywhere (a bad id, a cycle guard).
  expect(refused.message).toContain('type mismatch');
  expect(refused.message).toContain('ObjectData');
});
