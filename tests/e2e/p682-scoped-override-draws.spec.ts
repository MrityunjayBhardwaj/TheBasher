// #682 — THE BROWSER OBSERVATION FOR A SCOPED **OVERRIDE**. The debt this pays was stated
// rather than hidden when #682 shipped: its emission is proven in the unit tier (the slot
// table, both arms, the geometry re-mint), but no spec had ever authored a scoped
// `MaterialOverrideOp`, so its pixels were INFERRED from the draw path #638 shipped.
//
// ── WHY p638 AND p660 DO NOT ALREADY COVER THIS ───────────────────────────────────────
//
// Measured with a denominator rather than assumed: of 276 e2e specs, SIX author
// `MaterialOverrideOp` (p394 x3, p522, p530, p536) and **none of them sets a scope**. The
// scoped WRITER — `SetMaterialOp` — is observed by `p638-two-material-mesh.spec.ts`, and
// p660 covers the scoped GENERATOR. The sparse sibling on a subset is the hole.
//
// The two operators are NOT interchangeable here. `SetMaterialOp` REPLACES: slot 1 is a
// wholly new material off its `material` socket. `MaterialOverrideOp` COMPOSES: it has no
// material socket at all (`inputs: { target }` only) and builds slot 1 by composing its
// authored channels ONTO the source. So "the source material survives on the unselected
// faces" is a different claim here — the composed material is derived from the very thing
// that must stay untouched, which is exactly how a whole-mesh compose hides.
//
// ── THE DISCRIMINATING CLAUSE, AND WHY THE OBVIOUS ONE IS NOT IT ──────────────────────
//
// "the scoped override draws blue" is satisfied by an implementation that composes onto
// EVERY face — the precise defect #682 fixed, and the one a honouring cross-check cannot
// see (a whole-mesh compose does make the output move). So the load-bearing clause is a
// RELATION between two renders of the same scene:
//
//     scoped blue  <  total blue        strictly, with a floor under both.
//
// A whole-mesh compose makes those two equal and reds here. A scope that silently drew
// nothing makes the floor red. Neither clause alone is enough, which is p660's lesson.
//
// REF: src/nodes/MaterialOverrideOp.ts (the append arm and its slot-0 warning);
//      tests/e2e/p638-two-material-mesh.spec.ts (the scoped WRITER half + this harness);
//      tests/e2e/p660-scoped-generator-draws.spec.ts (relation-plus-floor pixel discipline);
//      issues #682, #638, #660.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

/** Unmistakable against the seed scene, whose cube is standard grey and carries no blue. */
const BLUE = '#0000ff';

// A box is 12 triangles = 36 index elements. `1-6` is six of them — half — and is written
// `1-6` rather than `0-5` for the reason ns-2 step 15 records: `0-5` is ALSO exactly cube
// sides 0/1/2, so it agrees with a cube-side implementation and a triangle one at once.
// `1-6` has the same cardinality and separates them.
const SCOPE_HALF = '1-6';

/** Both renders must clear this, or "scoped < total" is satisfiable by drawing nothing. */
const DRAWS_AT_ALL = 5_000;

interface Op {
  type: string;
  [k: string]: unknown;
}

interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, unknown>; outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_three: { getState: () => { scene: unknown } };
  __basher_selection: {
    getState: () => { select: (id: string | null) => void; primaryNodeId: string | null };
  };
  __basher_geometry_registry: { size: () => number };
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
  __basher_mesh_material?: (
    nodeId: string,
  ) => { materialCount: number; type: string | null; color: string | null } | null;
}

interface MeshFacts {
  readonly isArray: boolean;
  readonly materialCount: number;
  readonly groupCount: number;
  readonly groups: readonly { start: number; count: number; materialIndex?: number }[];
}

