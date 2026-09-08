// The view lock is still there after a reload (#985).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SPEC AND NOT A UNIT ROW
// ─────────────────────────────────────────────────────────────────────────
// `viewLockPersistence` round-trips a value, and that is not the claim. The
// claim is that a director who locks onto something, RELOADS, and carries on
// gets the same view — which runs through the boot sequence (project resumed,
// DAG hydrated, camera mounted), the effect that hydrates the store from
// localStorage, and the per-frame applier that clears a lock whose node has
// left the graph. Any one of those could restore the value and still leave the
// view unfollowing, and the store would look correct throughout.
//
// So the assertion is the one a director makes: after the reload, does the
// thing that moves stay in the same place ON SCREEN?
//
// ─────────────────────────────────────────────────────────────────────────
// WHY A CUBE, AND WHY THE SECOND HALF IS NOT A PREAMBLE
// ─────────────────────────────────────────────────────────────────────────
// The cube, for the reason `view-lock-follow.spec.ts` gives at length: the
// vendor character pair is untracked and the tracked walk fixture has root
// channels of zero on every frame, so it cannot exhibit travel. Persistence is
// the part that is identical for both.
//
// The RELEASED leg is load-bearing. "The lock is on after a reload" is also
// true of a lock that can never be turned off, and of a hydration that ignores
// what was stored — both would satisfy the first half of this spec completely.
// The second half is what makes the first half mean anything.
//
// REF: src/app/viewLockPersistence.ts (the store);
//      src/viewport/EditorViewCamera.tsx (hydrate + subscribe, and the applier);
//      tests/e2e/view-lock-follow.spec.ts (the sibling, within one session);
//      issue #985, and #856 which reported it.

import { test, expect } from './_fixtures';

interface Win {
  __basher_three: {
    getState: () => {
      camera: {
        projectionMatrix: { elements: number[] };
        matrixWorldInverse: { elements: number[] };
      };
      controlsTarget: { x: number; y: number; z: number };
    };
  };
  __basher_evaluated_transform?: (id: string) => { position: number[] } | null;
}

/** Where the cube's origin lands on screen, and where the orbit pivot is. */
async function read(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as Win;
    const t = w.__basher_three.getState();
    const pos = w.__basher_evaluated_transform?.('n_box')?.position ?? [0, 0, 0];
    const mul = (p: number[], e: number[]) =>
      [0, 1, 2, 3].map((r) => e[r] * p[0] + e[4 + r] * p[1] + e[8 + r] * p[2] + e[12 + r]);
    const view = mul(pos, t.camera.matrixWorldInverse.elements);
    const clip = mul(view.slice(0, 3), t.camera.projectionMatrix.elements);
    const wq = clip[3] === 0 ? 1 : clip[3];
    return {
      x: pos[0],
      ndc: [clip[0] / wq, clip[1] / wq] as [number, number],
      target: [t.controlsTarget.x, t.controlsTarget.y, t.controlsTarget.z] as [
        number,
        number,
        number,
      ],
    };
  });
}

async function moveCubeTo(page: import('@playwright/test').Page, x: number) {
  const field = page.getByTestId('inspector-vec-n_box-position-x');
  await field.fill(String(x));
  await field.press('Tab');
  await page.waitForTimeout(500);
}

/** Open the editor on the resumed project with the cube selected. */
async function settle(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('scene-tree-row-n_box').click();
  await expect(page.getByTestId('inspector-vec-n_box-position-x')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
}

/** The menu item's label, which carries the checkmark. Closed by re-clicking
 *  the menu and NEVER by Escape — Escape also clears the selection, which takes
 *  the inspector away and reads as the reload having failed. */
async function menuLabel(page: import('@playwright/test').Page) {
  await page.getByTestId('menu-view').click();
  const label = (await page.getByTestId('menu-view-lock-to-selected').textContent()) ?? '';
  await page.getByTestId('menu-view').click();
  await page.waitForTimeout(200);
  return label;
}

async function toggleLock(page: import('@playwright/test').Page) {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-view-lock-to-selected').click();
  await page.waitForTimeout(600);
}

test('the lock survives a reload, and a released one does not come back', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await settle(page);
  await moveCubeTo(page, 0);

  await toggleLock(page);
  expect(await menuLabel(page), 'the lock was never taken').toContain('✓');

  await page.reload();
  await settle(page);

  expect(
    await menuLabel(page),
    'the lock was forgotten on reload — the half of #856 this issue is about',
  ).toContain('✓');

  const start = await read(page);
  await moveCubeTo(page, 14);
  const end = await read(page);
  expect(end.x).toBeCloseTo(14, 3);
  expect(
    end.target[0] - start.target[0],
    'the checkmark came back but the view does not follow — the value was restored ' +
      'somewhere nothing reads it',
  ).toBeCloseTo(14 - start.x, 1);
  expect(Math.abs(end.ndc[0] - start.ndc[0])).toBeLessThan(0.05);
  expect(Math.abs(end.ndc[1] - start.ndc[1])).toBeLessThan(0.05);

  // ── THE LOSING ALTERNATIVE ──
  // Everything above is also true of a lock that cannot be turned off, and of a
  // hydration that ignores what was stored. Release it, reload, and the object
  // must leave frame exactly as it did before the feature existed.
  await moveCubeTo(page, 0);
  await toggleLock(page);
  await page.reload();
  await settle(page);

  expect(await menuLabel(page), 'a released lock came back after a reload').not.toContain('✓');

  const releasedStart = await read(page);
  await moveCubeTo(page, 14);
  const releasedEnd = await read(page);
  expect(
    Math.abs(releasedEnd.target[0] - releasedStart.target[0]),
    'the view followed a lock that had been released before the reload',
  ).toBeLessThan(0.01);
  expect(
    Math.abs(releasedEnd.ndc[0]),
    `the object stayed on screen (ndc x ${releasedEnd.ndc[0].toFixed(2)}), so this leg ` +
      'proves nothing about the lock being off',
  ).toBeGreaterThan(1);
});
