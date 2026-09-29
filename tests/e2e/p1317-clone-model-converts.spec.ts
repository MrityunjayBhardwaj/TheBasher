// #1317 — a project saved with a plain model on the clone road loads as native geometry, drawn where
// and how the clone drew it; one the native reader refuses loads as it was saved, and says why.
//
// The model is staged on the CLONE road the way every refused file arrived before #1053
// (`__basher_writeOpfsBytes` + `__basher_importGltf`, which always takes the clone road) and moved.
// What is drawn under its import root is read — world centre, size, colour, base-colour map — then
// the project is saved and reloaded on the resume road (`hydrateLoadedProject`), and the same
// reading is taken again from whatever root the import now has.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, importRoots } from './_importedMesh';

type V3 = [number, number, number];
interface O3 {
  isMesh?: boolean;
  visible: boolean;
  parent: O3 | null;
  geometry?: { computeBoundingBox: () => void; boundingBox: unknown };
  matrixWorld: unknown;
  updateWorldMatrix: (p: boolean, c: boolean) => void;
  traverse: (f: (o: O3) => void) => void;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: unknown }> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_importGltf?: (buf: ArrayBuffer, ref: string) => Promise<unknown>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_three?: {
    getState: () => { scene: { getObjectByName: (n: string) => O3 | undefined } };
  };
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_importGltf && w.__basher_writeOpfsBytes && w.__basher_three);
  });
}

/** Stage `/assets/<file>` on the clone road at `ref`, and move its import Group by `move`. */
async function stageOnCloneRoad(page: Page, file: string, ref: string, move: V3): Promise<void> {
  await page.evaluate(
    async ({ file, ref, move }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(`/assets/${file}`).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
      const dag = w.__basher_dag.getState();
      const [groupId] = Object.entries(dag.state.nodes).find(
        ([, n]) =>
          n.type === 'Group' && Object.values(dag.state.nodes).some((m) => m.type === 'GltfAsset'),
      )!;
      const pos = (dag.state.nodes[groupId].params as { position: number[] }).position;
      dag.dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId: groupId,
            paramPath: 'position',
            value: pos.map((c, k) => c + move[k]),
          },
        ],
        'user',
        'place the model',
      );
    },
    { file, ref, move },
  );
}

/** The world-space centre of everything visibly drawn under `rootId`, and how many meshes. */
async function drawnCentre(page: Page, rootId: string): Promise<{ meshes: number; centre: V3 }> {
  return page.evaluate((id) => {
    const scene = (window as unknown as BasherWindow).__basher_three!.getState().scene;
    const root = scene.getObjectByName(id);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let meshes = 0;
    root?.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      for (let p: O3 | null = o; p; p = p.parent) if (!p.visible) return;
      o.updateWorldMatrix(true, false);
      o.geometry.computeBoundingBox();
      const box = (
        o.geometry.boundingBox as { clone: () => { applyMatrix4: (m: unknown) => unknown } }
      )
        .clone()
        .applyMatrix4(o.matrixWorld) as {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
      };
      meshes++;
      [box.min.x, box.min.y, box.min.z].forEach((v, k) => (min[k] = Math.min(min[k], v)));
      [box.max.x, box.max.y, box.max.z].forEach((v, k) => (max[k] = Math.max(max[k], v)));
    });
    return { meshes, centre: min.map((v, k) => (v + max[k]) / 2) as [number, number, number] };
  }, rootId);
}

/** What is drawn for the one import: where, how big, what colour, whether its map decoded. */
async function drawnImport(page: Page) {
  const roots = await importRoots(page);
  expect(roots, 'exactly one import root').toHaveLength(1);
  const [root] = roots;
  await expect.poll(async () => (await drawnImportMeshes(page, root.rootId)).length).toBe(1);
  const [mesh] = await drawnImportMeshes(page, root.rootId);
  const at = await drawnCentre(page, root.rootId);
  expect(at.meshes, 'meshes the centre was measured over').toBe(1);
  return {
    road: root.road,
    centre: at.centre,
    size: mesh.worldBounds,
    color: mesh.color,
    hasMap: mesh.hasMap,
    mapImageOk: mesh.mapImageOk,
  };
}

async function saveAndReload(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await ready(page);
}

const types = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Object.values((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).map(
      (n) => n.type,
    ),
  );

const notice = (page: Page, key: string) =>
  page.evaluate(async (k) => {
    const m = await import('/src/app/stores/assetErrorStore.ts');
    const s = m.useAssetErrorStore.getState();
    return { message: s.errors[k] ?? null, label: s.labels[k] ?? null };
  }, key);

test.beforeEach(async ({ page }) => {
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
  await ready(page);
});

test('#1317 — a saved clone model loads native, drawn where and how the clone drew it', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ref = 'user-imports/p1317/albedo-textured-quad.gltf';
  await stageOnCloneRoad(page, 'albedo-textured-quad.gltf', ref, [1.5, 0.5, -1]);
  await expect.poll(async () => (await drawnImport(page)).mapImageOk).toBe(true);
  const clone = await drawnImport(page);
  expect(clone.road).toBe('clone');

  await saveAndReload(page);

  expect((await types(page)).filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(await types(page)).toContain('PolyMeshData');
  await expect.poll(async () => (await drawnImport(page)).mapImageOk).toBe(true);
  const native = await drawnImport(page);
  console.log(`P1317 clone ${JSON.stringify(clone)} native ${JSON.stringify(native)}`);
  expect(native.road).toBe('native');
  native.centre.forEach((c, k) => expect(c, `centre axis ${k}`).toBeCloseTo(clone.centre[k], 4));
  native.size.forEach((c, k) => expect(c, `size axis ${k}`).toBeCloseTo(clone.size[k], 4));
  expect(native.color).toBe(clone.color);
  expect(native.hasMap).toBe(true);
  // The model was moved, so an unmoved import drawn at the origin cannot pass for it.
  expect(Math.hypot(...clone.centre)).toBeGreaterThan(1);

  expect(await notice(page, `model:${ref}`)).toEqual({
    message: expect.stringContaining('now loads as native geometry'),
    label: 'model converted:',
  });
  expect(errors).toEqual([]);
});

test('#1317 — a saved clone model the native reader refuses loads as saved, and says why', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ref = 'user-imports/p1317-iridescence/iridescence-quad.gltf';
  await stageOnCloneRoad(page, 'iridescence-quad.gltf', ref, [0, 0, 0]);
  await expect.poll(async () => (await importRoots(page)).map((r) => r.road)).toEqual(['clone']);

  await saveAndReload(page);

  await expect.poll(async () => (await importRoots(page)).map((r) => r.road)).toEqual(['clone']);
  const row = await notice(page, `model:${ref}`);
  expect(row.label).toBe('model not converted:');
  expect(row.message).toMatch(/KHR_materials_iridescence.*#1123/);
  expect(errors).toEqual([]);
});
