// #691 — a modifier CARRIES its source's slot table, so the tiled layout reaches the screen.
//
// ── WHY THIS IS AN e2e AND NOT A UNIT ROW ─────────────────────────────────────────────
//
// The unit tier can assert what the modifier EMITS; it cannot assert that three.js draws
// with it. That gap is exactly where this defect lived: after #644 the merged geometry had
// a correct six-group, 108-index layout AND the picture was unchanged, because the value
// carried no table, `dataSlotsOnly` fell back to `[material]`, and a single material makes
// three.js ignore every group. Measured in a browser at the time: `materialCount: 1` beside
// a layout that was right in every other respect. A value assertion cannot see that, and
// this repo has no React component tier ([[V190]]) — so the browser spec IS the work.
//
// ── THE NUMBER THAT DISCRIMINATES ─────────────────────────────────────────────────────
//
// `materialCount`, read off the MOUNTED mesh. `indexCount` and `groupCount` were already
// correct before the fix and are asserted here as controls: if a regression drops the tiling
// they move too, and a red that shows 108/6/1 means something different from one that shows
// 36/2/1. Reading only the group layout would have called the broken state healthy.
//
// REF: src/app/modifierDataSource.ts (`slotTableThrough` — the forwarding rule and the
//      source-vs-built asymmetry); src/nodes/ArrayModifier.ts; src/nodes/MirrorModifier.ts;
//      src/app/materialAssignment.ts (`dataSlotsOnly`, the data half of `objectSlotsOf`);
//      src/viewport/SceneFromDAG.tsx (`needsMaterialSlots` — the fork this unblocks);
//      tests/e2e/p638-two-material-mesh.spec.ts (the un-modified source case);
//      issues #691, #644, #649, #638.
import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

const BLUE = '#0000ff';

interface Op {
  type: string;
  [k: string]: unknown;
}

interface W {
  __basher_dag: {
    getState: () => {
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
      state: { outputs: { scene?: unknown } };
    };
  };
  __basher_three: { getState: () => { scene: unknown } };
  __basher_selection: unknown;
  __basher_geometry_registry: unknown;
  __basher_mesh_material?: (
    id: string,
  ) => { materialCount: number; type: string | null; color: string | null } | null;
}

async function dispatch(page: Page, ops: Op[], label: string): Promise<void> {
  await page.evaluate(
    ({ ops: o, label: l }) => {
      (window as unknown as W).__basher_dag.getState().dispatchAtomic(o, l, l);
    },
    { ops, label },
  );
}

/** Assign blue to faces `scope` of the box, splicing SetMaterialOp before the Object. */
function authorOps(scope: string): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: 'n_mat_blue',
      nodeType: 'Material',
      params: { material: { name: 'blue', base: { color: BLUE } } },
    },
    { type: 'addNode', nodeId: 'n_setmat', nodeType: 'SetMaterialOp', params: { scope } },
    {
      type: 'connect',
      from: { node: 'n_box_data', socket: 'out' },
      to: { node: 'n_setmat', socket: 'target' },
    },
    {
      type: 'connect',
      from: { node: 'n_mat_blue', socket: 'out' },
      to: { node: 'n_setmat', socket: 'material' },
    },
    {
      type: 'connect',
      from: { node: 'n_setmat', socket: 'out' },
      to: { node: 'n_box', socket: 'data' },
      // Splicing the operator in displaces the object's data edge (#759).
      replace: true,
    },
  ];
}

/** Splice an Array x3 between the assigning op and the Object. */
function arrayOps(): Op[] {
  return [
    {
      type: 'addNode',
      nodeId: 'n_array',
      nodeType: 'ArrayModifier',
      params: { count: 3, offset: [2, 0, 0], muted: false, scope: '' },
    },
    {
      type: 'connect',
      from: { node: 'n_setmat', socket: 'out' },
      to: { node: 'n_array', socket: 'target' },
    },
    {
      type: 'connect',
      from: { node: 'n_array', socket: 'out' },
      to: { node: 'n_box', socket: 'data' },
      // Splicing the operator in displaces the object's data edge (#759).
      replace: true,
    },
  ];
}

async function meshFacts(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    interface Obj {
      name?: string;
      type?: string;
      children?: Obj[];
      material?: unknown;
      geometry?: {
        uuid: string;
        index?: { count: number } | null;
        groups?: { start: number; count: number; materialIndex?: number }[];
        getIndex?: () => { count: number } | null;
      };
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
    const idx = m.geometry?.getIndex ? m.geometry.getIndex() : (m.geometry?.index ?? null);
    return {
      isArray: Array.isArray(mat),
      materialCount: Array.isArray(mat) ? mat.length : 1,
      groupCount: m.geometry?.groups?.length ?? 0,
      groups: (m.geometry?.groups ?? []).map((g) => [g.start, g.count, g.materialIndex]),
      indexCount: idx?.count ?? null,
    };
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

test('a two-material box under an Array x3 draws with BOTH materials', async ({ page }) => {
  // 1 — the source alone. This is the state that already worked.
  await dispatch(page, authorOps('0-2'), 'assign');
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_material?.('n_box')?.materialCount === 2,
    undefined,
    { timeout: 10_000 },
  );
  const source = await meshFacts(page, 'n_box');
  console.log('SOURCE (no modifier):', JSON.stringify(source));

  // 2 — splice the Array over it. Before #691 this collapsed to one material.
  await dispatch(page, arrayOps(), 'array');
  await page.waitForTimeout(1500);

  const arrayed = await meshFacts(page, 'n_box');
  const probe = await page.evaluate(
    () => (window as unknown as W).__basher_mesh_material?.('n_box') ?? null,
  );
  console.log('ARRAYED:', JSON.stringify(arrayed));
  console.log('ARRAYED probe:', JSON.stringify(probe));

  // The done-when, in the running app.
  expect(arrayed!.indexCount).toBe(108);
  expect(arrayed!.groupCount).toBe(6);
  expect(arrayed!.materialCount).toBe(2);
  expect(arrayed!.isArray).toBe(true);
});
