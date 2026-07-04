// #209 — the Mirror MODIFIER (epic #201, §5; the SECOND geometry operator, V58).
// Observes on the LIVE app (Lokayata) that Mirror, like Array, wires as a Mesh→Mesh
// sub-chain (Box → MirrorModifier → Scene.children) and actually rewrites the
// rendered geometry — the viewport shows the merged source+reflection (2× verts),
// not the bare box.
//
// BOUNDARY-PAIR (H40 / V37): the rendered mesh's vertex count (side A — read off the
// three scene) == the resolver's registry-built count (side B —
// __basher_modified_vertex_count, the SAME geometryRegistry instance ModifiedMeshR
// rendered). Equal → the live render consumed the resolver's geometry handle, no
// drift between the render road and the read-side road.
//
// FALSIFICATION: muting the modifier (the stack mute-bypass, V58) collapses the
// output back to the source box's vertex count — so it is the operator that
// produced the extra geometry, not a stray mesh.
//
// COMPOSITION: a MIXED chain Box → Array(3) → Mirror renders cumulatively (3 × 24 =
// 72, then mirrored = 144) — proving the substrate composes ACROSS modifier types,
// not just Array-of-Array. The recursive registry build is the risky bit.
//
// REF: src/nodes/MirrorModifier.ts; src/app/modifierGeometry.ts;
//      src/app/geometryRegistry.ts (build 'mirror' + reverseWinding);
//      src/viewport/SceneFromDAG.tsx (ModifiedMeshR); vyapti V58/V37; H40/H111.

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

const MBOX = 'p209m_box';
const MMIR = 'p209m_mirror';

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
    return Boolean(
      w.__basher_dag && w.__basher_three && w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('#209 — Box → MirrorModifier → Scene renders the MERGED mirror; render verts == resolver verts (H40)', async ({
  page,
}) => {
  await page.evaluate(
    ({ box, mir }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: box,
            nodeType: 'BoxMesh',
            params: { size: [1, 1, 1], position: [4, 0, 0] },
          },
          // offset 2 → the reflected half lands across x=2, separated from the source
          // (a geometry-centered primitive mirrored at the origin would just overlap).
          {
            type: 'addNode',
            nodeId: mir,
            nodeType: 'MirrorModifier',
            params: { axis: 'x', offset: 2, muted: false },
          },
          {
            type: 'connect',
            from: { node: box, socket: 'out' },
            to: { node: mir, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: mir, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'box → mirror → scene',
      );
    },
    { box: MBOX, mir: MMIR },
  );

  // Side B (resolver): the registry-built mirror = source + reflection = 2 × 24 = 48.
  await page.waitForFunction(
    (mir) => (window as unknown as ModWindow).__basher_modified_vertex_count(mir) !== null,
    MMIR,
    { timeout: 15_000 },
  );
  const resolverCount = await page.evaluate(
    (mir) => (window as unknown as ModWindow).__basher_modified_vertex_count(mir),
    MMIR,
  );
  expect(resolverCount).toBe(48); // 2 × 24 — source + reflection merged

  // Side A (render): the live viewport contains a mesh with exactly that vertex count.
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

  // PARITY (V37): the offscreen render succeeds with the modifier present.
  const out = await page.evaluate(() => (window as unknown as ModWindow).__basher_render_png!());
  expect(out).not.toBeNull();
  expect(out!.dataUrl.startsWith('data:image/png')).toBe(true);
});

test('#209 — muting the Mirror collapses the output back to the source box (falsification)', async ({
  page,
}) => {
  await page.evaluate(
    ({ box, mir }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: box,
            nodeType: 'BoxMesh',
            params: { size: [1, 1, 1], position: [4, 0, 0] },
          },
          {
            type: 'addNode',
            nodeId: mir,
            nodeType: 'MirrorModifier',
            params: { axis: 'x', muted: false },
          },
          {
            type: 'connect',
            from: { node: box, socket: 'out' },
            to: { node: mir, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: mir, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'box → mirror → scene',
      );
    },
    { box: MBOX, mir: MMIR },
  );

  await page.waitForFunction(
    (mir) => (window as unknown as ModWindow).__basher_modified_vertex_count(mir) === 48,
    MMIR,
    { timeout: 15_000 },
  );

  // Mute it → the source box passes through → 24 verts.
  await page.evaluate((mir) => {
    const w = window as unknown as ModWindow;
    w.__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: mir, paramPath: 'muted', value: true }],
        'e2e',
        'mute',
      );
  }, MMIR);

  await page.waitForFunction(
    (mir) => (window as unknown as ModWindow).__basher_modified_vertex_count(mir) === 24,
    MMIR,
    { timeout: 15_000 },
  );
  const counts = await meshVertexCounts(page);
  expect(counts).not.toContain(48); // the mirrored geometry is gone
});

test('#209 — a MIXED chain Box → Array(3) → Mirror composes (72 → 144 — cross-modifier recursive build)', async ({
  page,
}) => {
  const ARR = 'p209m_arr';
  await page.evaluate(
    ({ box, arr, mir }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: box,
            nodeType: 'BoxMesh',
            params: { size: [1, 1, 1], position: [4, 0, 0] },
          },
          {
            type: 'addNode',
            nodeId: arr,
            nodeType: 'ArrayModifier',
            params: { count: 3, offset: [2, 0, 0], muted: false },
          },
          {
            type: 'addNode',
            nodeId: mir,
            nodeType: 'MirrorModifier',
            params: { axis: 'y', muted: false },
          },
          {
            type: 'connect',
            from: { node: box, socket: 'out' },
            to: { node: arr, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: arr, socket: 'out' },
            to: { node: mir, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: mir, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'box → array → mirror → scene',
      );
    },
    { box: MBOX, arr: ARR, mir: MMIR },
  );

  // Side B: array (3 × 24 = 72) then mirror (× 2) = 144 verts at the top of the chain.
  await page.waitForFunction(
    (mir) => (window as unknown as ModWindow).__basher_modified_vertex_count(mir) === 144,
    MMIR,
    { timeout: 15_000 },
  );
  // Side A: the live render contains that cumulative mesh (boundary-pair through the mixed chain).
  await page.waitForFunction(
    () => {
      const w = window as unknown as ModWindow;
      const scene = w.__basher_three.getState().scene;
      let found = false;
      scene?.traverse((o) => {
        const g = (o as ThreeObjLike).geometry?.attributes?.position;
        if ((o as ThreeObjLike).type === 'Mesh' && g && g.count === 144) found = true;
      });
      return found;
    },
    undefined,
    { timeout: 15_000 },
  );
  const counts = await meshVertexCounts(page);
  expect(counts).toContain(144);
});
