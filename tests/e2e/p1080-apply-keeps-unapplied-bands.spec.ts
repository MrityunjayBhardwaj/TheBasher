// #1080 — a single-band Apply keeps the drawn shape and every band it did not apply, and a mirrored
// bake does not draw inside-out. Observed on the RENDERED three.js mesh, not the resolver.
//
// ── THE DEFECTS THIS PINS ───────────────────────────────────────────────────────────────
//
// The bake put only the applied band into the verts and reset all three bands on the Object, so
// Apply Location, Rotation or Scale alone moved and reshaped the object. And a mirrored pose baked
// under an identity Object kept its winding while three stopped flipping the front face for it,
// so every face drew inside-out.
//
// ── WHAT IS OBSERVED ────────────────────────────────────────────────────────────────────
//
// For each subject, before and after Apply, read off the drawn mesh in the live scene: every vertex
// in world space (the geometry under the mesh's world matrix), and how many triangles face inward
// as drawn (world winding XOR a mirroring world matrix, which is when three flips the front face).
// The vertex SETS are compared rather than the order, because the drawn geometry before Apply and
// the baked geometry loaded back after it are different buffers.
//
// The pose is sheared on purpose — a rotation under a non-uniform scale that stays on the Object —
// because that is the case baking the applied band alone cannot keep at all.
//
// REF: src/app/animate/dispatchApplyTransform.ts (`splitAppliedPose`, `reverseTriangleWinding`);
//      src/viewport/SceneFromDAG.tsx (`__basher_mesh_world_bounds` — the same mesh lookup); #1080.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

type Tuple3 = [number, number, number];
interface Pose {
  position: Tuple3;
  rotation: Tuple3;
  scale: Tuple3;
}
interface GraphNode {
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, { node: string } | { node: string }[]>;
}
interface Mesh3 {
  isMesh?: boolean;
  traverse: (fn: (o: Mesh3) => void) => void;
  updateWorldMatrix: (parents: boolean, children: boolean) => void;
  matrixWorld: { elements: number[]; determinant: () => number };
  geometry: {
    getAttribute: (n: string) => {
      count: number;
      getX: (i: number) => number;
      getY: (i: number) => number;
      getZ: (i: number) => number;
    };
    getIndex: () => { count: number; getX: (i: number) => number } | null;
  };
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, GraphNode>; outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => unknown;
    };
  };
  __basher_three?: {
    getState: () => { scene: { getObjectByName: (n: string) => Mesh3 | undefined } };
  };
}

interface Drawn {
  points: Tuple3[];
  inward: number;
  triangles: number;
}

async function openFresh(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene && w.__basher_three?.getState().scene,
      );
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** A split cube posed at `pose`, wired into the scene under `id`. */
async function seedCube(page: Page, id: string, pose: Pose): Promise<void> {
  await page.evaluate(
    ({ objectId, p }) => {
      const dag = (window as unknown as BasherWindow).__basher_dag!.getState();
      const scene = dag.state.outputs.scene!.node;
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: `${objectId}_data`,
            nodeType: 'BoxData',
            params: { size: [1, 1, 1] },
          },
          { type: 'addNode', nodeId: objectId, nodeType: 'Object', params: p },
          {
            type: 'connect',
            from: { node: `${objectId}_data`, socket: 'out' },
            to: { node: objectId, socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: objectId, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
        ],
        'e2e',
        `p1080 seed ${objectId}`,
      );
    },
    { objectId: id, p: pose },
  );
}

/** The drawn mesh under `id`, read off the live scene, or null while it is not drawn. */
async function drawn(page: Page, id: string): Promise<Drawn | null> {
  return page.evaluate((nodeId) => {
    const scene = (window as unknown as BasherWindow).__basher_three!.getState().scene;
    const grp = scene.getObjectByName(nodeId);
    if (!grp) return null;
    let mesh: Mesh3 | null = null;
    grp.traverse((o) => {
      if (!mesh && o.isMesh) mesh = o;
    });
    if (!mesh) return null;
    const m: Mesh3 = mesh;
    m.updateWorldMatrix(true, false);
    const e = m.matrixWorld.elements;
    const pos = m.geometry.getAttribute('position');
    const points: [number, number, number][] = [];
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      points.push([
        e[0] * x + e[4] * y + e[8] * z + e[12],
        e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14],
      ]);
    }
    const mirrors = m.matrixWorld.determinant() < 0;
    const centre = points
      .reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0])
      .map((v) => v / points.length);
    const index = m.geometry.getIndex();
    const corners = index ? index.count : points.length;
    let inward = 0;
    let triangles = 0;
    for (let i = 0; i + 2 < corners; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => points[index ? index.getX(i + k) : i + k]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-12) continue;
      triangles++;
      const out = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3 - centre[k]);
      const facesIn = n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0;
      if (facesIn !== mirrors) inward++;
    }
    return { points, inward, triangles };
  }, id);
}

