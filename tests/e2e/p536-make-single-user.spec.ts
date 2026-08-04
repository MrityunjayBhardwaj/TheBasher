// #536 S5 — the artist half: an authored share is BREAKABLE from the users row.
//
// The count on the material data-block row states a fact — "three objects would move if
// you edited this". Until now that was all it did. Blender puts the escape hatch on the
// number itself: clicking it gives THIS object its own copy and leaves the rest linked.
// This spec is that click's only witness.
//
// ── WHY THE OBVIOUS ASSERTION IS THE WRONG ONE, MEASURED ────────────────────────────
//
// 🔴 The tempting gate is "the copy now holds a DIFFERENT `THREE.Material` instance".
// That gate would pass the broken build and fail the correct one. Render identity is
// minted from a content walk (`src/nodes/materialKey.ts`), so a value-preserving copy is
// content-identical to its source and correctly resolves to the SAME shared instance —
// measured live, uuid unchanged on all three cubes before and after the split. Derived
// sharing is dedup and must stay invisible; only the AUTHORED share is being broken here.
//
// The honest discriminator is a PERTURBATION: edit the original material once, and see
// who moves. A copy that stayed linked follows; a copy that genuinely broke away does
// not. The two objects that were left linked are the presence control in the same
// observation — without them "the copy did not move" is indistinguishable from "nothing
// moved because the edit never landed".
//
// ── THE SECOND CASE IS AN ABSENCE, SO IT CARRIES ITS OWN CONTROLS ───────────────────
//
// At one user the number is plain text: a make-single-user that produces another
// single-user copy is a no-op dressed as an act. Asserting "not a button" needs two
// controls or it passes on a row that failed to render at all — a sibling button that IS
// present, and the same number turning into a button under one perturbation (link a
// second object).
//
// ⚠️ The row lives under the OBJECT node, not the data node. Selecting the data node and
// opening the material section shows a section without this row, which reads as "the
// affordance does not exist".
//
// REF: src/app/MaterialLinkControls.tsx (the row), src/app/materialLink.ts
//      (`buildNewMaterialOps` — the one builder both roads dispatch),
//      docs/RENDER-RESOURCE-IDENTITY-DESIGN.md §S5, issue #536.

import { expect, test } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface UiWindow {
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_mesh_material?: (id: string) => { roughness: number; color: string } | null;
}

const MAT = 'p536s5_mat';
const DATA = ['p536s5_d1', 'p536s5_d2', 'p536s5_d3'];
const CUBE = ['p536s5_c1', 'p536s5_c2', 'p536s5_c3'];

const MAT_COLOR = '#2244ff'; // the shared material's colour
const MAT_ROUGH = 0.72; // …and a second channel, so "value-preserving" is not one number
const EDITED = '#00ff44'; // the perturbation — distinct from every authored colour below
// Three DIFFERENT colours authored underneath: drawing MAT_COLOR is then a fact about the
// link rather than about the cube.
const OWN_COLORS = ['#ff0000', '#00ff00', '#0000ff'];

function rendered(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((n) => (window as unknown as UiWindow).__basher_mesh_material!(n), id);
}

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
  await page.waitForFunction(() => {
    const w = window as unknown as UiWindow;
    return Boolean(
      w.__basher_selection &&
      w.__basher_mesh_material &&
      w.__basher_dag &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
}

function cubeOps(data: string, cube: string, x: number, color: string): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: data,
      nodeType: 'BoxData',
      params: { size: [1, 1, 1], material: { name: 'own', base: { color } } },
    },
    { type: 'addNode', nodeId: cube, nodeType: 'Object', params: { position: [x, 0, 0] } },
    { type: 'connect', from: { node: data, socket: 'out' }, to: { node: cube, socket: 'data' } },
  ];
}

/** Seed `count` cubes, all linked to one Material node. */
async function seedShare(page: import('@playwright/test').Page, count: number) {
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      const ops: Op[] = [
        {
          type: 'addNode',
          nodeId: a.mat,
          nodeType: 'Material',
          params: {
            material: {
              name: 'shared',
              base: { color: a.color },
              specular: { roughness: a.rough },
            },
          },
        },
      ];
      for (let i = 0; i < a.count; i++) {
        ops.push(...(a.cubes[i] as Op[]));
        ops.push({
          type: 'connect',
          from: { node: a.cubeIds[i], socket: 'out' },
          to: { node: scene, socket: 'children' },
        });
        ops.push({
          type: 'connect',
          from: { node: a.mat, socket: 'out' },
          to: { node: a.dataIds[i], socket: 'material' },
        });
      }
      dag.dispatchAtomic(ops, 'e2e', '#536 S5 fixture');
    },
    {
      mat: MAT,
      color: MAT_COLOR,
      rough: MAT_ROUGH,
      count,
      cubeIds: CUBE,
      dataIds: DATA,
      cubes: DATA.map((d, i) => cubeOps(d, CUBE[i], -3 + i * 3, OWN_COLORS[i]) as unknown),
    },
  );
}

