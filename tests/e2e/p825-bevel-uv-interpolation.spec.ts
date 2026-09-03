// #825 slice 2 — A BEVEL'S UVs SURVIVE, IN THE RUNNING APP.
//
// ── WHAT ONLY THIS ROAD CAN SEE ────────────────────────────────────────────────────────
//
// The unit gates pin the weights, the closed form and the lift. Two claims are invisible to
// every one of them:
//
// 1. **THE LAYER REACHES THE MOUNTED MESH.** The gates read the registry directly. This reads
//    `geometry.attributes.uv` off the object three.js actually put in the scene, which is the
//    only buffer a texture can ever sample. A build that produced a correct layer the render
//    road dropped would pass every unit row in this arc.
//
// 2. **AN AUTHOR REACHES IT BY ADDING A MODIFIER.** The bevel is added through the real panel
//    button, so the road under test is the one a director drives — not a descriptor this spec
//    constructed.
//
// 🔴 THE COUNT IS NOT THE CLAIM, AND THIS ARC HAS ALREADY PAID FOR FORGETTING THAT. #875 was
// filed, and closed invalid the same hour, because a helper counted `position.count` for a face
// SUBSET — the one quantity a subset does not move. So the rows below assert VALUES: a zeroed
// `uv` of the right length has the right count, draws, and is wrong.
//
// ── THE PREDICTION, FROM WHAT A CHAMFER IS ────────────────────────────────────────────
//
// A `BoxGeometry` face's uv is linear over `[-0.5, 0.5] -> [0, 1]`, and a unit cube chamfered
// by `a` moves every corner inward by `a` in both in-face directions (the 24-point closed form
// in `mintedBevel.gate.test.ts`). Every output corner is therefore a source corner inset by `a`
// — and since #880 it is interpolated in the face it was inset WITHIN, so both components are
// exactly `a` or `1 - a`. At `a = 0.25` the whole layer is drawn from `{0.25, 0.75}`, and
// NEITHER number is in the plain source set `{0, 1}`, so the row cannot pass on a pass-through.
//
// 🔴 THIS PREDICTED `{0, a, 1-a, 1}` UNTIL #880. The `0`/`1` were real, and they were the
// symptom: a whole edge quad interpolated in ONE of its two flanking faces projects the other
// face's two corners onto the chosen face's boundary, where the segment hatch pins them exactly.
// That is the reference's SEAM arm firing away from a seam. Given each corner its own face, no
// corner lies on that face's boundary and the hatch does not fire for an edge quad at all.
//
// REF: src/app/geometryRegistry.ts (`buildBevel` — where the uv is written);
//      src/app/polygonInterpolation.ts (the weights); src/app/bevelCornerInterpolation.gate.test.ts
//      (the same closed form at the unit tier); issues #825, #814.

import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface UiWindow {
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three: {
    getState: () => { scene: { traverse: (cb: (o: unknown) => void) => void } | null };
  };
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
}

const CUBE = 'p825_cube';
const CUBE_DATA = 'p825_cube_data';

/** The amount, chosen so the predicted inset `{0.25, 0.75}` is far from the source's `{0, 1}`. */
const AMOUNT = 0.25;

/** A unit cube's own render vertices — 4 per quad face, six faces. */
const CUBE_VERTS = 24;

/** The all-edges bevel: `F + E + V = 26` faces over `{3:8, 4:18}`, one vertex per face-corner. */
const BEVEL_VERTS = 8 * 3 + 18 * 4;

/**
 * The uv buffer of the meshes under the scene child named `nodeId`, as a flat array — or `null`
 * when the object has not mounted.
 *
 * 🔴 `null` AND `[]` ARE DIFFERENT ANSWERS AND THE CALLER MUST BE ABLE TO TELL THEM APART. An
 * unmounted object and a mounted object carrying no uv layer would otherwise both read as a
 * clean empty, which is the shape of every false green this arc has met.
 */
