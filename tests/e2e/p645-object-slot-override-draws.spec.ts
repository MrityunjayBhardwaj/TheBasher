// #645 P5 — TWO OBJECTS OVER ONE MESH WEAR DIFFERENT MATERIALS ON SCREEN, AND STILL SHARE
// ONE `BufferGeometry`.
//
// ── WHY THIS SPEC EXISTS ──────────────────────────────────────────────────────────────
//
// Four places in the tree have promised since #638 that the material slot table is
// object-level, and that this is "what lets two objects share one mesh and still look
// different". #645 made it true: `ObjectValue.slotOverrides`, resolved through
// `objectSlotsOf` at one derivation site. Every proof of it so far is a unit row — the
// resolver's return value, the emitted params, the plan's ops. None of them is a pixel.
//
// The claim is about what the director SEES. Asserting it anywhere short of the screen
// leaves the last hop — resolved table → material array → draw — carried by inference, and
// that hop is exactly where this area has been wrong before.
//
// ── THE LOAD-BEARING CLAUSE IS A RELATION, NOT "IT DREW GREEN" ────────────────────────
//
// "The overridden object is green" is equally satisfied by an implementation that applies
// the override to EVERY object reading that data — which is the whole defect, since the
// mechanism's entire purpose is that the shared data is never written. So the clause that
// discriminates is that the OTHER object is still wearing the source material after the
// override lands:
//
//   grey BEFORE  — both objects wear the data's material
//   grey AFTER   — strictly less (one object left), but still well above the floor
//   green AFTER  — above the floor
//
// An override that reached both objects drives grey to the floor and passes every "did it
// draw green?" check. A floor under grey AFTER is what refuses it.
//
// ── AND THE ROW THE REFERENCE CANNOT MATCH ───────────────────────────────────────────
//
// `ref/GROUND_TRUTH_BLENDER_RENDER_RESOURCE_IDENTITY.md` §6 measured Blender re-pointing one
// object's slot: the diverging object LOSES its instance sharing. Ours does not, because the
// slot table is not part of the geometry key — only the attribute index is. That is a claim
// about a live cache, so it is read off the live registry here rather than argued from the
// key's definition.
//
// REF: ref/GROUND_TRUTH_BLENDER_RENDER_RESOURCE_IDENTITY.md §6;
//      src/app/materialAssignment.ts (`objectSlotsOf`);
//      src/agent/mutators/builders/setObjectSlotMaterial.ts (the authoring surface);
//      src/nodes/objectSlotTable.gate.test.ts (the fuse chain); issues #645, #638.

import { expect, test, type Page } from './_fixtures';
import type { Op } from '../../src/core/dag/types';

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }> };
      dispatchAtomic: (ops: Op[], label: string, desc: string) => void;
    };
  };
  __basher_three: { getState: () => { scene: unknown } };
  __basher_geometry_registry: { size: () => number };
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
}

/** The seed scene's data node, and the SECOND object this spec adds beside it. The seed's
 *  own object (`n_box`) is never named here — it is the control, and what matters about it
 *  is only that its pixels survive the override landing on its twin. */
const DATA = 'n_box_data';
const RIGHT = 'n_box_right';

/** Unmistakable against the seed cube's standard grey, which carries no green. */
const GREEN = '#00ff00';

/**
 * A floor every "greater than" clause sits on, so no relation here can be satisfied by
 * drawing nothing at all. Small enough that camera framing does not make it brittle, large
 * enough that stray antialiasing cannot reach it.
 */
const DRAWS_AT_ALL = 200;

async function dispatch(page: Page, ops: Op[], label: string): Promise<void> {
  await page.evaluate(
    ([o, l]) => {
      (window as unknown as W).__basher_dag.getState().dispatchAtomic(o, l, l);
    },
    [ops, label] as [Op[], string],
  );
}

