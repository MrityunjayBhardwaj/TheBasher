// #228 Slice B — Global/Local transform orientation (Blender orientation.rst).
// The toolbar chip toggles gizmoStore.orientation, which flows to three's
// TransformControls `space`. The visual handle re-orientation is verified by
// screenshot during development; this guards the WIRING: the chip reflects
// state, the toggle round-trips, and the gizmo stays mounted (no crash from the
// space prop) with a node selected. (Store toggle math is unit-tested in
// gizmoStore.test.ts.)

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: { getState: () => unknown };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_gizmo?: () => { position: number[] } | null;
}

test('the orientation chip toggles Global↔Local and the gizmo stays mounted', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      Boolean((window as unknown as W).__basher_dag && (window as unknown as W).__basher_selection),
    { timeout: 15000 },
  );
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().select('n_box'));
  await page.waitForTimeout(400);

  const chip = page.getByTestId('floating-toolbar-orientation');
  await expect(chip).toHaveText('global');

  await chip.click();
  await expect(chip).toHaveText('local');
  await page.waitForTimeout(300);
  // Gizmo proxy still present after the space flip (no crash).
  const seed = await page.evaluate(() => (window as unknown as W).__basher_gizmo?.() ?? null);
  expect(seed).not.toBeNull();

  await chip.click();
  await expect(chip).toHaveText('global');
});
