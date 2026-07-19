// #209 increment 1 — the Array MODIFIER (epic #201, §5; the SOP / geometry half of
// V58). Observes on the LIVE app (Lokayata) that a geometry modifier wired as a
// Mesh→Mesh sub-chain (Sphere → ArrayModifier → Scene.children) actually rewrites
// the rendered geometry — the viewport shows the MERGED array, not the bare source.
//
// BOUNDARY-PAIR (H40 / V37): the rendered mesh's vertex count (side A — read off
// the three scene) == the resolver's registry-built vertex count (side B —
// __basher_modified_vertex_count, the SAME geometryRegistry instance ModifiedMeshR
// rendered). Equal → the live render consumed the resolver's geometry handle, no
// drift between the render road and the read-side road.
//
// FALSIFICATION (guards a vacuous pass): muting the modifier (the stack
// mute-bypass, V58) collapses the output back to the source's vertex count — so it
// is the operator that produced the extra geometry, not a stray mesh. The active
// count == COUNT × the muted (passthrough) count — asserted as a PAIR so the check
// is primitive-agnostic (the source's own vert count is derived at runtime, never
// hardcoded).
//
// #365 Slice 2: the modifier SOURCE is a fused SphereMesh, not the retired fused
// BoxMesh — a split Object as a modifier target is the undecided #377 path. The
// source's vert count is whatever the sphere builds; the test asserts the array
// RATIO against a runtime-derived passthrough, so it never names a box constant.
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
const COUNT = 3; // 3 copies of the source → COUNT × (source verts) merged

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

/** The modifier's resolver vertex count once it has built (non-null). */
async function modifiedCount(page: import('@playwright/test').Page, id: string): Promise<number> {
  await page.waitForFunction(
    (nid) => (window as unknown as ModWindow).__basher_modified_vertex_count(nid) != null,
    id,
    { timeout: 15_000 },
  );
  return page.evaluate(
    (nid) => (window as unknown as ModWindow).__basher_modified_vertex_count(nid)!,
    id,
  );
}

/** Set a modifier's `muted` and wait for its resolver count to reach `want`. */
async function setMutedAndWait(
  page: import('@playwright/test').Page,
  id: string,
  muted: boolean,
  want: number,
): Promise<void> {
  await page.evaluate(
    ({ nid, m }) => {
      (window as unknown as ModWindow).__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: nid, paramPath: 'muted', value: m }],
          'e2e',
          'mute',
        );
    },
    { nid: id, m: muted },
  );
  await page.waitForFunction(
    ({ nid, w }) => (window as unknown as ModWindow).__basher_modified_vertex_count(nid) === w,
    { nid: id, w: want },
    { timeout: 15_000 },
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
    const w = window as unknown as ModWindow;
    return Boolean(
      w.__basher_dag && w.__basher_three && w.__basher_dag.getState().state.outputs.scene,
    );
  });
});

test('#209 — Sphere → ArrayModifier → Scene renders the MERGED array; render verts == resolver verts (H40)', async ({
  page,
}) => {
  // A fresh sphere (NOT the default scene box), wired through an ArrayModifier into
  // the scene children. The arrayed mesh is the only one with COUNT× the source.
  await page.evaluate(
    ({ box, arr, count }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: box,
            nodeType: 'SphereMesh',
            params: { radius: 0.5, position: [4, 0, 0] },
          },
          {
            type: 'addNode',
            nodeId: arr,
            nodeType: 'ArrayModifier',
            params: { count, offset: [2, 0, 0], muted: false },
          },
          {
            type: 'connect',
            from: { node: box, socket: 'out' },
            to: { node: arr, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: arr, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'sphere → array → scene',
      );
    },
    { box: MBOX, arr: MARR, count: COUNT },
  );

  // Side B (resolver): the registry-built array vertex count = COUNT × (source verts).
  const resolverCount = await modifiedCount(page, MARR);

  // Side A (render): the live viewport contains a mesh with exactly that vertex
  // count → the modifier's geometry actually flowed to the renderer (not the source).
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

  // Derive the source passthrough count at runtime (mute → the bare source) and
  // assert the muted(×1) / unmuted(×COUNT) pair — genuinely arrayed, primitive-agnostic.
  expect(resolverCount % COUNT).toBe(0);
  const src = resolverCount / COUNT;
  await setMutedAndWait(page, MARR, true, src);
  expect(resolverCount).toBe(COUNT * src);
  expect(resolverCount).toBeGreaterThan(src);
});

