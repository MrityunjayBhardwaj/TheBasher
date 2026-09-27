// #1275 — the view lock keeps a travelling native character framed.
//
// The character is Blender 5.1.1's default glTF export of `walk.bvh`
// (`public/fixtures/anim/walk-blender-default.glb`), which TRAVELS: its hips cover hundreds of units
// over the clip. (The spec beside this one drives a cube because no tracked character travelled when
// it was written.) It goes through the product's own ingest, so it lands native: an armature Object
// whose bones are drawn by the armature band and are never in the three.js scene.
//
// What is measured is what a director sees: the drawn bones, read off the band's own seam
// (`__basher_armature`), projected to normalised device coordinates. The camera is aimed across the
// direction of travel, so leaving the frame is a fact rather than an impression.
//
// THE CONTROL COMES FIRST: unlocked, the rig must leave its place on screen, or the locked arm
// below proves nothing. Measured before #1275 the lock refused this character outright
// ("nothing-to-follow") and the view stayed put.
//
// REF: src/viewport/followScan.ts (the rig read from the graph); src/app/viewLock.ts (the click);
//      issue #1275.

import { test, expect, settleViewFit, type Page } from './_fixtures';

interface Win {
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folder: string,
  ) => Promise<string>;
  __basher_armature?: { bones: number; matrices: number[][]; names: string[] };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; inputs: Record<string, unknown> }> };
    };
  };
  __basher_viewport: { getState: () => { viewLock: { nodeId: string } | null } };
  __basher_three: {
    getState: () => {
      camera: {
        position: { set: (x: number, y: number, z: number) => void };
        projectionMatrix: { elements: number[] };
        matrixWorldInverse: { elements: number[] };
      };
      controlsTarget: {
        x: number;
        y: number;
        z: number;
        set: (x: number, y: number, z: number) => void;
      };
    };
  };
}

/**
 * The drawn rig's centroid (world, from the band's bone matrices) and where it lands on screen.
 *
 * Without `Root`: the walk's transport root stays at the origin every frame, and the lock follows
 * the rig without it (`armatureBounds` leaves a parentless bone out, as a figure's size does). A
 * fixed point averaged in drags the centroid behind the figure.
 */
async function rigOnScreen(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as Win;
    const a = w.__basher_armature!;
    const m = a.matrices.filter((_, i) => a.names[i] !== 'Root');
    const c = [0, 0, 0];
    for (const e of m) for (let a = 0; a < 3; a++) c[a] += e[12 + a] / m.length;
    const t = w.__basher_three.getState();
    const mul = (p: number[], e: number[]) =>
      [0, 1, 2, 3].map((r) => e[r] * p[0] + e[4 + r] * p[1] + e[8 + r] * p[2] + e[12 + r]);
    const clip = mul(
      mul(c, t.camera.matrixWorldInverse.elements).slice(0, 3),
      t.camera.projectionMatrix.elements,
    );
    return {
      world: c,
      ndc: [clip[0] / clip[3], clip[1] / clip[3]],
      target: [t.controlsTarget.x, t.controlsTarget.y, t.controlsTarget.z],
    };
  });
}

async function seek(page: Page, seconds: number) {
  await page.evaluate(
    (s) => (window as unknown as Win).__basher_time.getState().setTime(s),
    seconds,
  );
  await page.waitForTimeout(500);
}

