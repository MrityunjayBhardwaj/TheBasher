// #818 — THE BEVEL REACHES THE RUNNING APP. The observation #814 could not make.
//
// ── WHY THIS FILE IS THE POINT OF THE ISSUE AND NOT ITS GARNISH ────────────────────────
//
// #814 shipped the `bevel` descriptor — the first kind in this project that MINTS elements —
// with nothing in production able to construct one. So there was no *observe in the real app*
// step, and every check on a minting kind was a unit test calling the builder directly. The
// repo's own rule (quoted in `CLASS_CARRIAGE.edge` and in #783) is that a new kind cannot ship
// without its producing node; this spec is what says the node is really there.
//
// It drives the surface a director drives: click "+ Bevel" in the selected object's Modifiers
// section, then write `amount` through the same op the inspector writes. Nothing here reaches
// into `bevelGeometryRef`.
//
// ── THE TWO THINGS ONLY THIS ROAD CAN SEE ──────────────────────────────────────────────
//
// 1. **`amount` moves POSITIONS and moves NOTHING about the topology.** That is #814's central
//    claim and the reason `bevelLayoutOf` keys its layout on the source handle alone. A unit
//    test can assert the descriptor's counts; only a real build shows the vertex count holding
//    still at 96 across two amounts while the coordinates move.
//
// 2. **A zero amount does not throw.** `bevelGeometryRef` refuses a non-positive amount, and
//    `evaluate` runs on the render walk with NO `try` above it and no node-error surface in
//    this project — so a node without its passthrough arm is a white screen reachable by
//    dragging a slider to the bottom. `bevelNodeReach.gate.test.ts` proves the two predicates
//    partition the same set; only this file proves the render actually survives it.
//
// ── THE NUMBERS ARE PREDICTED, NOT RECORDED ────────────────────────────────────────────
//
// 96 is not a measurement someone pasted. A unit cube is `F=6, E=12, V=8`, so a segments-1
// bevel emits `F + E + V = 26` faces: 6 shrunk quads, 12 edge quads, 8 corner triangles. The
// renderer holds one position per output face-CORNER, so
//
//     8 × 3  +  18 × 4  =  96
//
// and `{3:8, 4:18}` is the arity multiset OBSERVED in a running Blender 5.1.1 at #814, before
// a line of the builder was written. This row is therefore the reference's own answer arriving
// on the render side, which is why it is asserted as arithmetic rather than as a literal.
//
// The coordinates are closed form for the same reason: the +X face's corners sit at
// `0.5 - amount` on both other axes. At 0.1 that is 0.4; at 0.3 it is 0.2. A wrong chamfer
// direction — the inside-out shell `bevelGeometryRef` refuses a negative amount to prevent —
// would put them OUTSIDE 0.5, which no count anywhere can see.
//
// REF: src/nodes/BevelModifier.ts; src/app/bevelNodeReach.gate.test.ts (the predicate pair);
//      src/app/bevelLayout.ts (the closed form); tests/e2e/_modifierStack.ts; issues #818,
//      #814, #817 (no upper bound on `amount`).

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

const CUBE = 'p818_cube';
const CUBE_DATA = 'p818_cube_data';

/** A unit cube's own vertex count in three.js — 4 per quad face. Derived live, never assumed. */
const CUBE_VERTS = 24;

/**
 * `F + E + V = 26` output faces over `{3:8, 4:18}` arities, one renderer position per output
 * face-corner. Written as the sum so a reader can check it against the Blender table in #814
 * rather than take it on trust.
 */
const BEVELLED_VERTS = 8 * 3 + 18 * 4;

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

/** The first two positions of the first mounted mesh — the +X face's first two shrunk corners.
 *  Six floats, so the chamfer's DIRECTION is observable and not only its size. */
function firstPositions(page: import('@playwright/test').Page, nodeId: string): Promise<number[]> {
  return page.evaluate((id) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene;
    let root: unknown = null;
    scene?.traverse((o) => {
      if ((o as { name?: string }).name === id && !root) root = o;
    });
    if (!root) return [];
    let out: number[] = [];
    (root as { traverse: (cb: (o: unknown) => void) => void }).traverse((o) => {
      const m = o as {
        type: string;
        geometry?: { attributes?: { position?: { array: ArrayLike<number> } } };
      };
      if (m.type === 'Mesh' && m.geometry?.attributes?.position && out.length === 0)
        out = Array.from(m.geometry.attributes.position.array).slice(0, 6);
    });
    return out;
  }, nodeId);
}

async function setParam(
  page: import('@playwright/test').Page,
  nodeId: string,
  paramPath: string,
  value: unknown,
) {
  await page.evaluate(
    ({ id, path, v }) => {
      const w = window as unknown as UiWindow;
      w.__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: id, paramPath: path, value: v }],
          'e2e',
          'p818 setParam',
        );
    },
    { id: nodeId, path: paramPath, v: value },
  );
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
        'p818 base split cube',
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