async function inspect(page: import('@playwright/test').Page, objectNodeId: string) {
  await page.evaluate(
    (c) => (window as unknown as UiWindow).__basher_selection.getState().select(c),
    objectNodeId,
  );
  await openInspectorSection(page, 'material');
}

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('#536 S5 — clicking the users count breaks THIS object out of a three-way share', async ({
  page,
}) => {
  await seedShare(page, 3);
  await inspect(page, CUBE[0]);

  // ── PRECONDITION: the share is real, and the surface says so ───────────────────────
  const users = page.getByTestId('material-link-users');
  await expect(users).toHaveText('3');
  for (const c of CUBE) expect((await rendered(page, c))!.color).toBe(MAT_COLOR);

  // ── THE AFFORDANCE ────────────────────────────────────────────────────────────────
  // The number is the button, in Blender's position. `toHaveRole` rather than a tag check:
  // what matters is that a keyboard or an agent can reach it as an action.
  await expect(users).toHaveRole('button');
  await users.click();

  // ── THE SHARE SPLIT: 1 here, 2 left behind ────────────────────────────────────────
  await expect(page.getByTestId('material-link-users')).toHaveText('1');
  await inspect(page, CUBE[1]);
  await expect(page.getByTestId('material-link-users')).toHaveText('2');

  // ── VALUE-PRESERVING: the copy carries what was on screen, on both channels ────────
  expect((await rendered(page, CUBE[0]))!.color).toBe(MAT_COLOR);
  expect((await rendered(page, CUBE[0]))!.roughness).toBeCloseTo(MAT_ROUGH, 5);

  // ── THE DISCRIMINATOR — edit the ORIGINAL and see who moves ───────────────────────
  // NOT a material-instance comparison: the copy is content-identical and correctly still
  // resolves to the same shared instance (see the header). Only this perturbation
  // separates "broke away" from "still linked".
  await inspect(page, MAT);
  const hex = page.getByTestId(`inspector-colorhex-${MAT}-material.base.color`);
  await hex.fill(EDITED);
  await hex.press('Enter');

  // The two that stayed linked MOVED — the presence control for the assertion below.
  await expect.poll(async () => (await rendered(page, CUBE[1]))!.color).toBe(EDITED);
  expect((await rendered(page, CUBE[2]))!.color).toBe(EDITED);
  // …and the one that broke away did not.
  expect((await rendered(page, CUBE[0]))!.color).toBe(MAT_COLOR);
});

test('#536 S5 — at one user the count is plain text, and becomes the affordance at two', async ({
  page,
}) => {
  await seedShare(page, 1);
  await inspect(page, CUBE[0]);

  const users = page.getByTestId('material-link-users');
  await expect(users).toHaveText('1');
  // A make-single-user on a single user is a no-op wearing an affordance's clothes.
  await expect(users).not.toHaveRole('button');
  // CONTROL 1 — the row rendered and its other actions are live, so "not a button" is a
  // statement about this element rather than about a missing panel.
  await expect(page.getByTestId('material-link-new')).toBeEnabled();

  // CONTROL 2 — one perturbation, and the same number becomes the button. Without this
  // the case would still pass on a row that never learned to offer the act at all.
  await page.evaluate(
    (a) => {
      const w = window as unknown as UiWindow;
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(a.ops as Op[]),
          {
            type: 'connect',
            from: { node: a.cube, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
          {
            type: 'connect',
            from: { node: a.mat, socket: 'out' },
            to: { node: a.data, socket: 'material' },
          },
        ],
        'e2e',
        '#536 S5 second user',
      );
    },
    {
      mat: MAT,
      cube: CUBE[1],
      data: DATA[1],
      ops: cubeOps(DATA[1], CUBE[1], 0, OWN_COLORS[1]) as unknown,
    },
  );

  await expect(users).toHaveText('2');
  await expect(users).toHaveRole('button');
});
