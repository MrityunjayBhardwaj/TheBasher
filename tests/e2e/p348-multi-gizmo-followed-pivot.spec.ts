// #348 — the multi-select gizmo pivot must median where the objects RENDER.
//
// The group gizmo seeds each node's world from `resolveWorldTransform` (pure TRS, applies no
// constraint band) and medians those origins into the pivot. So a path-following object
// contributed its AUTHORED origin and the pivot landed where nothing is — and because the
// pivot is what rotate/scale orbit, the damage is not confined to the follower: every OTHER
// object in the selection is thrown to the wrong place. That is what test 2 pins.
//
// Same class as #342 (box-select) and the same cure (V104): read the band ON TOP of the pure
// walk, never folded into it. Position only — the band writes no rotation/scale.
//
// Falsifiability probe: drop the `world.setPosition(followed)` line ⇒ tests 1 and 2 go red and
// the all-static control (test 3) stays green.

import { expect, test } from './_fixtures';

type V3 = [number, number, number];

interface UiWindow {
  __basher_dag: {
    getState(): { dispatchAtomic: (ops: unknown[], src: string, d: string) => void };
  };
  __basher_selection: { getState(): { selectMany: (ids: string[]) => void } };
  __basher_gizmo_multi: () => { count: number; pivot: V3; pivotMode: string } | null;
  __basher_gizmo_grab: (mode: 'translate' | 'rotate' | 'scale', target: V3) => void;
  __basher_mesh_world_position: (nodeId: string) => V3 | null;
}

const STATIC_BOX: V3 = [2, 0, 0];

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('canvas');
  // NOT __basher_gizmo_multi — that seam only exists once the MULTI gizmo mounts, which
  // needs a multi-selection. `scene()` waits for it after selectMany.
  await page.waitForFunction(() =>
    Boolean((window as unknown as UiWindow).__basher_mesh_world_position),
  );
}

/** Add a static second box. With `follow`, also put n_box on an offset+rotated+scaled curve. */
async function scene(page: import('@playwright/test').Page, follow: boolean) {
  await page.evaluate(
    ({ follow, staticPos }) => {
      const ops: unknown[] = [
        {
          type: 'addNode',
          nodeId: 'n_box_b',
          nodeType: 'BoxMesh',
          params: { size: [1, 1, 1], position: staticPos, rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          type: 'connect',
          from: { node: 'n_box_b', socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        },
      ];
      if (follow) {
        ops.push(
          {
            type: 'addNode',
            nodeId: 'n_path',
            nodeType: 'Curve',
            params: {
              points: [
                [0, 0, 0],
                [8, 0, 0],
                [12, 0, 4],
              ],
              closed: false,
              resolution: 32,
              position: [1, 3, -2],
              rotation: [0, 25, 0],
              scale: [2, 1, 0.5],
            },
          },
          {
            type: 'connect',
            from: { node: 'n_path', socket: 'out' },
            to: { node: 'n_scene', socket: 'children' },
          },
          {
            type: 'addNode',
            nodeId: 'n_box_fp',
            nodeType: 'FollowPath',
            params: { target: 'n_box', curve: 'n_path', evalTime: 0.5, offset: 0, order: 0 },
          },
        );
      }
      (window as unknown as UiWindow).__basher_dag
        .getState()
        .dispatchAtomic(ops, 'user', 'p348 scene');
    },
    { follow, staticPos: STATIC_BOX },
  );
  await page.waitForTimeout(500);
  await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_selection.getState().selectMany(['n_box', 'n_box_b']),
  );
  // The multi gizmo mounts (and publishes its seams) only for a >1 selection.
  await page.waitForFunction(() => Boolean((window as unknown as UiWindow).__basher_gizmo_multi));
  await page.waitForTimeout(400);
}

const rendered = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((i) => (window as unknown as UiWindow).__basher_mesh_world_position(i), id);

const median = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

function closeTo(actual: V3, expected: V3) {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 2);
}

test.describe('#348 — the group gizmo pivots on rendered origins', () => {
  test('the pivot medians where the objects RENDER, not where they were authored', async ({
    page,
  }) => {
    await boot(page);
    await scene(page, true);

    const follower = (await rendered(page, 'n_box'))!;
    const statik = (await rendered(page, 'n_box_b'))!;
    const multi = await page.evaluate(() => (window as unknown as UiWindow).__basher_gizmo_multi());
    expect(multi?.count).toBe(2);
    expect(multi?.pivotMode).toBe('median');

    // Anti-vacuity: the follower must actually have left its authored origin, or a broken
    // pivot would coincide with the correct one and this would prove nothing.
    expect(Math.hypot(...follower), 'the follower must be off its authored origin').toBeGreaterThan(
      1,
    );

    closeTo(multi!.pivot, median(follower, statik));
  });

  test('rotating the pair swings the STATIC object about the true pivot', async ({ page }) => {
    // The damage the pivot does: it is what rotate/scale orbit, so a phantom pivot throws
    // every OTHER object in the selection. This is the half a pivot-only assertion misses.
    await boot(page);
    await scene(page, true);

    const follower = (await rendered(page, 'n_box'))!;
    const before = (await rendered(page, 'n_box_b'))!;
    const pivot = median(follower, before);

    await page.evaluate(() =>
      (window as unknown as UiWindow).__basher_gizmo_grab('rotate', [0, 90, 0]),
    );
    await page.waitForTimeout(400);

    // R_y(90) about the pivot: (x,z) → (z, -x), measured from the pivot.
    const dx = before[0] - pivot[0];
    const dz = before[2] - pivot[2];
    const expected: V3 = [pivot[0] + dz, before[1], pivot[2] - dx];

    closeTo((await rendered(page, 'n_box_b'))!, expected);
    // The follower stays on its path — the band owns its position, so the gizmo cannot
    // drag it off. Pinning current semantics: the group rotates AROUND it.
    closeTo((await rendered(page, 'n_box'))!, follower);
  });

  test('an all-static selection pivots exactly as before', async ({ page }) => {
    // The byte-identical control, and the half of the probe that must stay GREEN.
    await boot(page);
    await scene(page, false);
    const a = (await rendered(page, 'n_box'))!;
    const b = (await rendered(page, 'n_box_b'))!;
    const multi = await page.evaluate(() => (window as unknown as UiWindow).__basher_gizmo_multi());
    closeTo(multi!.pivot, median(a, b));
  });
});