/**
 * The ops the graph editor emits for "override these faces of that box".
 *
 * No `material` socket, unlike p638's `authorOps` — the override's channels are PARAMS, and
 * `overridden: { color: true }` is the explicit authored bit (never derived from
 * value != default). `connect` onto a single-cardinality input REPLACES the prior binding,
 * so splicing between the data node and its Object needs no `disconnect`.
 */
function authorOverrideOps(dataId: string, objectId: string, opId: string, scope: string): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: opId,
      nodeType: 'MaterialOverrideOp',
      params: { scope, color: BLUE, overridden: { color: true } },
    },
    {
      type: 'connect',
      from: { node: dataId, socket: 'out' },
      to: { node: opId, socket: 'target' },
    },
    {
      type: 'connect',
      from: { node: opId, socket: 'out' },
      to: { node: objectId, socket: 'data' },
    },
  ];
}

async function dispatch(page: Page, ops: Op[], label: string): Promise<void> {
  await page.evaluate(
    ([o, l]) => {
      (window as unknown as W).__basher_dag.getState().dispatchAtomic(o, l, l);
    },
    [ops, label] as [Op[], string],
  );
}

async function meshFacts(page: Page, nodeId: string): Promise<MeshFacts | null> {
  return page.evaluate((id) => {
    interface Obj {
      name?: string;
      type?: string;
      children?: Obj[];
      material?: unknown;
      geometry?: { groups?: { start: number; count: number; materialIndex?: number }[] };
    }
    const scene = (window as unknown as W).__basher_three.getState().scene as Obj | null;
    if (!scene) return null;
    let band: Obj | null = null;
    const findBand = (o: Obj): void => {
      if (o.name === id) band = o;
      if (band === null) (o.children ?? []).forEach(findBand);
    };
    findBand(scene);
    if (band === null) return null;
    let mesh: Obj | null = null;
    const findMesh = (o: Obj): void => {
      if (mesh === null && o.type === 'Mesh' && o.geometry) mesh = o;
      if (mesh === null) (o.children ?? []).forEach(findMesh);
    };
    findMesh(band);
    if (mesh === null) return null;
    const m = mesh as Obj;
    const mat = m.material;
    return {
      isArray: Array.isArray(mat),
      materialCount: Array.isArray(mat) ? (mat as unknown[]).length : 1,
      groupCount: m.geometry?.groups?.length ?? 0,
      groups: (m.geometry?.groups ?? []).map((g) => ({
        start: g.start,
        count: g.count,
        materialIndex: g.materialIndex,
      })),
    };
  }, nodeId);
}

/** Count blue (the override) and grey (the seed cube's own material) in a real render. */
async function bluePixels(page: Page): Promise<{ blue: number; grey: number } | null> {
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
    let blue = 0;
    let grey = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      // Blue-dominant WITH A MARGIN, so the stage background — a very slightly blue
      // near-black — cannot be counted as the override.
      if (b > r + 30 && b > g + 30) blue++;
      // The seed cube's standard grey (#cccccc), neutral with a brightness floor the
      // background cannot reach.
      else if (r >= 48 && Math.abs(r - g) <= 12 && Math.abs(g - b) <= 12 && Math.abs(r - b) <= 12)
        grey++;
    }
    return { blue, grey };
  });
}

