// #1051 — Apply on a NATIVE nested child keeps it under its parent and every drawn vertex in place.
// Observed on the RENDERED three.js meshes, never on params alone.
//
// The #1108 spec covers the same promise on the clone road, and has to force its file there now
// that a hierarchy imports native. This is the native side of it: the same flat fixture with its
// mesh node wrapped in a turned and lifted parent node, which now arrives as an Object under a Group
// (the file's empty) under the import Group. The import Group is moved, turned and scaled, and the
// child gets a transform of its own (a quaternion, since an imported node is in quaternion mode),
// so every link of the chain is non-identity when Apply runs.
//
// Apply bakes the child's own transform into its mesh in place: the Object keeps its id and its
// parent, its applied parts go to identity, and the drawn vertex set does not move. Re-turning the
// child after Apply moves the drawn mesh 2.02 units, so the vertex read can see a real move.
//
// REF: src/app/animate/dispatchApplyTransform.ts; #1051, #1108.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { importRoots, importedMeshes } from './_importedMesh';

type Tuple3 = [number, number, number];
interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface GraphNode {
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, { node: string } | { node: string }[]>;
}
interface O3 {
  isMesh?: boolean;
  visible: boolean;
  parent: O3 | null;
  traverse: (fn: (o: O3) => void) => void;
  updateWorldMatrix: (parents: boolean, children: boolean) => void;
  matrixWorld: { elements: number[] };
  geometry: {
    getAttribute: (n: string) => {
      count: number;
      getX: (i: number) => number;
      getY: (i: number) => number;
      getZ: (i: number) => number;
    };
  };
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, GraphNode> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => unknown;
    };
  };
  __basher_three?: {
    getState: () => { scene: { getObjectByName: (n: string) => O3 | undefined } };
  };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<IngestFileShape>,
    folderName: string,
  ) => Promise<string>;
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
  // The scene too, not only the store: under load the store exists before the canvas mounts, and a
  // read in that window found no scene at all.
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_dag && w.__basher_ingestGltfFolder && w.__basher_three?.getState().scene,
    );
  });
}

/** The flat fixture with its mesh node under a parent node turned -90° about X and lifted by 2. */
async function ingestHierarchy(page: Page, folderName: string): Promise<void> {
  await page.evaluate(async (name) => {
    const w = window as unknown as BasherWindow;
    const base = '/fixtures/multifile/flat/';
    const gltf = (await fetch(`${base}scene.gltf`).then((r) => r.json())) as {
      nodes: Record<string, unknown>[];
      scenes: { nodes: number[] }[];
      extensionsUsed?: string[];
    };
    const meshNode = gltf.scenes[0].nodes[0];
    gltf.nodes.push({
      name: 'p1051_parent',
      translation: [0, 2, 0],
      rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      children: [meshNode],
    });
    gltf.scenes[0].nodes = [gltf.nodes.length - 1];
    const bytes = async (file: string) =>
      new Uint8Array((await fetch(`${base}${file}`).then((r) => r.arrayBuffer())) as ArrayBuffer);
    await w.__basher_ingestGltfFolder!(
      [
        { relativePath: 'scene.gltf', bytes: new TextEncoder().encode(JSON.stringify(gltf)) },
        { relativePath: 'scene.bin', bytes: await bytes('scene.bin') },
        { relativePath: 'texture.png', bytes: await bytes('texture.png') },
      ],
      name,
    );
  }, folderName);
}

/** Every visible mesh drawn under `rootId`, as world-space vertex lists. Empty while no scene is
 *  mounted, so a poll waits for one instead of aborting on the read. */
async function drawnUnder(page: Page, rootId: string): Promise<Tuple3[][]> {
  return page.evaluate((id) => {
    const scene = (window as unknown as BasherWindow).__basher_three!.getState().scene;
    const root = scene?.getObjectByName(id);
    const out: [number, number, number][][] = [];
    if (!root) return out;
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (let p: O3 | null = o; p; p = p.parent) if (!p.visible) return;
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements;
      const pos = o.geometry.getAttribute('position');
      const points: [number, number, number][] = [];
      for (let i = 0; i < pos.count; i++) {
        const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        points.push([
          e[0] * x + e[4] * y + e[8] * z + e[12],
          e[1] * x + e[5] * y + e[9] * z + e[13],
          e[2] * x + e[6] * y + e[10] * z + e[14],
        ]);
      }
      out.push(points);
    });
    return out;
  }, rootId);
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