/** Adds the bevel through the panel and returns the minted modifier's node id. */
async function addBevel(page: import('@playwright/test').Page): Promise<string> {
  const stack = page.getByTestId('modifier-stack');
  await page.getByTestId('modifier-add-BevelModifier').click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  const testId = await stack
    .locator('[data-testid^="modifier-row-"]')
    .first()
    .getAttribute('data-testid');
  return testId!.replace('modifier-row-', '');
}

test('#818 — the Modifiers menu OFFERS a Bevel, which is the whole claim', async ({ page }) => {
  const stack = page.getByTestId('modifier-stack');
  await expect(stack).toBeVisible();
  await expect(stack.getByText('No modifiers.')).toBeVisible();

  // Membership is derived from `chain.section`, so this button existing is the declaration
  // reaching a director. Before #818 the kind existed and this button did not.
  await expect(page.getByTestId('modifier-add-BevelModifier')).toBeVisible();
  await expect(page.getByTestId('modifier-add-BevelModifier')).toHaveText(/Bevel/);
});

test('#818 — adding it chamfers the cube: 24 → 96, the arity multiset from the render side', async ({
  page,
}) => {
  await addBevel(page);

  // `F + E + V` faces over `{3:8, 4:18}` arities — the multiset observed in Blender at #814,
  // arriving here as a vertex count. A count-only check would pass on a wrong rule; this one
  // is pinned by the arithmetic above it.
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);
  expect(BEVELLED_VERTS).toBe(96);

  // And the chamfer goes the RIGHT WAY. The +X face's corners sit at `0.5 - amount` on the
  // other two axes — inside the original box. An inside-out shell would put them outside 0.5,
  // and no count anywhere in this repo could see that.
  const pos = await firstPositions(page, CUBE);
  expect(pos.map((v) => Number(v.toFixed(4)))).toEqual([0.5, 0.4, -0.4, 0.5, 0.4, 0.4]);
});

test('#818 — `amount` moves POSITIONS and moves NOTHING about the topology', async ({ page }) => {
  const modifierId = await addBevel(page);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);
  const at01 = await firstPositions(page, CUBE);

  await setParam(page, modifierId, 'amount', 0.3);
  // 🔑 THE ROW #814 COULD NOT WRITE. The count holds still while the coordinates move, which
  // is the observable form of "the layout is keyed on the source handle alone".
  await expect.poll(() => firstPositions(page, CUBE)).not.toEqual(at01);
  expect(await vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);

  const at03 = await firstPositions(page, CUBE);
  expect(at03.map((v) => Number(v.toFixed(4)))).toEqual([0.5, 0.2, -0.2, 0.5, 0.2, 0.2]);
});

test('#818 — a ZERO amount is transparent on the render walk, and does not throw', async ({
  page,
}) => {
  // The crash this operator's passthrough arm exists to prevent, observed not to happen.
  // `evaluate` runs with no `try` above it, so without the arm this is a white screen a
  // director reaches by dragging a slider to the bottom — and the unit gate, which calls
  // `evaluate` directly, cannot show that the RENDER survived.
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const modifierId = await addBevel(page);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);

  await setParam(page, modifierId, 'amount', 0);
  // Blender's own answer: `MOD_bevel.cc:303-307` disables the modifier at `value == 0`, and a
  // disabled modifier is skipped. The cube comes back untouched.
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(CUBE_VERTS);

  // And back up again — a transparent bevel is an authoring step, not a dead end.
  await setParam(page, modifierId, 'amount', 0.1);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);

  expect(pageErrors).toEqual([]);
});

test('#818 — the INSPECTOR routes `amount`, and typing in it reshapes the cube', async ({
  page,
}) => {
  // The last exit clause of #818, and the only one that goes through no `dispatchAtomic` of
  // this spec's own: a director selects the row and types. `home: { amount: 'modifier' }` is
  // what routes the control there, and `paramHomeGolden` pins the routing — but a golden is a
  // string, and a string cannot say the input rendered. This row can.
  const modifierId = await addBevel(page);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);

  // Params live under the SELECTED row — the same gesture Array and Mirror need.
  await page.locator(`[data-testid="modifier-row-${modifierId}"]`).click();
  const amount = page.getByTestId(`inspector-input-${modifierId}-amount`);
  await expect(amount).toBeVisible();
  await expect(amount).toHaveValue('0.1');

  await amount.fill('0.3');
  await amount.press('Enter');

  // Typed through the real control, the chamfer moves — and the topology does not.
  await expect
    .poll(async () => (await firstPositions(page, CUBE)).map((v) => Number(v.toFixed(4))))
    .toEqual([0.5, 0.2, -0.2, 0.5, 0.2, 0.2]);
  expect(await vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);
});

test('#818 — muting the row bypasses it, and the cube comes back', async ({ page }) => {
  // The category's bypass, applied above `evaluate` (ns-2 step 5). Asserted here because a
  // minting operator is the first one for which "bypassed" and "amount 0" are two different
  // roads to the same picture, and both must work.
  const modifierId = await addBevel(page);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);

  await setParam(page, modifierId, 'muted', true);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(CUBE_VERTS);

  await setParam(page, modifierId, 'muted', false);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(BEVELLED_VERTS);
});