async function waitForTwoMaterialMesh(page: Page, nodeId: string): Promise<void> {
  await expect
    .poll(async () => (await meshFacts(page, nodeId))?.materialCount ?? 0, { timeout: 10_000 })
    .toBe(2);
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
      w.__basher_selection &&
      w.__basher_geometry_registry &&
      w.__basher_three.getState().scene &&
      w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

// ── CLAUSE 1 — the mesh the renderer actually mounts ──────────────────────────────────
test('a scoped override mounts a TWO-material mesh split at the triangle boundary', async ({
  page,
}) => {
  await dispatch(page, authorOverrideOps('n_box_data', 'n_box', 'n_ovr', SCOPE_HALF), 'override');
  await waitForTwoMaterialMesh(page, 'n_box');

  const facts = await meshFacts(page, 'n_box');
  expect(facts).not.toBeNull();
  expect(facts!.isArray).toBe(true);
  expect(facts!.materialCount).toBe(2);
  // THREE runs, not two — and the number is the measurement correcting the assumption that
  // wrote this row. `1-6` is a run in the MIDDLE of the box, so the remainder is TWO
  // stretches (before and after), not one. p638's `0-1` starts at zero and yields two; the
  // shape does not carry across, and a row that asserted 2 here would have been asserting
  // the fixture's alignment rather than the operator's behaviour.
  expect(facts!.groupCount).toBe(3);

  // 🔴 THE GRANULARITY, ON THE LIVE INSTANCE, AS AN EXACT PARTITION. Faces 1–6 are triangles
  // 1..6 = index elements [3,21). The boundaries land on multiples of 3 (a TRIANGLE), never
  // on multiples of 6 (a cube SIDE) — which is the error an aligned fixture cannot see, and
  // the whole reason ns-2 step 15 chose `1-6` over `0-5`.
  expect(facts!.groups).toEqual([
    { start: 0, count: 3, materialIndex: 0 },
    { start: 3, count: 18, materialIndex: 1 },
    { start: 21, count: 15, materialIndex: 0 },
  ]);
  // Every index element covered exactly once — 36 for a box. A scope that dropped faces
  // would leave a hole here and the mesh would draw gaps.
  expect(facts!.groups.reduce((a, g) => a + g.count, 0)).toBe(36);

  // The standing probe must not answer a multi-material mesh with plausible nulls.
  const probe = await page.evaluate(() =>
    (window as unknown as W).__basher_mesh_material!('n_box'),
  );
  expect(probe, 'the standing probe must not answer a two-material mesh with nulls').not.toBeNull();
  expect(probe!.materialCount).toBe(2);
});

// ── CLAUSE 2 — 🔴 THE DISCRIMINATING ROW. Pixels, and a relation between two renders ───
test('the override reaches the screen on the SELECTION ONLY — scoped draws strictly less blue than total', async ({
  page,
}) => {
  // (a) the scoped render.
  await dispatch(page, authorOverrideOps('n_box_data', 'n_box', 'n_ovr', SCOPE_HALF), 'override');
  await waitForTwoMaterialMesh(page, 'n_box');
  const scoped = await bluePixels(page);
  expect(scoped).not.toBeNull();

  // (b) the SAME scene widened to a total selection. A blank scope is the same authoring
  // state as absent and means every face, so this takes the operator's replace arm — one
  // material, the whole cube blue.
  await dispatch(
    page,
    [{ type: 'setParam', nodeId: 'n_ovr', paramPath: 'scope', value: '' }],
    'widen',
  );
  await expect
    .poll(async () => (await meshFacts(page, 'n_box'))?.materialCount ?? 0, { timeout: 10_000 })
    .toBe(1);
  const total = await bluePixels(page);
  expect(total).not.toBeNull();

  const seen = `scoped blue ${scoped!.blue} (grey ${scoped!.grey}) vs total blue ${total!.blue}`;

  // THE FLOOR — under BOTH, so "less" cannot be satisfied by drawing nothing.
  expect(scoped!.blue, seen).toBeGreaterThan(DRAWS_AT_ALL);
  expect(total!.blue, seen).toBeGreaterThan(DRAWS_AT_ALL);

  // 🔴 THE RELATION. An override composed onto every face makes these EQUAL. This is the
  // defect #682 fixed and the one a "did the output move?" check cannot see.
  expect(scoped!.blue, seen).toBeLessThan(total!.blue);

  // And the unselected faces are still wearing the source material — the other half of the
  // same claim, read as pixels rather than as a slot table.
  expect(scoped!.grey, seen).toBeGreaterThan(DRAWS_AT_ALL);
});