test('#209 — muting the modifier collapses the output back to the source (falsification)', async ({
  page,
}) => {
  await page.evaluate(
    ({ box, arr, count }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: box,
            nodeType: 'SphereMesh',
            params: { radius: 0.5, position: [4, 0, 0] },
          },
          {
            type: 'addNode',
            nodeId: arr,
            nodeType: 'ArrayModifier',
            params: { count, offset: [2, 0, 0], muted: false },
          },
          {
            type: 'connect',
            from: { node: box, socket: 'out' },
            to: { node: arr, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: arr, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'sphere → array → scene',
      );
    },
    { box: MBOX, arr: MARR, count: COUNT },
  );

  // Active → COUNT × source. Derive the source passthrough by muting.
  const active = await modifiedCount(page, MARR);
  expect(active % COUNT).toBe(0);
  const src = active / COUNT;
  await setMutedAndWait(page, MARR, true, src); // mute → the source passes through
  expect(active).toBe(COUNT * src);

  // No arrayed mesh remains in the live scene — the operator's geometry is gone.
  const counts = await meshVertexCounts(page);
  expect(counts).not.toContain(active);
});

test('#209 — a 2-deep modifier chain renders CUMULATIVELY (array of an array — recursive build)', async ({
  page,
}) => {
  // Sphere → Array(3) → Array(2) → Scene. The OperatorStack sub-chain (§2.2): each
  // modifier operates on the cumulative result below it. The recursive registry
  // build is the risky bit — the outer array must replicate the inner-arrayed
  // geometry, so outer = 2 × inner = 3 × 2 × (source verts).
  const A1 = 'p209_a1';
  const A2 = 'p209_a2';
  await page.evaluate(
    ({ box, a1, a2 }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: box,
            nodeType: 'SphereMesh',
            params: { radius: 0.5, position: [4, 0, 0] },
          },
          {
            type: 'addNode',
            nodeId: a1,
            nodeType: 'ArrayModifier',
            params: { count: 3, offset: [2, 0, 0], muted: false },
          },
          {
            type: 'addNode',
            nodeId: a2,
            nodeType: 'ArrayModifier',
            params: { count: 2, offset: [0, 3, 0], muted: false },
          },
          {
            type: 'connect',
            from: { node: box, socket: 'out' },
            to: { node: a1, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: a1, socket: 'out' },
            to: { node: a2, socket: 'target' },
          },
          {
            type: 'connect',
            from: { node: a2, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'e2e',
        'sphere → array → array → scene',
      );
    },
    { box: MBOX, a1: A1, a2: A2 },
  );

  // Side B: the cumulative multipliers hold — inner = 3 × source, outer = 2 × inner.
  const outer = await modifiedCount(page, A2);
  const inner = await modifiedCount(page, A1);
  expect(outer).toBe(2 * inner); // the outer array doubled the inner-arrayed result

  // Side A: the live render contains that cumulative mesh (boundary-pair holds through the chain).
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
    outer,
    { timeout: 15_000 },
  );
  const counts = await meshVertexCounts(page);
  expect(counts).toContain(outer);

  // Derive the source passthrough (mute the inner array) and pin the full 3 × 2 chain.
  expect(inner % 3).toBe(0);
  const src = inner / 3;
  await setMutedAndWait(page, A1, true, src);
  expect(inner).toBe(3 * src);
  expect(outer).toBe(6 * src);
});
