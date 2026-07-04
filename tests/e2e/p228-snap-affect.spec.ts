// #228 Slice A — Snapping ▸ Affect (Blender snapping.rst). The master snap
// toggle gates which transform modes snap; Move snaps by default, Rotate/Scale
// are opt-in via the toolbar Affect chips. Boundary-pair: drive the REAL toolbar
// UI (snap toggle + Affect▸Rotate chip) + the REAL gizmo rotate path
// (__basher_gizmo_grab → onObjectChange) and observe the dispatched param snap.
// The snap MATH is unit-tested in viewportStore.test.ts; this proves the wiring.

import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => { state: { nodes: Record<string, { params?: { rotation?: number[] } }> } };
  };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_gizmo_grab: (mode: string, target: [number, number, number]) => void;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      Boolean((window as unknown as W).__basher_dag && (window as unknown as W).__basher_selection),
    { timeout: 15000 },
  );
});

test('rotate snaps to the 5° increment only when Snap + Affect▸Rotate are on', async ({ page }) => {
  await page.evaluate(() => (window as unknown as W).__basher_selection.getState().select('n_box'));
  await page.waitForTimeout(300);

  // Baseline: snap OFF → rotate to 12° stays 12° (no snap).
  await page.evaluate(() => (window as unknown as W).__basher_gizmo_grab('rotate', [0, 12, 0]));
  await page.waitForTimeout(150);
  const unsnapped = await page.evaluate(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes['n_box']?.params?.rotation ??
      null,
  );
  expect(unsnapped).not.toBeNull();
  expect(unsnapped![1]).toBeCloseTo(12, 3);

  // Enable the master snap toggle, then the Rotate Affect chip (now visible).
  await page.getByTestId('floating-toolbar-snap-toggle').click();
  await page.getByTestId('floating-toolbar-snap-affect-rotate').click();
  await page.waitForTimeout(100);

  // Grab rotate to 12° → snaps to the nearest 5° multiple = 10°.
  await page.evaluate(() => (window as unknown as W).__basher_gizmo_grab('rotate', [0, 12, 0]));
  await page.waitForTimeout(150);
  const snapped = await page.evaluate(
    () =>
      (window as unknown as W).__basher_dag.getState().state.nodes['n_box']?.params?.rotation ??
      null,
  );
  expect(snapped).not.toBeNull();
  expect(snapped![1]).toBeCloseTo(10, 3);
});