/** Largest distance between two vertex SETS, matched after a lexicographic sort. */
function setDistance(a: Tuple3[], b: Tuple3[]): number {
  const key = (p: Tuple3) => p.map((v) => v.toFixed(3)).join(',');
  const sort = (s: Tuple3[]) =>
    [...s].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  const [sa, sb] = [sort(a), sort(b)];
  return Math.max(
    ...sa.map((p, i) => Math.hypot(p[0] - sb[i][0], p[1] - sb[i][1], p[2] - sb[i][2])),
  );
}

async function applyMask(
  page: Page,
  id: string,
  mask: string,
): Promise<{ ok: boolean; reason?: string }> {
  return page.evaluate(
    async ({ nodeId, m }) => {
      const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
      return (await mod.dispatchApplyTransform(nodeId, m)) as { ok: boolean; reason?: string };
    },
    { nodeId: id, m: mask },
  );
}

/** Wait until `id` poses a BakedData and the baked mesh is drawn. */
async function waitForBake(page: Page, id: string): Promise<void> {
  await page.waitForFunction(
    (nodeId) => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      const d = (nodes[nodeId]?.inputs.data as { node: string } | undefined)?.node;
      return !!d && nodes[d]?.type === 'BakedData';
    },
    id,
    { timeout: 15_000 },
  );
  await expect
    .poll(async () => (await drawn(page, id))?.points.length ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0);
}

const SHEARED: Pose = { position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 1, 0.5] };
const IDENTITY: Pose = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const BAND: Record<string, keyof Pose> = {
  location: 'position',
  rotation: 'rotation',
  scale: 'scale',
};

test('#1080 — Location, Rotation and Scale alone keep the drawn shape and the other bands', async ({
  page,
}) => {
  test.slow(); // three bakes and a mirrored one, each awaited through its OPFS write and reload
  await openFresh(page);

  for (const mask of ['location', 'rotation', 'scale']) {
    const id = `p1080_${mask}`;
    await seedCube(page, id, SHEARED);
    await expect
      .poll(async () => (await drawn(page, id))?.points.length ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const before = (await drawn(page, id))!;
    expect(before.inward, `${mask}: the posed cube draws outward before Apply`).toBe(0);

    const result = await applyMask(page, id, mask);
    expect(result, `${mask}: Apply`).toEqual({ ok: true, bakedId: id });
    await waitForBake(page, id);
    const after = (await drawn(page, id))!;

    const pose = await page.evaluate(
      (nodeId) =>
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[nodeId].params,
      id,
    );
    for (const band of ['position', 'rotation', 'scale'] as const) {
      expect(pose[band], `${mask}: ${band} after Apply`).toEqual(
        BAND[mask] === band ? IDENTITY[band] : SHEARED[band],
      );
    }
    expect(after.points.length, `${mask}: same vertex count drawn`).toBe(before.points.length);
    expect(
      setDistance(before.points, after.points),
      `${mask}: every vertex draws where it did`,
    ).toBeLessThan(1e-3);
    expect(after.inward, `${mask}: no face inside-out after Apply`).toBe(0);
  }

  // A mirror, baked whole: the Object stops carrying the mirror, so the winding has to reverse.
  const mirrored: Pose = { position: [1, 0, 0], rotation: [0, 0, 30], scale: [-1, 1, 1] };
  await seedCube(page, 'p1080_mirror', mirrored);
  await expect
    .poll(async () => (await drawn(page, 'p1080_mirror'))?.points.length ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const beforeMirror = (await drawn(page, 'p1080_mirror'))!;
  expect(beforeMirror.inward, 'the mirrored cube draws outward before Apply').toBe(0);
  expect(await applyMask(page, 'p1080_mirror', 'all')).toEqual({
    ok: true,
    bakedId: 'p1080_mirror',
  });
  await waitForBake(page, 'p1080_mirror');
  const afterMirror = (await drawn(page, 'p1080_mirror'))!;
  expect(
    setDistance(beforeMirror.points, afterMirror.points),
    'mirrored: same drawn shape',
  ).toBeLessThan(1e-3);
  expect(afterMirror.inward, 'mirrored: no face inside-out after Apply All').toBe(0);

  // #489 — a baked mesh draws its OWN scale. The renderer used to pin it to [1,1,1], so the
  // scale row edited the params and nothing moved on screen. A kept Scale band above already
  // depends on this; here it is asked directly, on a mesh Apply All left at identity.
  const grownBefore = (await drawn(page, 'p1080_mirror'))!;
  await page.evaluate(() => {
    (window as unknown as BasherWindow)
      .__basher_dag!.getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: 'p1080_mirror', paramPath: 'scale', value: [2, 1, 0.5] }],
        'e2e',
        'p1080 scale a baked mesh',
      );
  });
  // Every drawn vertex, scaled about the Object's origin, is exactly where it should now draw.
  const expected = grownBefore.points.map(
    ([x, y, z]) => [x * 2, y * 1, z * 0.5] as [number, number, number],
  );
  await expect
    .poll(async () => setDistance(expected, (await drawn(page, 'p1080_mirror'))!.points), {
      timeout: 10_000,
    })
    .toBeLessThan(1e-3);
  expect((await drawn(page, 'p1080_mirror'))!.inward, 'a scaled baked mesh draws outward').toBe(0);
});
