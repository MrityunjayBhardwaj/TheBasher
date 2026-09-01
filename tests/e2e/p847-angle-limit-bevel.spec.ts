// #847 — A BEVEL CHOOSES ITS EDGES BY DIHEDRAL ANGLE, IN THE RUNNING APP.
//
// ── WHAT ONLY THIS ROAD CAN SEE ────────────────────────────────────────────────────────
//
// The unit gates already pin which edges an angle limit selects, the reference's epsilon, and
// the empty case. Three claims are invisible to all of them:
//
// 1. **A DIRECTOR CAN ACTUALLY REACH THIS.** Every scoped operator before it is driven in e2e
//    through `setParam`, because `scope` is a string and a string param has no generic
//    inspector row — that is #667's gap, true of all six of them. `limitMethod` and
//    `angleLimit` are an enum and a number, so they get the generic rows for free, and this is
//    the FIRST selection an author can name without touching the DAG. The rows below drive the
//    real dropdown and the real numeric input.
//
//    ⚠️ AND THE CONTROLS ONLY EXIST WHILE THE MODIFIER ROW IS EXPANDED. Measured, after an
//    enumeration over the collapsed panel came back with no matching testid at all and read
//    as "the controls were never built". A row-level expand is part of the setup, not a
//    detail — the same absent-versus-wrong-question trap the inspector observation already hit
//    once on this issue, one level up.
//
// 2. **🔴 THE CLIFF DOES NOT KILL THE APP (#862).** `angleLimit` is a number in `[0, 180]` with
//    a SCRUB HANDLE, and on a cube — every edge at 90° — nothing qualifies from 90 upward. So
//    half the control's own range is a state where the bevel chamfers nothing, and a drag
//    sweeps through it continuously rather than landing in it deliberately. That state used to
//    be a named refusal, which meant a THROW, and `evaluate` runs on the render walk with no
//    `try` above it and this project has no node-error surface — so the app unmounted and only
//    a page reload brought it back. `bevelNodeReach.gate.test.ts` now pins the node's arm on
//    the selection axis; only this file proves the RENDER survives the drag.
//
// 3. **IT COMES BACK.** A passthrough that stuck would satisfy claim 2 and be useless. The
//    author must be able to scrub past the cliff and return to a beveled mesh.
//
// ── THE NUMBERS ARE PREDICTED, AND TWO OF THEM ARE THE REFERENCE'S ────────────────────
//
// A unit cube is `F=6, E=12, V=8`, and every edge is a right angle. So:
//
//   - at any limit BELOW 90 the angle selects all twelve edges, which is the all-edges bevel
//     `F + E + V = 26` faces over `{3:8, 4:18}` arities and one renderer position per output
//     face-corner: `8 x 3 + 18 x 4 = 96`. The same 96 the unscoped bevel produces, reached by
//     a different road — the angle names the set the blank scope leaves unnamed.
//   - at 90 and above it selects none, the node passes its source through, and what mounts is
//     the CUBE ITSELF: 24, one position per face-corner of six quads.
//
// 🔴 90 IS THE INTERESTING VALUE AND NOT AN ARBITRARY ONE. It is the angle a cube visibly has,
// so it is what an author types; and `edgeAnglesOf` answers through a `Float32Array`, which
// reports that right angle as 90.0000025°. Without the reference's epsilon
// (`MOD_bevel.cc:129`) a limit of 90 would select ALL TWELVE instead of none — the full
// inversion on the most guessable input. The row at 90 is therefore two claims at once: the
// epsilon holds on the render road, and the empty result it produces is survivable.
//
// REF: src/nodes/BevelModifier.ts (both passthrough arms); src/app/edgeAngleSelection.ts;
//      src/nodes/componentSelection.ts (the empty selection's spelling);
//      src/app/bevelNodeReach.gate.test.ts (the same claim at the unit tier);
//      ref/sources/blender-mesh/MOD_bevel.cc:129, :193-203; issues #847, #862, #800, #667.

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

const CUBE = 'p847_cube';
const CUBE_DATA = 'p847_cube_data';

/** A unit cube's own vertex count in three.js — 4 per quad face, six faces. */
const CUBE_VERTS = 24;

/**
 * The all-edges bevel: `F + E + V = 26` output faces over `{3:8, 4:18}` arities, one renderer
 * position per output face-corner. Written as the sum so it can be checked rather than trusted.
 */
const ALL_EDGES_VERTS = 8 * 3 + 18 * 4;

/** Vertex count of the meshes under the scene child named `nodeId`. `-1` when it has not
 *  mounted, which must never read as a clean zero. */
