// #327 — the agent's Apply/Reject must be REACHABLE, not merely visible.
//
// THE REASON THIS SPEC EXISTS, AND WHY IT LOOKS UNLIKE THE OTHER AGENT SPECS.
// Every other agent e2e accepts a diff through the STORE (`__basher_diff`
// .getState().accept(...)), because that is the convenient seam. So the whole
// suite could stay green while the actual Apply BUTTON sat underneath the
// inspector island, unclickable, for the entire life of the feature — the agent
// proposed and the director could not accept. `toBeVisible()` passed on it the
// whole time: the button WAS painted, it was just not on top.
//
// Visibility and reachability are different questions (V35 — an affordance must
// be REACHABLE, not just rendered). The only assertion that can tell them apart
// is an OCCLUSION probe: take the button's own box, and ask the document what is
// actually at those coordinates. If `elementFromPoint` hands back some other
// surface, a real user's click lands on that surface too.
//
// So: sample a grid across each button and demand every point belong to it —
// and then, once, CLICK it for real and prove the diff applied. On the pre-fix
// code the first assertion reads 0/9 (Apply) and 1/9 (Reject).
//
// REF: #327; V35 (reveal/affordance reachable), V46 (one geometry source),
// H91/V45 (the floating-surface overlap family — the toolbar and the 2D View
// were re-bounded for this same reason; the DiffBar predates the islands).

import { expect, test, type Page } from './_fixtures';
import { splitCurveOps } from './_splitCurve';

interface DiffWin {
  __basher_dag: {
    getState(): { state: { nodes: Record<string, { type: string }> } };
  };
  __basher_diff: {
    getState(): {
      propose: (
        state: unknown,
        ops: unknown[],
        description: string,
        opSources?: string[],
      ) => unknown;
    };
  };
}

/** Stage the exact proposal the real LLM makes for "add a curve" — a split Object↔CurveData
 *  pair (the fused `Curve` node is a retired migration relic post-#385). */
async function proposeCurve(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as Partial<DiffWin>).__basher_diff));
  const ops = splitCurveOps({
    objectId: 'p327_curve',
    points: [
      [0, 0, 0],
      [2, 0, 0],
      [4, 0, 2],
    ],
  });
  await page.evaluate((ops) => {
    const w = window as unknown as DiffWin;
    w.__basher_diff
      .getState()
      .propose(w.__basher_dag.getState().state, ops, 'add a curve', ['agent:mesh.add']);
  }, ops);
  await expect(page.getByTestId('diffbar')).toBeVisible();
}

/**
 * How many of 9 sample points across this element's box actually BELONG to it?
 * This is the assertion `toBeVisible()` cannot make.
 */
async function reachableSamples(page: Page, testId: string): Promise<number> {
  const el = page.getByTestId(testId);
  await expect(el).toBeVisible();
  const box = await el.boundingBox();
  expect(box, `${testId} has a layout box`).not.toBeNull();
  return page.evaluate(
    ({ box, testId }) => {
      let reached = 0;
      for (const fx of [0.15, 0.5, 0.85]) {
        for (const fy of [0.25, 0.5, 0.75]) {
          const hit = document.elementFromPoint(
            box.x + box.width * fx,
            box.y + box.height * fy,
          ) as HTMLElement | null;
          if (hit?.closest(`[data-testid="${testId}"]`)) reached++;
        }
      }
      return reached;
    },
    { box: box!, testId },
  );
}

test.describe('#327 — the DiffBar is reachable, not just visible', () => {
  test('Apply and Reject are unoccluded at the default width with the Inspector open', async ({
    page,
  }) => {
    // The DEFAULT desktop geometry — both side islands open. This is what the
    // director actually sees, and it is exactly where the bug lived.
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto('/');
    await proposeCurve(page);

    expect(await reachableSamples(page, 'diffbar-apply'), 'Apply — occluded sample points').toBe(9);
    expect(await reachableSamples(page, 'diffbar-reject'), 'Reject — occluded sample points').toBe(
      9,
    );
  });

  test('a REAL CLICK on Apply applies the diff (not a store call)', async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto('/');
    await proposeCurve(page);

    // No force, no dispatch — the click a director makes. If anything covers the
    // button, Playwright's actionability check fails here rather than silently
    // clicking through to the inspector.
    await page.getByTestId('diffbar-apply').click();

    await expect(page.getByTestId('diffbar')).toBeHidden();
    const landed = await page.evaluate(
      () => (window as unknown as DiffWin).__basher_dag.getState().state.nodes['p327_curve']?.type,
    );
    expect(landed, "the proposed curve's Object is in the DAG after clicking Apply").toBe('Object');
  });

  test('still reachable when the Inspector is COLLAPSED (the reserve tracks the live flags)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto('/');
    await page.evaluate(() => {
      const w = window as unknown as {
        __basher_chrome?: { getState(): { setInspectorCollapsed: (v: boolean) => void } };
      };
      w.__basher_chrome?.getState().setInspectorCollapsed(true);
    });
    await proposeCurve(page);

    // Folding the panel WIDENS the bar (it reclaims that band). Widening must
    // not push the actions back under the 28px chevron strip.
    expect(await reachableSamples(page, 'diffbar-apply')).toBe(9);
    expect(await reachableSamples(page, 'diffbar-reject')).toBe(9);
  });

  test('reachable in the NARROW layout too (the other branch of the reserve)', async ({ page }) => {
    // Below the breakpoint the side panels become off-canvas drawers that
    // OVERLAY rather than reserve, so the bar takes the full width minus the
    // edge gaps — a different branch of centerSurfaceWidthCss, and one nothing
    // else would have exercised.
    //
    // (An OPEN drawer sits at zIndex 40, above this bar. That is not this bug
    // returning: an open drawer is modal — it sits behind a dismissing scrim,
    // so nothing underneath it is clickable BY DESIGN, and drawers are closed
    // by default. The reachable state is the default state.)
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/');
    await proposeCurve(page);

    expect(await reachableSamples(page, 'diffbar-apply')).toBe(9);
    expect(await reachableSamples(page, 'diffbar-reject')).toBe(9);
  });

  test('the bar does not shove the viewport canvas when a diff arrives', async ({ page }) => {
    // It used to sit in the NORMAL FLOW of the view3d slot, so proposing a diff
    // pushed the canvas down by the bar's height — the ghost preview jumped at
    // the exact moment the director was asked to judge it.
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as unknown as Partial<DiffWin>).__basher_dag));
    const canvas = page.locator('[data-testid="view3d-slot"] canvas').first();
    await expect(canvas).toBeVisible();
    // R3F sizes the canvas from its 300x150 intrinsic default on a later frame.
    // Measuring before it settles compares the bar's effect against a stale
    // baseline and the test "passes"/"fails" on the race, not on the product.
    await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(500);
    const before = await canvas.boundingBox();

    await proposeCurve(page);
    const after = await canvas.boundingBox();

    expect(after!.y, 'canvas top must not move when the DiffBar appears').toBeCloseTo(before!.y, 0);
    expect(after!.height, 'canvas must not be squeezed by the DiffBar').toBeCloseTo(
      before!.height,
      0,
    );
  });
});
