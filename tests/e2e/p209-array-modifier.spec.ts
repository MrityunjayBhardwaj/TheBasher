// #209 increment 1 — the Array MODIFIER (epic #201, §5; the SOP / geometry half of
// V58). Observes on the LIVE app (Lokayata) that a geometry modifier wired as a
// Mesh→Mesh sub-chain (Box → ArrayModifier → Scene.children) actually rewrites the
// rendered geometry — the viewport shows the MERGED array, not the bare box.
//
// BOUNDARY-PAIR (H40 / V37): the rendered mesh's vertex count (side A — read off
// the three scene) == the resolver's registry-built vertex count (side B —
// __basher_modified_vertex_count, the SAME geometryRegistry instance ModifiedMeshR
// rendered). Equal → the live render consumed the resolver's geometry handle, no
// drift between the render road and the read-side road.
//
// FALSIFICATION (guards a vacuous pass): muting the modifier (the stack
// mute-bypass, V58) collapses the output back to the source box's vertex count —
// so it is the operator that produced the extra geometry, not a stray mesh.
//
// PARITY (V37): the offscreen render succeeds with the modifier present.
//
// REF: src/nodes/ArrayModifier.ts; src/app/modifierGeometry.ts;
//      src/app/geometryRegistry.ts (build 'array'); src/viewport/SceneFromDAG.tsx
//      (ModifiedMeshR); src/app/resolveEvaluatedMesh.ts; vyapti V58/V37; H40.

import { expect, test } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface ModWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_three: { getState: () => { scene: ThreeSceneLike | null } };
  __basher_modified_vertex_count: (nodeId: string) => number | null;
  __basher_render_png?: () => Promise<{ width: number; height: number; dataUrl: string } | null>;
}
interface ThreeSceneLike {
  traverse: (cb: (o: ThreeObjLike) => void) => void;
}
interface ThreeObjLike {
  type: string;
  geometry?: { attributes?: { position?: { count: number } } };
}

const MBOX = 'p209_box';
const MARR = 'p209_array';
const COUNT = 3; // 3 copies of a unit box (24 verts each) → 72 merged verts

/** Every rendered Mesh's position-attribute vertex count, in the live three scene. */
function meshVertexCounts(page: import('@playwright/test').Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as ModWindow;
    const scene = w.__basher_three.getState().scene;
    const counts: number[] = [];
    scene?.traverse((o) => {
      const g = o.geometry?.attributes?.position;
      if (o.type === 'Mesh' && g) counts.push(g.count);
    });
    return counts;
  });
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
    const w = window as unknown as ModWindow;
    return Boolean(w.__basher_dag && w.__basher_three && w.__basher_dag.getState().state.outputs.scene);
  });
});

test('#209 — Box → ArrayModifier → Scene renders the MERGED array; render verts == resolver verts (H40)', async ({
  page,
}) => {
  // A fresh box (NOT the default scene box), wired through an ArrayModifier into the
  // scene children. The arrayed mesh is the only one with > 24 verts.
  await page.evaluate(
    ({ box, arr, count }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          { type: 'addNode', nodeId: box, nodeType: 'BoxMesh', params: { size: [1, 1, 1], position: [4, 0, 0] } },
          { type: 'addNode', nodeId: arr, nodeType: 'ArrayModifier', params: { count, offset: [2, 0, 0], muted: false } },
          { type: 'connect', from: { node: box, socket: 'out' }, to: { node: arr, socket: 'target' } },
          { type: 'connect', from: { node: arr, socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        ],
        'e2e',
        'box → array → scene',
      );
    },
    { box: MBOX, arr: MARR, count: COUNT },
  );

  // Side B (resolver): the registry-built array vertex count = 3 × 24 = 72.
  await page.waitForFunction(
    (arr) => {
      const w = window as unknown as ModWindow;
      return w.__basher_modified_vertex_count(arr) !== null;
    },
    MARR,
    { timeout: 15_000 },
  );
  const resolverCount = await page.evaluate(
    (arr) => (window as unknown as ModWindow).__basher_modified_vertex_count(arr),
    MARR,
  );
  expect(resolverCount).toBe(24 * COUNT); // 72 — the merged array

  // Side A (render): the live viewport contains a mesh with exactly that vertex
  // count → the modifier's geometry actually flowed to the renderer (not the box).
  await page.waitForFunction(
    (want) => {
      const w = window as unknown as ModWindow;
      const scene = w.__basher_three.getState().scene;
      let found = false;
      scene?.traverse((o) => {
        const g = (o as ThreeObjLike).geometry?.attributes?.position;
        if ((o as ThreeObjLike).type === 'Mesh' && g && g.count === want) found = true;
      });
      return found;
    },
    resolverCount,
    { timeout: 15_000 },
  );
  const counts = await meshVertexCounts(page);
  expect(counts).toContain(resolverCount); // render-count == resolver-count (boundary-pair)
  expect(resolverCount).toBeGreaterThan(24); // and it is genuinely arrayed, not a passthrough

  // PARITY (V37): the offscreen render succeeds with the modifier present.
  const out = await page.evaluate(() => (window as unknown as ModWindow).__basher_render_png!());
  expect(out).not.toBeNull();
  expect(out!.dataUrl.startsWith('data:image/png')).toBe(true);
});

test('#209 — muting the modifier collapses the output back to the source box (falsification)', async ({
  page,
}) => {
  await page.evaluate(
    ({ box, arr, count }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          { type: 'addNode', nodeId: box, nodeType: 'BoxMesh', params: { size: [1, 1, 1], position: [4, 0, 0] } },
          { type: 'addNode', nodeId: arr, nodeType: 'ArrayModifier', params: { count, offset: [2, 0, 0], muted: false } },
          { type: 'connect', from: { node: box, socket: 'out' }, to: { node: arr, socket: 'target' } },
          { type: 'connect', from: { node: arr, socket: 'out' }, to: { node: sceneId, socket: 'children' } },
        ],
        'e2e',
        'box → array → scene',
      );
    },
    { box: MBOX, arr: MARR, count: COUNT },
  );

  // Active → 72 verts.
  await page.waitForFunction(
    (arr) => (window as unknown as ModWindow).__basher_modified_vertex_count(arr) === 72,
    MARR,
    { timeout: 15_000 },
  );

  // Mute it → the source box passes through → 24 verts (the registry build for a box).
  await page.evaluate((arr) => {
    const w = window as unknown as ModWindow;
    w.__basher_dag.getState().dispatchAtomic(
      [{ type: 'setParam', nodeId: arr, paramPath: 'muted', value: true }],
      'e2e',
      'mute',
    );
  }, MARR);

  await page.waitForFunction(
    (arr) => (window as unknown as ModWindow).__basher_modified_vertex_count(arr) === 24,
    MARR,
    { timeout: 15_000 },
  );
  // No 72-vert mesh remains in the live scene — the operator's geometry is gone.
  const counts = await meshVertexCounts(page);
  expect(counts).not.toContain(72);
});
