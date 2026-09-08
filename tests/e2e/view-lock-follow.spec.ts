// The view lock keeps a moving object framed (#856).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY A CONSUMER-LEVEL SPEC, WHEN THE POINT IS UNIT-TESTED
// ─────────────────────────────────────────────────────────────────────────
// The unit tier says WHICH point the lock follows. It cannot say the view
// actually goes there, because everything between the two is live: drei runs
// `controls.update()` at priority -1, so OrbitControls has already rewritten
// `position = target + offset` and `lookAt(target)` before the follow's own
// frame callback runs. A follow that moved the camera and not the pivot would
// pass every unit row and be silently undone on the next frame — which is
// exactly what the issue reports having tried.
//
// So the assertion is the one a director makes: after the thing moves, is it
// still in the same place ON SCREEN? Measured in normalised device coordinates,
// which is the only frame of reference in which "left the viewport" is a fact
// rather than an impression.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY A CUBE AND NOT A CHARACTER
// ─────────────────────────────────────────────────────────────────────────
// The defect was reported on a walking character, and the character road cannot
// be run here: the vendor pair is untracked (a ~58 MB GLB), and the TRACKED walk
// fixture has root channels of 0 on every frame — it walks in place, so it could
// not exhibit travel at all. Rather than write a spec that skips on every runner,
// this drives the same mechanism through the part that is identical for both:
// a scene object whose world position changes while the lock is on. What a rig
// adds — that the point comes from the BONES, because root travel never reaches
// the object a director selected — is where the unit rows are, and is observed
// on the real pair separately.
//
// REF: src/viewport/cameraFollow.ts (which point);
//      src/viewport/EditorViewCamera.tsx (the per-frame apply);
//      src/app/viewLock.ts (taking the lock);
//      issue #856.

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

test('the view lock keeps a moving object framed; without it the object leaves', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('scene-tree-row-n_box').click();
  await expect(page.getByTestId('inspector-vec-n_box-position-x')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(600);

  // THE CONTROL, and it is not a preamble: if the object does not leave frame
  // unlocked, the locked reading below is satisfied by a camera that never had
  // to do anything.
  const before = await read(page);
  await moveCubeTo(page, 14);
  const unlocked = await read(page);
  expect(unlocked.x).toBeCloseTo(14, 3);
  expect(
    Math.abs(unlocked.ndc[0]),
    `the object stayed on screen unlocked (ndc x ${unlocked.ndc[0].toFixed(2)}) — ` +
      'this run proves nothing about following',
  ).toBeGreaterThan(1);
  expect(
    Math.hypot(unlocked.target[0] - before.target[0], unlocked.target[2] - before.target[2]),
    'the pivot moved with nothing following it',
  ).toBeLessThan(0.01);

  // Now the lock, taken through the affordance rather than the store.
  await moveCubeTo(page, 0);
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-view-lock-to-selected').click();
  await page.waitForTimeout(600);
  const lockedStart = await read(page);

  await moveCubeTo(page, 14);
  const lockedEnd = await read(page);

  expect(lockedEnd.x).toBeCloseTo(14, 3);
  expect(
    lockedEnd.target[0] - lockedStart.target[0],
    'the view centre did not travel with the object — the lock is inert',
  ).toBeCloseTo(14 - lockedStart.x, 1);
  // The point of the whole feature: the object has not moved ON SCREEN.
  expect(Math.abs(lockedEnd.ndc[0] - lockedStart.ndc[0])).toBeLessThan(0.05);
  expect(Math.abs(lockedEnd.ndc[1] - lockedStart.ndc[1])).toBeLessThan(0.05);

  // Releasing is continuous — nothing on screen changes at the moment you stop
  // following. That is a deliberate divergence from Blender, whose lock never
  // writes the stored pivot and so snaps the view back on unlock.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-view-lock-to-selected').click();
  await page.waitForTimeout(400);
  const released = await read(page);
  expect(Math.abs(released.ndc[0] - lockedEnd.ndc[0])).toBeLessThan(0.05);
  expect(Math.abs(released.ndc[1] - lockedEnd.ndc[1])).toBeLessThan(0.05);

  // And it really is released: the object moves on and the view stays put.
  await moveCubeTo(page, 0);
  const after = await read(page);
  expect(
    Math.abs(after.target[0] - released.target[0]),
    'the view kept following after the lock was released',
  ).toBeLessThan(0.01);
});