/** A SECOND Object reading the SAME data node — the whole premise of the mechanism. */
async function addSecondObject(page: Page): Promise<void> {
  const sceneId = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().state.outputs.scene.node,
  );
  await dispatch(
    page,
    [
      {
        type: 'addNode',
        nodeId: RIGHT,
        nodeType: 'Object',
        params: { position: [2.2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      { type: 'connect', from: { node: DATA, socket: 'out' }, to: { node: RIGHT, socket: 'data' } },
      {
        type: 'connect',
        from: { node: RIGHT, socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      },
    ] as Op[],
    'second object',
  );
}

/** Count the override's green and the data material's grey in a REAL render. */
async function pixels(page: Page): Promise<{ green: number; grey: number } | null> {
  return page.evaluate(async () => {
    const out = await (window as unknown as W).__basher_render_png!();
    if (!out) return null;
    const img = new Image();
    await new Promise((r) => {
      img.onload = r;
      img.src = out.dataUrl;
    });
    const cv = document.createElement('canvas');
    cv.width = out.width;
    cv.height = out.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, out.width, out.height).data;
    let green = 0;
    let grey = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      // Green-dominant WITH A MARGIN, so the stage background cannot be counted as the
      // override.
      if (g > r + 30 && g > b + 30) green++;
      // The seed cube's standard grey (#cccccc): neutral, with a brightness floor the
      // background cannot reach.
      else if (r >= 48 && Math.abs(r - g) <= 12 && Math.abs(g - b) <= 12 && Math.abs(r - b) <= 12)
        grey++;
    }
    return { green, grey };
  });
}

async function registrySize(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as W).__basher_geometry_registry.size());
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_three &&
      w.__basher_geometry_registry &&
      w.__basher_three.getState().scene &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('an object-level slot override reaches the screen on ONE object, leaving its twin alone', async ({
  page,
}) => {
  await addSecondObject(page);

  // (a) BEFORE. Two objects, one data node, no override — both wear the data's material.
  await expect
    .poll(async () => (await pixels(page))?.grey ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(DRAWS_AT_ALL);
  const before = await pixels(page);
  expect(before).not.toBeNull();

  // (b) AFTER. The override lands on the RIGHT object only. Written the way the agent road
  // writes it, so this observes the shipped authoring path and not a private one.
  await dispatch(
    page,
    [
      {
        type: 'setParam',
        nodeId: RIGHT,
        paramPath: 'slotOverrides.0',
        value: { name: 'accent', base: { color: GREEN } },
      },
    ] as Op[],
    'slot override',
  );
  await expect
    .poll(async () => (await pixels(page))?.green ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(DRAWS_AT_ALL);
  const after = await pixels(page);
  expect(after).not.toBeNull();

  const seen =
    `before grey ${before!.grey}/green ${before!.green} — ` +
    `after grey ${after!.grey}/green ${after!.green}`;

  // The override drew at all, and it drew something that was not there before.
  expect(after!.green, seen).toBeGreaterThan(DRAWS_AT_ALL);
  expect(before!.green, seen).toBeLessThan(DRAWS_AT_ALL);

  // 🔴 THE DISCRIMINATING CLAUSE. The LEFT object is still wearing the data's material. An
  // override that reached the shared data — or that was composed onto every object reading
  // it — drives this to the floor while every "did it draw green?" check above still
  // passes. This is the only clause that refuses that implementation.
  expect(after!.grey, seen).toBeGreaterThan(DRAWS_AT_ALL);

  // And something genuinely moved: one of the two objects stopped being grey. Without this
  // the clause above is satisfied by an override that drew nothing on either object.
  expect(after!.grey, seen).toBeLessThan(before!.grey);
});

test('🔑 and the two objects still share ONE BufferGeometry — the row the reference cannot match', async ({
  page,
}) => {
  await addSecondObject(page);
  await expect
    .poll(async () => (await pixels(page))?.grey ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(DRAWS_AT_ALL);
  const before = await registrySize(page);

  await dispatch(
    page,
    [
      {
        type: 'setParam',
        nodeId: RIGHT,
        paramPath: 'slotOverrides.0',
        value: { name: 'accent', base: { color: GREEN } },
      },
    ] as Op[],
    'slot override',
  );
  await expect
    .poll(async () => (await pixels(page))?.green ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(DRAWS_AT_ALL);

  // Blender's re-point costs the diverging object its instance sharing (§6). Ours does not,
  // because the slot table is not part of the geometry key — only the attribute index is.
  // Read off the LIVE registry, because that is a claim about a cache and not about a
  // function's definition.
  expect(await registrySize(page), 'a diverging material must not mint a second geometry').toBe(
    before,
  );
});