function vertsUnder(page: import('@playwright/test').Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene;
    let root: unknown = null;
    scene?.traverse((o) => {
      if ((o as { name?: string }).name === id && !root) root = o;
    });
    if (!root) return -1;
    let total = 0;
    (root as { traverse: (cb: (o: unknown) => void) => void }).traverse((o) => {
      const m = o as {
        type: string;
        geometry?: { attributes?: { position?: { count: number } } };
      };
      if (m.type === 'Mesh' && m.geometry?.attributes?.position)
        total += m.geometry.attributes.position.count;
    });
    return total;
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
  // A split cube — an `Object` (the pose + the modifier stack) over a `BoxData` (the geometry
  // the stack reshapes). Exactly what Add ▸ Mesh ▸ Cube builds.
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
        'p847 base split cube',
      );
    },
    { cube: CUBE, data: CUBE_DATA },
  );
  await page.evaluate(
    (cube) => (window as unknown as UiWindow).__basher_selection.getState().select(cube),
    CUBE,
  );
  await openInspectorSection(page, 'modifier');
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(CUBE_VERTS);
});

/**
 * Adds the bevel through the panel, EXPANDS its row so the param controls mount, and returns
 * the minted modifier's node id. The expand is load-bearing — see the header.
 */
async function addExpandedBevel(page: import('@playwright/test').Page): Promise<string> {
  const stack = page.getByTestId('modifier-stack');
  await page.getByTestId('modifier-add-BevelModifier').click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  const row = stack.locator('[data-testid^="modifier-row-"]').first();
  const modifierId = (await row.getAttribute('data-testid'))!.replace('modifier-row-', '');
  await row.click();
  // Assert the controls mounted rather than assuming the click landed — an absent testid and a
  // collapsed row are the same `false`, which is exactly the confusion this expand exists for.
  await expect(page.getByTestId(`inspector-enum-${modifierId}-limitMethod`)).toBeVisible();
  return modifierId;
}

test('#847 — an author names the chamfered edges by ANGLE, through the real controls', async ({
  page,
}) => {
  const modifierId = await addExpandedBevel(page);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(ALL_EDGES_VERTS);

  // 🔑 THE CLAIM #667's SIX SCOPED OPERATORS CANNOT MAKE. Both controls are real, reachable
  // rows in the panel — the enum dropdown and the numeric input — so this selection is the
  // first one a director can author without touching the DAG.
  const limitMethod = page.getByTestId(`inspector-enum-${modifierId}-limitMethod`);
  const angleLimit = page.getByTestId(`inspector-input-${modifierId}-angleLimit`);
  await expect(angleLimit).toBeVisible();
  // The reference's own default, arriving through the schema rather than typed by this spec.
  await expect(angleLimit).toHaveValue('30');

  // Switching the producer through the dropdown. A cube is 90° everywhere, so a 30° limit
  // names all twelve edges — the same mesh the unscoped bevel builds, reached by naming the
  // set rather than by leaving it unnamed.
  await limitMethod.selectOption('angle');
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(ALL_EDGES_VERTS);

  // And the limit really is being READ: just under the cube's own angle still takes all twelve.
  await angleLimit.fill('89.9');
  await angleLimit.blur();
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(ALL_EDGES_VERTS);
});

test('#862 — scrubbing past the cube’s own angle leaves a plain cube, not a dead app', async ({
  page,
}) => {
  // 🔴 THE ROW THIS FILE EXISTS FOR. Every value from 90 up selects nothing on a cube, which is
  // half of `angleLimit`'s own range, reachable by one drag of a scrub handle. It used to
  // throw on the render walk and unmount the application.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const modifierId = await addExpandedBevel(page);
  const limitMethod = page.getByTestId(`inspector-enum-${modifierId}-limitMethod`);
  const angleLimit = page.getByTestId(`inspector-input-${modifierId}-angleLimit`);
  await limitMethod.selectOption('angle');
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(ALL_EDGES_VERTS);

  // 90 FIRST, because it is the value an author types — the angle the cube visibly has — and
  // because the reference's epsilon is what decides it selects none rather than all twelve.
  for (const limit of ['90', '90.1', '120', '180']) {
    await angleLimit.fill(limit);
    await angleLimit.blur();
    // The SOURCE comes through untouched: a plain cube, not an empty object and not a crash.
    await expect
      .poll(() => vertsUnder(page, CUBE), { message: `angleLimit ${limit}` })
      .toBe(CUBE_VERTS);
    expect(errors, `angleLimit ${limit} must not throw on the render walk`).toEqual([]);
    await expect(page.getByTestId('layout')).toBeVisible();
  }

  // 🔑 AND IT COMES BACK. A passthrough that stuck would pass every row above and be useless:
  // the author has to be able to scrub back down and get the chamfer again.
  await angleLimit.fill('30');
  await angleLimit.blur();
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(ALL_EDGES_VERTS);
  expect(errors).toEqual([]);
});
