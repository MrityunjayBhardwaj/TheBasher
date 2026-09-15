// #1108 — Apply on an imported child keeps it under the import it drew under, and keeps every drawn
// vertex where it was. Observed on the RENDERED three.js meshes, never on params.
//
// ── THE DEFECT THIS PINS ────────────────────────────────────────────────────────────────
//
// The bake wired the baked Object into the scene root with only the child's own pose, so everything
// above the child — the import's Group and the glTF parent nodes inside the clone — was dropped and
// the mesh jumped. Blender keeps an applied child under its parent with the world shape unchanged.
//
// ── THE SUBJECT ─────────────────────────────────────────────────────────────────────────
//
// The flat multi-file fixture, with its one mesh node wrapped in a turned and lifted parent node, so
// the file has a hierarchy. A hierarchy is what the native reader refuses, so the import takes the
// clone road — the road this defect lives on — and the spec asserts that it did. The import Group is
// then moved, turned and scaled, so both halves of the chain are non-identity when Apply runs.
//
// ── WHAT IS OBSERVED ────────────────────────────────────────────────────────────────────
//
// Every visible mesh drawn under the import root, in world space, before and after Apply. Before
// there is exactly one (the clone's child); after there is exactly one (the baked Object, now a
// child of the import Group) and its vertex SET matches. A bake that went to the scene root leaves
// nothing visible under the import root, so the read reds rather than passing on an empty set.
//
// REF: src/app/animate/dispatchApplyTransform.ts (`importedChildPlacement`); #1108.

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
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_ingestGltfFolder && w.__basher_three);
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
    };
    const meshNode = gltf.scenes[0].nodes[0];
    gltf.nodes.push({
      name: 'p1108_parent',
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

/** Every visible mesh drawn under `rootId`, as world-space vertex lists. */
async function drawnUnder(page: Page, rootId: string): Promise<Tuple3[][]> {
  return page.evaluate((id) => {
    const scene = (window as unknown as BasherWindow).__basher_three!.getState().scene;
    const root = scene.getObjectByName(id);
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

for (const mask of ['all', 'location'] as const) {
  test(`#1108 — Apply ${mask} on a child of a moved, hierarchical import keeps it drawn in place, under the import`, async ({
    page,
  }) => {
    test.slow(); // an import through the clone road, a textured draw, and a bake written to OPFS
    await openFresh(page);
    await ingestHierarchy(page, `p1108-${mask}`);

    await expect.poll(async () => (await importRoots(page)).length, { timeout: 20_000 }).toBe(1);
    const [root] = await importRoots(page);
    // The subject is the clone road; a file that silently arrived native would measure nothing.
    expect(root.road).toBe('clone');
    const child = (await importedMeshes(page)).find((m) => m.rootId === root.rootId);
    expect(child, 'the import holds a mesh child').toBeTruthy();

    // Move, turn and scale the import about the pivot it was given, so the Group is not identity.
    const pivot = await page.evaluate(
      (id) =>
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id].params
          .pivot as Tuple3,
      root.rootId,
    );
    await page.evaluate(
      ({ id, p }) => {
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
          ],
          'e2e',
          'p1108 move import',
        );
      },
      { id: root.rootId, p: pivot },
    );

    // Positive control: exactly one mesh draws under the import, and it is not at the origin.
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

    // The baked Object is a child of the import Group, not of the scene.
    expect(await holdersOf(page, result.bakedId!)).toEqual([root.rootId]);

    // …and it draws, under the import, with every vertex where the child drew it.
    await expect
      .poll(
        async () => {
          const meshes = await drawnUnder(page, root.rootId);
          return meshes.length === 1 && meshes[0].length === before.length;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const [after] = await drawnUnder(page, root.rootId);
    const distance = setDistance(before, after);
    console.log(`P1108 ${mask} drawn vertex-set distance = ${distance}`);
    expect(distance).toBeLessThan(1e-3);
  });
}
