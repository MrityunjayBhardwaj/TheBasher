// #209 — the Mirror MODIFIER (epic #201, §5; the SECOND geometry operator, V58).
// Observes on the LIVE app (Lokayata) that Mirror, like Array, wires as a Mesh→Mesh
// sub-chain (Sphere → MirrorModifier → Scene.children) and actually rewrites the
// rendered geometry — the viewport shows the merged source+reflection (2× verts),
// not the bare source.
//
// BOUNDARY-PAIR (H40 / V37): the rendered mesh's vertex count (side A — read off the
// three scene) == the resolver's registry-built count (side B —
// __basher_modified_vertex_count, the SAME geometryRegistry instance ModifiedMeshR
// rendered). Equal → the live render consumed the resolver's geometry handle, no
// drift between the render road and the read-side road.
//
// FALSIFICATION: muting the modifier (the stack mute-bypass, V58) collapses the
// output back to the source's vertex count — so it is the operator that produced the
// extra geometry, not a stray mesh. Asserted as the muted(×1) / unmuted(×2) PAIR so
// the check is primitive-agnostic (the source's vert count is derived at runtime).
//
// COMPOSITION: a MIXED chain Sphere → Array(3) → Mirror renders cumulatively (3 ×
// source, then mirrored = 6 × source) — proving the substrate composes ACROSS
// modifier types, not just Array-of-Array. The recursive registry build is the risky bit.
//
// #462: the modifier SOURCE is a SPLIT sphere — an Object posed over a SphereData. It
// was a fused `SphereMesh` (put there by #365 Slice 2, when a split Object as a modifier
// target was the still-undecided #377 path), and that node's `evaluate` has thrown since
// the sphere split, so these cases failed rather than testing anything. #377 decided it:
// the stack attaches to the OBJECT and evaluates over its data — `modifierSource`
// (src/app/modifierGeometry.ts:120) reaches through the `data` socket for geometry and
// material while inheriting the Object's TRS — so `object.out → modifier.target` is the
// shape a user actually has.
//
// It stays a SPHERE rather than moving to the split cube because the render-side check
// locates the mirrored mesh by a vertex COUNT that has to be unique in a starter scene
// carrying thousands of verts: ~425 × 2 is distinctive, a cube's 24 × 2 is not (H180 —
// the measurement instrument is part of the fixture). The assertions remain RATIOS
// against a runtime-derived passthrough, so they never name a primitive constant.
//
// REF: src/nodes/MirrorModifier.ts; src/app/modifierGeometry.ts;
//      src/app/geometryRegistry.ts (build 'mirror' + reverseWinding);
//      src/viewport/SceneFromDAG.tsx (ModifiedMeshR); vyapti V58/V37; H40/H111; #462.

import { expect, test } from './_fixtures';
import { splitSphereOps } from './_splitSphere';

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

/** The modifier's source: a split sphere at x=4, well clear of the starter scene. The
 *  Object (`MBOX`) is what the modifier's `target` socket takes; the SphereData behind it
 *  carries the geometry the modifier reshapes. */
const sphereSource = () => splitSphereOps({ objectId: MBOX, position: [4, 0, 0] });

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

test('#209 — Sphere → MirrorModifier → Scene renders the MERGED mirror; render verts == resolver verts (H40)', async ({
  page,
}) => {
  await page.evaluate(
    ({ box, mir, ops }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(ops as Op[]),
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
        'sphere → mirror → scene',
      );
    },
    { box: MBOX, mir: MMIR, ops: sphereSource() },
  );

  // Side B (resolver): the registry-built mirror = source + reflection = 2 × source.
  const resolverCount = await modifiedCount(page, MMIR);

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

  // Derive the source passthrough at runtime (mute → the bare source) and assert the
  // muted(×1) / unmuted(×2) pair — genuinely mirrored, primitive-agnostic.
  expect(resolverCount % 2).toBe(0);
  const src = resolverCount / 2;
  await setMutedAndWait(page, MMIR, true, src);
  expect(resolverCount).toBe(2 * src);
  expect(resolverCount).toBeGreaterThan(src);
});

test('#209 — muting the Mirror collapses the output back to the source (falsification)', async ({
  page,
}) => {
  await page.evaluate(
    ({ box, mir, ops }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(ops as Op[]),
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
        'sphere → mirror → scene',
      );
    },
    { box: MBOX, mir: MMIR, ops: sphereSource() },
  );

  // Active → 2 × source. Derive the source passthrough by muting.
  const active = await modifiedCount(page, MMIR);
  expect(active % 2).toBe(0);
  const src = active / 2;
  await setMutedAndWait(page, MMIR, true, src); // mute → the source passes through
  expect(active).toBe(2 * src);

  const counts = await meshVertexCounts(page);
  expect(counts).not.toContain(active); // the mirrored geometry is gone
});

test('#209 — a MIXED chain Sphere → Array(3) → Mirror composes (3× → 6× — cross-modifier recursive build)', async ({
  page,
}) => {
  const ARR = 'p209m_arr';
  await page.evaluate(
    ({ box, arr, mir, ops }) => {
      const w = window as unknown as ModWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          ...(ops as Op[]),
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
        'sphere → array → mirror → scene',
      );
    },
    { box: MBOX, arr: ARR, mir: MMIR, ops: sphereSource() },
  );

  // Side B: array (3 × source) then mirror (× 2) at the top of the chain.
  const top = await modifiedCount(page, MMIR);
  const arrCount = await modifiedCount(page, ARR);
  expect(top).toBe(2 * arrCount); // the mirror doubled the arrayed result

  // Side A: the live render contains that cumulative mesh (boundary-pair through the mixed chain).
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
    top,
    { timeout: 15_000 },
  );
  const counts = await meshVertexCounts(page);
  expect(counts).toContain(top);

  // Derive the source passthrough (mute the array) and pin the full 3 × 2 chain.
  expect(arrCount % 3).toBe(0);
  const src = arrCount / 3;
  await setMutedAndWait(page, ARR, true, src);
  expect(arrCount).toBe(3 * src);
  expect(top).toBe(6 * src);
});