function uvsUnder(page: import('@playwright/test').Page, nodeId: string): Promise<number[] | null> {
  return page.evaluate((id) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene;
    let root: unknown = null;
    scene?.traverse((o) => {
      if ((o as { name?: string }).name === id && !root) root = o;
    });
    if (!root) return null;
    const out: number[] = [];
    let meshes = 0;
    (root as { traverse: (cb: (o: unknown) => void) => void }).traverse((o) => {
      const m = o as {
        type: string;
        geometry?: {
          attributes?: { uv?: { count: number; getX(i: number): number; getY(i: number): number } };
        };
      };
      if (m.type !== 'Mesh') return;
      meshes++;
      const uv = m.geometry?.attributes?.uv;
      if (!uv) return;
      for (let i = 0; i < uv.count; i++) out.push(uv.getX(i), uv.getY(i));
    });
    return meshes === 0 ? null : out;
  }, nodeId);
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
    const w = window as unknown as UiWindow;
    return Boolean(
      w.__basher_selection &&
      w.__basher_three &&
      w.__basher_dag &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
  // A split cube — an `Object` over a `BoxData`, exactly what Add ▸ Mesh ▸ Cube builds.
  await page.evaluate(
    ({ cube, data }) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          { type: 'addNode', nodeId: data, nodeType: 'BoxData', params: { size: [1, 1, 1] } },
          { type: 'addNode', nodeId: cube, nodeType: 'Object', params: { position: [4, 0, 0] } },
          {
            type: 'connect',
            from: { node: data, socket: 'out' },
            to: { node: cube, socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: cube, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'p825 base split cube',
      );
    },
    { cube: CUBE, data: CUBE_DATA },
  );
  await page.evaluate(
    (cube) => (window as unknown as UiWindow).__basher_selection.getState().select(cube),
    CUBE,
  );
  await openInspectorSection(page, 'modifier');
  await expect.poll(() => uvsUnder(page, CUBE).then((uv) => uv?.length ?? -1)).toBe(CUBE_VERTS * 2);
});

test('#825 — a bevelled mesh carries INTERPOLATED uvs on the object three.js mounted', async ({
  page,
}) => {
  // The control, first: the plain cube's uvs are the source set and nothing else.
  const before = (await uvsUnder(page, CUBE))!;
  expect(new Set(before.map((n) => Math.round(n * 1e6) / 1e6))).toEqual(new Set([0, 1]));

  // Added through the real panel button — the road a director drives.
  const stack = page.getByTestId('modifier-stack');
  await page.getByTestId('modifier-add-BevelModifier').click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  const row = stack.locator('[data-testid^="modifier-row-"]').first();
  const modifierId = (await row.getAttribute('data-testid'))!.replace('modifier-row-', '');
  await row.click();
  // Assert the controls mounted rather than assuming the click landed — an absent testid and a
  // collapsed row are the same `false`.
  await expect(page.getByTestId(`inspector-input-${modifierId}-amount`)).toBeVisible();

  const amount = page.getByTestId(`inspector-input-${modifierId}-amount`);
  await amount.fill(String(AMOUNT));
  await amount.blur();
  await expect
    .poll(() => uvsUnder(page, CUBE).then((uv) => uv?.length ?? -1))
    .toBe(BEVEL_VERTS * 2);

  const after = (await uvsUnder(page, CUBE))!;

  // 1. THE LAYER IS THERE AND IT IS NOT ZEROS. P6's discriminating observation, as a count:
  //    an unwritten buffer is the origin everywhere.
  const atOrigin = after.filter((_, i) => i % 2 === 0 && after[i] === 0 && after[i + 1] === 0);
  expect(atOrigin.length).toBeLessThan(after.length / 4);

  // 2. EVERY VALUE IS FINITE. A NaN uv does not merely draw wrong — it can take the mesh off
  //    screen, and it is what an unnormalised weight set would produce.
  expect(after.every((n) => Number.isFinite(n))).toBe(true);

  // 3. 🔑 THE CLOSED FORM. Every output corner of a chamfered cube is a source corner pulled in
  //    by `a` along both of its in-face directions, and — since #880 — interpolated in the face
  //    it was pulled in WITHIN. A box face's uv is linear over `[-0.5, 0.5] -> [0, 1]`, so every
  //    component is exactly `a` or `1 - a` and the whole layer draws from that two-element set.
  //
  //    🔴 THIS ASSERTED `{0, a, 1-a, 1}` UNTIL #880, AND THIS ROW IS WHAT CAUGHT THE CHANGE.
  //    The `0` and `1` came from interpolating a whole edge quad in ONE of its two flanking
  //    faces: the two corners belonging to the other face were projected onto the chosen face's
  //    boundary, where the segment hatch pins them exactly. That is the reference's SEAM arm,
  //    produced away from any seam. Its non-seam arm gives each corner its own face and a null
  //    snap array (`bmesh_bevel.cc:7551`), so no corner lands on its own face's boundary.
  //
  //    Still discriminating, and against more than before: a pass-through of the source's uvs
  //    gives `{0, 1}` and reds this; a zeroed buffer gives `{0}` and reds it; a copy of any one
  //    corner per face gives a set with no `a` in it; and the pre-#880 face-wide map puts `0`
  //    and `1` back and reds it too. The set also TRACKS `a`, so it cannot be a constant.
  const values = new Set(after.map((n) => Math.round(n * 1e6) / 1e6));
  expect([...values].sort((x, y) => x - y)).toEqual([AMOUNT, 1 - AMOUNT]);
});