/** Who holds `id` through any input edge. */
const holdersOf = (page: Page, id: string) =>
  page.evaluate((nodeId) => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    return Object.entries(nodes)
      .filter(([, n]) =>
        Object.values(n.inputs ?? {})
          .flat()
          .some((e) => (e as { node?: string } | undefined)?.node === nodeId),
      )
      .map(([key]) => key);
  }, id);

const TURN: [number, number, number, number] = [0.24185, 0.24185, 0, 0.93969]; // 28° about (1,1,0)

const paramsOf = (page: Page, id: string) =>
  page.evaluate((nid) => {
    const p = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[nid].params;
    return {
      position: p.position as Tuple3,
      quaternion: p.quaternion as [number, number, number, number],
      scale: p.scale as Tuple3,
    };
  }, id);

for (const mask of ['all', 'location'] as const) {
  test(`#1051 — Apply ${mask} on a native nested child keeps it drawn in place, under its parent`, async ({
    page,
  }) => {
    test.slow(); // an import, a textured draw, and a bake
    await openFresh(page);
    await ingestHierarchy(page, `p1051-apply-${mask}`);

    await expect.poll(async () => (await importRoots(page)).length, { timeout: 20_000 }).toBe(1);
    const [root] = await importRoots(page);
    // The subject is the native road; a file that fell back to the clone would measure #1108 again.
    expect(root.road).toBe('native');
    const child = (await importedMeshes(page)).find((m) => m.rootId === root.rootId);
    expect(child, 'the import holds a mesh child').toBeTruthy();
    const [parent] = await holdersOf(page, child!.objectId);
    expect(parent, "the child hangs under the file's empty, not the import Group").not.toBe(
      root.rootId,
    );

    const pivot = await page.evaluate(
      (id) =>
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id].params
          .pivot as Tuple3,
      root.rootId,
    );
    await page.evaluate(
      ({ id, p, childId, turn }) => {
        (window as unknown as BasherWindow).__basher_dag!.getState().dispatchAtomic(
          [
            {
              type: 'setParam',
              nodeId: id,
              paramPath: 'position',
              value: [p[0] + 3, p[1] + 1, p[2]],
            },
            { type: 'setParam', nodeId: id, paramPath: 'rotation', value: [0, 0, 40] },
            { type: 'setParam', nodeId: id, paramPath: 'scale', value: [1.5, 1.5, 1.5] },
            { type: 'setParam', nodeId: childId, paramPath: 'position', value: [0.5, -0.25, 0.75] },
            { type: 'setParam', nodeId: childId, paramPath: 'quaternion', value: turn },
            { type: 'setParam', nodeId: childId, paramPath: 'scale', value: [1.25, 0.8, 1.1] },
          ],
          'e2e',
          'p1051 move import and child',
        );
      },
      { id: root.rootId, p: pivot, childId: child!.objectId, turn: TURN },
    );

    await expect
      .poll(async () => (await drawnUnder(page, root.rootId)).length, { timeout: 20_000 })
      .toBe(1);
    const [before] = await drawnUnder(page, root.rootId);
    expect(before.length).toBeGreaterThan(0);

    const result = await page.evaluate(
      async ({ id, m }) => {
        const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
        return (await mod.dispatchApplyTransform(id, m)) as {
          ok: boolean;
          bakedId?: string;
          reason?: string;
        };
      },
      { id: child!.objectId, m: mask },
    );
    expect(result.ok, result.reason).toBe(true);

    // Baked in place: the same Object, under the same parent.
    expect(result.bakedId).toBe(child!.objectId);
    expect(await holdersOf(page, result.bakedId!)).toEqual([parent]);
    const after = await paramsOf(page, result.bakedId!);
    expect(after.position).toEqual([0, 0, 0]);
    if (mask === 'all') {
      expect(after.quaternion).toEqual([0, 0, 0, 1]);
      expect(after.scale).toEqual([1, 1, 1]);
    } else {
      expect(after.quaternion).toEqual(TURN);
      expect(after.scale).toEqual([1.25, 0.8, 1.1]);
    }

    await expect
      .poll(
        async () => {
          const meshes = await drawnUnder(page, root.rootId);
          return meshes.length === 1 && meshes[0].length === before.length;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const [drawn] = await drawnUnder(page, root.rootId);
    expect(setDistance(before, drawn)).toBeLessThan(1e-3);
  });
}
