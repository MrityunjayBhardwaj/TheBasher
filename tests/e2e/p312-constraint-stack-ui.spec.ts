// #312 — the Constraints-stack inspector UI (the CHOP twin of p209-modifier-stack-ui).
// Observes on the LIVE app that the Constraints section appears on the constrained
// OBJECT (not only on a TrackTo node), and that every row action drives what actually
// RENDERS: add → the aim takes; a 2nd add lands on TOP and wins the band; ▲ reorder
// hands the band to the promoted member; mute leaves the row LISTED (so it can be
// re-enabled) while the member below takes over; remove empties the stack.
//
// The rows must describe the fold — that is the invariant this guards.
//
// REF: src/app/ConstraintStackControls.tsx; src/app/constraintStack.ts;
//      src/app/OperatorStackRows.tsx (shared with the modifier stack);
//      src/app/nodeConstraints.ts (the fold); docs/RELATIONAL-OPERATORS-DESIGN.md §8.

import { expect, test } from './_fixtures';

interface UiWindow {
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_dag: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_mesh_world_quaternion?: (nodeId: string) => [number, number, number, number] | null;
}

/** -Z aim axis of the box, normalized. */
async function aimDir(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as UiWindow;
    const q = w.__basher_mesh_world_quaternion?.('n_box');
    if (!q) return null;
    const [x, y, z, ww] = q;
    const v: [number, number, number] = [
      -(2 * (x * z + ww * y)),
      -(2 * (y * z - ww * x)),
      -(1 - 2 * (x * x + y * y)),
    ];
    const l = Math.hypot(...v) || 1;
    // `+0` normalizes -0 → 0 (toEqual distinguishes them).
    return v.map((n) => +(n / l).toFixed(2) + 0 || 0) as [number, number, number];
  });
}

test('the Constraints panel drives the stack: add / reorder / mute / remove', async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as unknown as UiWindow).__basher_selection));

  // Two aim targets: +X and -Z. WIRED into the scene — a Track-To reads the aim node's
  // WORLD transform, which only resolves for a node that is actually in the scene graph.
  // Box forced to the origin so the aim direction is just the target's direction.
  await page.evaluate(() => {
    const w = window as unknown as UiWindow;
    const d = (op: unknown) => w.__basher_dag.getState().dispatch(op);
    d({ type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [0, 0, 0] });
    for (const [id, pos] of [
      ['n_aimX', [10, 0, 0]],
      ['n_aimZ', [0, 0, -10]],
    ] as const) {
      d({ type: 'addNode', nodeId: id, nodeType: 'Null', params: { position: pos } });
      d({
        type: 'connect',
        from: { node: id, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      });
    }
  });

  // Select the BOX — the constrained OBJECT — and open its Constraints section.
  await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_selection.getState().select('n_box'),
  );
  await page.getByTestId('inspector-section-toggle-constraint').click();
  const stack = page.getByTestId('constraint-stack');
  await expect(stack).toBeVisible();
  console.log('[panel] Constraints section is present on the BOX (not just on a TrackTo)');
  await expect(stack).toContainText('No constraints.');

  // --- ADD #1, aim at +X.
  await page.getByTestId('constraint-add-TrackTo').click();
  const rows = stack.locator('[data-testid^="constraint-row-"]');
  await expect(rows).toHaveCount(1);
  const id1 = (await rows.first().getAttribute('data-testid'))!.replace('constraint-row-', '');
  await page.evaluate(
    (id) =>
      (window as unknown as UiWindow).__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId: id, paramPath: 'aimNode', value: 'n_aimX' }),
    id1,
  );
  await expect.poll(() => aimDir(page)).toEqual([1, 0, 0]);
  console.log('[add #1]  rows=1  rendered aim=[1,0,0]  (+X)');

  // --- ADD #2, aim at -Z. Lands on TOP → wins the band.
  await page.getByTestId('constraint-add-TrackTo').click();
  await expect(rows).toHaveCount(2);
  const id2 = (await rows.nth(1).getAttribute('data-testid'))!.replace('constraint-row-', '');
  await page.evaluate(
    (id) =>
      (window as unknown as UiWindow).__basher_dag
        .getState()
        .dispatch({ type: 'setParam', nodeId: id, paramPath: 'aimNode', value: 'n_aimZ' }),
    id2,
  );
  await expect.poll(() => aimDir(page)).toEqual([0, 0, -1]);
  console.log('[add #2]  rows=2  rendered aim=[0,0,-1] (-Z, the TOP member wins)');

  // --- REORDER: move the +X one UP → it becomes top → it wins.
  await page.getByTestId(`constraint-up-${id1}`).click();
  await expect.poll(() => aimDir(page)).toEqual([1, 0, 0]);
  console.log('[reorder ▲] rendered aim=[1,0,0]  (+X moved to top and took the band)');

  // --- MUTE the now-top +X one → the -Z one below takes over.
  await page.getByTestId(`constraint-mute-${id1}`).click();
  await expect(page.getByTestId(`constraint-mute-${id1}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(2); // the muted row is STILL shown (so it can be re-enabled)
  await expect.poll(() => aimDir(page)).toEqual([0, 0, -1]);
  console.log('[mute ●→◌] rows=2 (muted row still listed)  rendered aim=[0,0,-1] (fell through)');

  // --- REMOVE both.
  await page.getByTestId(`constraint-remove-${id1}`).click();
  await expect(rows).toHaveCount(1);
  await page.getByTestId(`constraint-remove-${id2}`).click();
  await expect(rows).toHaveCount(0);
  await expect(stack).toContainText('No constraints.');
  console.log('[remove ✕] rows=0  ("No constraints.")');
});
