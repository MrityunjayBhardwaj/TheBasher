// #827 — A BEVEL THAT CHAMFERS SOME EDGES, IN THE RUNNING APP.
//
// ── WHAT ONLY THIS ROAD CAN SEE ────────────────────────────────────────────────────────
//
// #818 gave the bevel its producing node and this spec's siblings observe the all-edges case.
// #827 gave it a SELECTION, and two of its claims are invisible to a unit test:
//
// 1. **A refusal reachable by an author must not kill the render.** The miter rule is partial
//    on purpose — a point with exactly one chamfered edge is refused by name — and unlike the
//    manifoldness gate that state is one keystroke away: typing a single edge index reaches it.
//    `evaluate` runs on the render walk with NO `try` above it and this project has no
//    node-error surface, so "the builder returns null" and "the app survives" are two different
//    claims and only this file can make the second.
//
// 2. **The scope reaches the descriptor, the layout AND the buffer.** A unit test can assert
//    that `bevelLayoutOf` counts differently. Only a real build shows the renderer mounting the
//    smaller mesh, and shows it coming BACK when the scope is cleared.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT CLAIM ────────────────────────────────────────
//
// ⚠️ THERE IS NO INSPECTOR CONTROL FOR `scope`, AND THAT IS TRUE OF ALL SIX SCOPED OPERATORS
// RATHER THAN OF THIS ONE. Measured: the only `type="text"` inputs in the panel are the material
// name and the colour hex, so a string param has no generic row — `inspector-input-…` is the
// NUMERIC row. `paramHomeGolden` pins that `scope` is ROUTED to the modifier section, which is
// as far as `home` can carry it, and every scoped operator's e2e (p682 included) sets the query
// through `setParam` exactly as this file does. The missing control is #667's gap, which already
// names it, and this bevel is at parity with its five siblings rather than behind them.
//
// A row asserting that control was WRITTEN here and removed: routing is not rendering, and the
// row would have been a wish rather than an observation.
//
// ── THE NUMBERS ARE PREDICTED, AND THEY CAME FROM BLENDER FIRST ────────────────────────
//
// Edges are numbered by first encounter over the face order, so a unit cube's face 0 owns edges
// 0–3 — a CLOSED LOOP, which is the case the miter rule answers. Around that loop every point
// has exactly two chamfered edges and every other point has none, so by the rule measured live
// in Blender 5.1.1 (#827) the output is:
//
//     points = 4 x 2  +  4 x 1  =  12          faces = 6 + 4 + 0 = 10, all quads
//
// and the renderer holds one position per output face-corner, so
//
//     10 x 4  =  40
//
// Blender, asked the same question about a cube's top-face loop, answered 12 points / 10 faces
// with arity {4:10}. This row is that answer arriving on our render side.

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

const CUBE = 'p827_cube';
const CUBE_DATA = 'p827_cube_data';

/** A unit cube's own vertex count in three.js — 4 per quad face. Derived live, never assumed. */
const CUBE_VERTS = 24;

/**
 * The all-edges bevel: `F + E + V = 26` output faces over `{3:8, 4:18}` arities, one renderer
 * position per output face-corner.
 */
const ALL_EDGES_VERTS = 8 * 3 + 18 * 4;

/**
 * Chamfering face 0's four edges — a closed loop. Four points carry two boundary vertices each
 * and the other four carry one, giving 6 + 4 + 0 = 10 faces, every one a quad. Written as the
 * sum so a reader can check it against the measurement on #827 rather than take it on trust.
 */
const LOOP_VERTS = 10 * 4;

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
          'p827 setParam',
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
        'p827 base split cube',
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

test('#827 — a scoped bevel chamfers ONLY the selected loop: 24 -> 40', async ({ page }) => {
  const modifierId = await addBevel(page);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(ALL_EDGES_VERTS);

  // Face 0's four edges — a closed loop, which is what the miter rule answers.
  await setParam(page, modifierId, 'scope', '0-3');
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(LOOP_VERTS);

  // 🔑 AND IT COMES BACK. A blank scope is the same authoring state as no scope, so clearing it
  // must return the all-edges mesh rather than leaving the smaller one cached — the descriptor
  // key and the layout cache both have to have carried the scope for this leg to pass.
  await setParam(page, modifierId, 'scope', '');
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(ALL_EDGES_VERTS);
});

test('#827 — a LONE edge is refused, and the refusal does not take the app down', async ({
  page,
}) => {
  // The deferred terminal case, reached the way an author reaches it: by typing one index.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  const modifierId = await addBevel(page);
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(ALL_EDGES_VERTS);

  await setParam(page, modifierId, 'scope', '0');
  // 🔴 ZERO, NOT `-1`, AND THE DIFFERENCE WAS MEASURED RATHER THAN PREDICTED. This row first
  // asserted `-1` — "the object does not mount at all" — on the reasoning that a refused build
  // returns null. What actually happens is that the object DOES mount and carries no mesh: the
  // refusal is local to the geometry, so the scene graph keeps its node and the draw is empty.
  // Worth pinning as the real number, because the two states look identical in the viewport and
  // are not the same thing — `-1` would mean the render walk dropped the object entirely.
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(0);

  // 🔴 THE CLAIM THIS FILE EXISTS FOR: the render walk survived it. No `try` sits above
  // `evaluate`, so a throw here would be a white screen an author reached by typing.
  expect(errors).toEqual([]);
  await expect(page.getByTestId('layout')).toBeVisible();

  // And it recovers — the refusal is a state, not a corruption.
  await setParam(page, modifierId, 'scope', '0-3');
  await expect.poll(() => vertsUnder(page, CUBE)).toBe(LOOP_VERTS);
  expect(errors).toEqual([]);
});
