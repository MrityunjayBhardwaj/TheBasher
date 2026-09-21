// p1051 — a nested file imports native, and the parent MOVES the child on screen.
//
// `nested-cube.gltf` is the cube at (1, 0, 0) under an empty at (0, 3, 0). Before #1051 the native
// road refused the file whole for its nesting, and the clone road kept the parent chain inside
// three.js where nothing native could read it.
//
// The claim is read off the LIVE drawn mesh, not off the graph: it has to sit at (1, 3, 0), its own
// offset plus its parent's. Drop the parent edge and it draws at (1, 0, 0) — measured, by doing
// exactly that. The graph assertions above it say WHICH road carried the file; only this one says
// the parent moved anything.
//
// REF: src/core/import/nativeGltfImport.ts (the parent edges and the empty→Group rule),
//      Blender `io_scene_gltf2/blender/imp/node.py:84-88,105-108`; issues #1051, #1054, #1152.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            id: string;
            type: string;
            params: Record<string, unknown>;
            inputs: Record<string, { node: string } | { node: string }[]>;
          }
        >;
        outputs: { scene?: unknown };
      };
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_opfs?: { exists: (path: string) => Promise<boolean> };
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_three?.getState().scene &&
        w.__basher_ingestGltfFolder,
      );
    },
    { timeout: 20_000 },
  );
}

/** The import's shape, read through the graph's own edges rather than re-derived from a hash. */
async function imported(page: Page) {
  return page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag!.getState().state.nodes;
    const all = Object.values(nodes);
    const childrenOf = (id: string) => {
      const kids = all.find((n) => n.id === id)?.inputs.children;
      return Array.isArray(kids) ? kids.map((k) => k.node) : [];
    };
    const data = all.filter((n) => n.type === 'PolyMeshData');
    const object = all.find(
      (n) =>
        n.type === 'Object' &&
        !Array.isArray(n.inputs.data) &&
        data.some((d) => d.id === (n.inputs.data as { node: string } | undefined)?.node),
    );
    // The child's parent is whoever holds it as a child; the import Group is that node's parent.
    const parent = object ? all.find((n) => childrenOf(n.id).includes(object.id)) : undefined;
    const importGroup = parent ? all.find((n) => childrenOf(n.id).includes(parent.id)) : undefined;
    return {
      objectId: object?.id ?? null,
      parentId: parent?.id ?? null,
      parentType: parent?.type ?? null,
      parentParams: (parent?.params ?? {}) as { position?: number[] },
      importGroupId: importGroup?.id ?? null,
      gltfNodes: all.filter((n) => n.type === 'GltfData' || n.type === 'GltfAsset').length,
    };
  });
}

/**
 * Where three actually draws the one mesh under `groupId`, in world space.
 *
 * Found by walking the import Group rather than by node id: only a TOP-LEVEL scene child carries
 * its node id on the drawn object (`SceneFromDAG.tsx:2038`), so a nested object has no name to look
 * up. That is #1075, and it is why a click inside an import selects the whole import — a gap this
 * change neither creates nor closes.
 */
async function drawnMeshWorld(page: Page, groupId: string): Promise<number[] | null> {
  return page.evaluate((id) => {
    type O3 = {
      isMesh?: boolean;
      name?: string;
      matrixWorld: { elements: number[] };
      traverse: (f: (o: O3) => void) => void;
    };
    const scene = (window as unknown as W).__basher_three!.getState().scene as unknown as {
      getObjectByName: (n: string) => O3 | undefined;
      updateMatrixWorld: (force?: boolean) => void;
    };
    scene.updateMatrixWorld(true);
    const group = scene.getObjectByName(id);
    if (!group) return null;
    let found: number[] | null = null;
    group.traverse((o) => {
      if (!o.isMesh || found) return;
      const e = o.matrixWorld.elements;
      found = [e[12], e[13], e[14]];
    });
    return found;
  }, groupId);
}

test('#1051 — a cube under an empty imports native, and the empty moves it', async ({ page }) => {
  test.slow(); // an ingest, a hierarchy, and reads off the live scene
  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('basher', { recursive: true });
    } catch {
      /* not present */
    }
  });
  await page.reload();
  await waitForEditor(page);

  await page.evaluate(async () => {
    const w = window as unknown as W;
    const bytes = new Uint8Array(
      await fetch('/assets/nested-cube.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder!([{ relativePath: 'nested-cube.gltf', bytes }], 'p1051');
  });

  await expect.poll(async () => (await imported(page)).objectId).not.toBeNull();
  const shape = await imported(page);
  // Native, not the clone road: nothing in the graph reads the file.
  expect(shape.gltfNodes, 'the file is not read by anything after import').toBe(0);
  // The empty is a Group carrying the file's own transform (Blender writes an Empty here).
  expect(shape.parentType).toBe('Group');
  expect(shape.parentParams.position).toEqual([0, 3, 0]);
  expect(shape.importGroupId, 'the empty hangs under the import Group').not.toBeNull();

  // THE POINT, read off the drawn mesh: the file puts the cube at (1, 0, 0) inside an empty at
  // (0, 3, 0), so it draws at (1, 3, 0). Drop the parent edge and it draws at (1, 0, 0) — the y is
  // the parent, and it is the whole difference between a hierarchy and a flat list.
  const world = await drawnMeshWorld(page, shape.importGroupId!);
  expect(world, 'the imported cube is drawn').not.toBeNull();
  for (const [axis, expected] of [
    [0, 1],
    [1, 3],
    [2, 0],
  ] as const) {
    expect(world![axis], `the drawn cube on axis ${axis}`).toBeCloseTo(expected, 6);
  }

  // And the outliner calls them what the file calls them (#1137's rule, now for the empty too).
  await expect(page.getByTestId('layout')).toContainText('Pivot');
  await expect(page.getByTestId('layout')).toContainText('Cube');
});