test('a view lock on a native character keeps it framed while it walks; without it the character leaves', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => Boolean((window as unknown as Win).__basher_ingestGltfFolder));
  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await (await fetch('/fixtures/anim/walk-blender-default.glb')).arrayBuffer(),
    );
    await (window as unknown as Win).__basher_ingestGltfFolder!(
      [{ relativePath: 'walk.glb', bytes }],
      'walk',
    );
  });
  await page.waitForFunction(
    () => ((window as unknown as Win).__basher_armature?.bones ?? 0) > 70,
    null,
    {
      timeout: 60_000,
    },
  );
  const armature = await page.evaluate(() => {
    const nodes = (window as unknown as Win).__basher_dag.getState().state.nodes;
    const ref = (v: unknown) => (v as { node?: string } | undefined)?.node ?? '';
    return Object.entries(nodes).find(
      ([, n]) => n.type === 'Object' && nodes[ref(n.inputs.data)]?.type === 'Skeleton',
    )?.[0];
  });
  expect(armature, 'the import stood no armature Object').toBeTruthy();
  // The import fits the view once; aiming before it settles is undone by it.
  await settleViewFit(page);

  // Where the walk goes: the drawn rig at the first key and near the end.
  await seek(page, 1 / 24);
  const start = (await rigOnScreen(page)).world;
  await seek(page, 4.5);
  const end = (await rigOnScreen(page)).world;
  const travel = Math.hypot(end[0] - start[0], end[2] - start[2]);
  expect(
    travel,
    'the fixture does not travel — nothing below could leave the frame',
  ).toBeGreaterThan(100);

  // Aim across the direction of travel, framing the rig where it starts.
  const aim = async () =>
    page.evaluate(
      ([s, e]) => {
        const t = (window as unknown as Win).__basher_three.getState();
        const dx = e[0] - s[0];
        const dz = e[2] - s[2];
        const len = Math.hypot(dx, dz);
        t.controlsTarget.set(s[0], s[1], s[2]);
        // Across the travel. What is asserted holds at any distance (the orbit once clamped this
        // to 38.1, the boot fit's reach, #1288).
        t.camera.position.set(s[0] - (dz / len) * 450, s[1], s[2] + (dx / len) * 450);
      },
      [start, end],
    );

  // THE CONTROL: unlocked, the character walks out of its place on screen.
  await seek(page, 1 / 24);
  await aim();
  await page.waitForTimeout(600);
  const freeStart = await rigOnScreen(page);
  await seek(page, 4.5);
  const freeEnd = await rigOnScreen(page);
  expect(
    Math.abs(freeEnd.ndc[0] - freeStart.ndc[0]),
    'the character stayed put on screen unlocked — this run proves nothing about following',
  ).toBeGreaterThan(0.5);

  // Locked through the View menu, on the armature Object.
  await seek(page, 1 / 24);
  await aim();
  await page.waitForTimeout(600);
  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    armature!,
  );
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-view-lock-to-selected').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Win).__basher_viewport.getState().viewLock?.nodeId),
    )
    .toBe(armature);
  await page.waitForTimeout(600);
  const lockedStart = await rigOnScreen(page);
  // What the lock claims: the view centre travels with the DRAWN rig. Held against the travel, since
  // the pivot is the rig's bounds centre and the bones here are averaged (measured: 593.4 against
  // 587.0 over 587 of travel, the gait between the two). And the rig stays on screen throughout.
  for (const s of [1.5, 3, 4.5]) {
    await seek(page, s);
    const now = await rigOnScreen(page);
    const rigMoved = [0, 1, 2].map((a) => now.world[a] - lockedStart.world[a]);
    const pivotMoved = [0, 1, 2].map((a) => now.target[a] - lockedStart.target[a]);
    const gap = Math.hypot(...rigMoved.map((v, a) => v - pivotMoved[a]));
    expect(gap, `the view centre fell behind the rig at ${s}s`).toBeLessThan(0.05 * travel);
    expect(Math.abs(now.ndc[0]), `off screen at ${s}s`).toBeLessThan(1);
    expect(Math.abs(now.ndc[1]), `off screen at ${s}s`).toBeLessThan(1);
  }
  const lockedEnd = await rigOnScreen(page);
  expect(
    Math.hypot(
      lockedEnd.target[0] - lockedStart.target[0],
      lockedEnd.target[2] - lockedStart.target[2],
    ),
    'the view centre did not travel — the lock is inert',
  ).toBeGreaterThan(travel * 0.8);
});
