// #342 — a path-following object must box-select where it RENDERS, not where it was authored.
//
// BoxSelectController's own header states the invariant (V71): "a box-select hits an object
// exactly where it RENDERS". A Follow-Path moves an object's ORIGIN, and `resolveWorldTransform`
// is pure TRS — it deliberately applies no constraint band (that purity is what the band's own
// inputs read). So the marquee tested the AUTHORED origin while the renderer drew the object on
// the path: a box drawn around the object visibly failed to catch it, and a box drawn around
// empty space where it used to be caught it. Both halves are pinned below.
//
// BOUNDARY PAIR — this is why the bug is invisible to `boxSelect.ts` unit tests. The hit
// GEOMETRY was never wrong; the wrong world point was fed IN. Side A = where the renderer
// actually put the body (`__basher_mesh_world_position`, walked off the live three.js graph).
// Side B = the marquee's own projection + hit test (`__basher_box_select_project` /
// `__basher_box_select`, the REAL live camera). A unit test with an injected projector agrees
// with itself on either input, so only driving both sides of the seam separates them.
//
// Falsifiability probe (run before shipping): revert the candidate loop to `wt.position` ⇒ the
// two followed cases go red and the static control stays green.

import { expect, test } from './_fixtures';
import { splitCurveOps } from './_splitCurve';

type V3 = [number, number, number];

interface UiWindow {
  __basher_dag: {
    getState(): { dispatchAtomic: (ops: unknown[], src: string, d: string) => void };
  };
  __basher_selection: {
    getState(): { selectedNodeIds: ReadonlySet<string>; select: (id: string | null) => void };
  };
  __basher_box_select: (x0: number, y0: number, x1: number, y1: number, additive?: boolean) => void;
  __basher_box_select_project: (w: V3) => { x: number; y: number; visible: boolean };
  __basher_mesh_world_position: (nodeId: string) => V3 | null;
}

/** n_box's authored origin in the default scene — where the pure TRS walk still puts it. */
const AUTHORED: V3 = [0, 0, 0];
/** Half-size of the marquee drawn around a projected point, in canvas px. */
const PAD = 18;

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
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as UiWindow).__basher_box_select &&
      (window as unknown as UiWindow).__basher_mesh_world_position,
    ),
  );
}

/** Put n_box on a curve that is offset + rotated + NON-UNIFORMLY scaled, so the followed world
 *  point can only be right if the whole world compose is right (the V100 pair). */
async function followPosedPath(page: import('@playwright/test').Page) {
  const curveOps = splitCurveOps({
    objectId: 'n_path',
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [11, 0, 0],
      [12, 0, 0],
    ],
    closed: false,
    resolution: 32,
    position: [1, 2, -3],
    rotation: [0, 35, 0],
    scale: [2, 1, 0.5],
  });
  await page.evaluate((curveOps) => {
    (window as unknown as UiWindow).__basher_dag.getState().dispatchAtomic(
      [
        ...curveOps,
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
      ],
      'user',
      'follow a posed path',
    );
  }, curveOps);
  await page.waitForTimeout(400);
}

/** Draw a marquee around a WORLD point's live-camera projection; return the resulting set. */
async function boxAroundWorld(page: import('@playwright/test').Page, world: V3): Promise<string[]> {
  return page.evaluate(
    ({ world, pad }) => {
      const w = window as unknown as UiWindow;
      w.__basher_selection.getState().select(null);
      const p = w.__basher_box_select_project(world as V3);
      w.__basher_box_select(p.x - pad, p.y - pad, p.x + pad, p.y + pad);
      return [...w.__basher_selection.getState().selectedNodeIds];
    },
    { world, pad: PAD },
  );
}

async function screenOf(page: import('@playwright/test').Page, world: V3) {
  return page.evaluate(
    (w) => (window as unknown as UiWindow).__basher_box_select_project(w as V3),
    world,
  );
}

test.describe('#342 — box-select addresses a follower where it renders', () => {
  test('a box around the FOLLOWED object catches it', async ({ page }) => {
    await boot(page);
    await followPosedPath(page);

    const rendered = await page.evaluate(() =>
      (window as unknown as UiWindow).__basher_mesh_world_position('n_box'),
    );
    expect(rendered, 'the renderer must place the follower on the path').toBeTruthy();

    // Anti-vacuity: if the follow did nothing, "rendered" would BE the authored origin and both
    // assertions below would pass on the broken code. The gap is the whole bug.
    const onPath = await screenOf(page, rendered!);
    const atHome = await screenOf(page, AUTHORED);
    expect(
      Math.hypot(onPath.x - atHome.x, onPath.y - atHome.y),
      'the followed point and the authored origin must project far apart, or this proves nothing',
    ).toBeGreaterThan(4 * PAD);

    // THE FIX: the marquee is drawn where the director SEES the object.
    expect(await boxAroundWorld(page, rendered!)).toContain('n_box');
  });

  test('a box around the AUTHORED origin no longer catches the phantom', async ({ page }) => {
    await boot(page);
    await followPosedPath(page);

    // Pre-fix this selected n_box — the object was hit at a spot it visibly does not occupy.
    expect(await boxAroundWorld(page, AUTHORED)).not.toContain('n_box');
  });

  test('an unfollowed object is still boxed at its authored origin', async ({ page }) => {
    await boot(page);
    // The control: no Follow-Path anywhere. This is the case the fix must leave byte-identical,
    // and the half of the probe that must stay GREEN when the candidate loop is reverted.
    expect(await boxAroundWorld(page, AUTHORED)).toContain('n_box');
  });
});
