// #1317 — a project saved with a plain model on the clone road loads as native geometry, drawn where
// and how the clone drew it; one the native reader refuses loads as it was saved, and says why.
//
// The project is one saved with the model on the CLONE road, the way every refused file arrived before
// #1053, and moved — recorded (`_recordedSave.ts`), since #1053 retired the clone road's import. It is
// loaded on the resume road (`hydrateLoadedProject`), and what is drawn under the import's root —
// world centre, size, colour, base-colour map — is compared with what the clone drew.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, importRoots } from './_importedMesh';
import { recordedSave, savedTypes, writeRecordedSave } from './_recordedSave';

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
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_three?: {
    getState: () => { scene: { getObjectByName: (n: string) => O3 | undefined } };
  };
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_writeOpfsBytes && w.__basher_three);
  });
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

/** The recorded project loaded on the resume road, as a returning user's browser loads it. */
async function loadRecorded(page: Page, name: string): Promise<string> {
  const saved = recordedSave(`clone-models/${name}`);
  expect(savedTypes(saved)).toContain('GltfAsset');
  await writeRecordedSave(page, saved);
  await page.reload();
  await ready(page);
  return saved.ref;
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
  // Recorded: albedo-textured-quad.gltf staged on the clone road and its import Group moved by
  // [1.5, 0.5, -1].
  // What the clone drew for this staging, read by `drawnImport` on the committed code at `7e659d1d`
  // with the clone renderer still in place (#1053 retired it; the print is in the store at
  // `ref/architecture/1053-clone-goldens.txt`).
  const clone = {
    road: 'clone',
    centre: [1.5, 0.5, -1],
    size: [1, 1, 0],
    color: '#ffffff',
    hasMap: true,
    mapImageOk: true,
  };

  const ref = await loadRecorded(page, 'textured-quad');

  expect((await types(page)).filter((t) => /^Gltf|TransformClip|ClipSelect/.test(t))).toEqual([]);
  expect(await types(page)).toContain('PolyMeshData');
  await expect.poll(async () => (await drawnImport(page)).mapImageOk).toBe(true);
  const native = await drawnImport(page);
  console.log(`P1317 clone (recorded) ${JSON.stringify(clone)} native ${JSON.stringify(native)}`);
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

test('#1317 — a saved clone model the native reader refuses is kept as saved, not drawn, and says why', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Recorded: iridescence-quad.gltf staged on the clone road, not moved.
  const ref = await loadRecorded(page, 'refused-iridescence');

  await expect.poll(async () => (await importRoots(page)).map((r) => r.road)).toEqual(['clone']);
  const row = await notice(page, `model:${ref}`);
  expect(row.label).toBe('model not converted:');
  expect(row.message).toMatch(/KHR_materials_iridescence.*#1123/);
  // #1053 (user decision 2026-09-30): a kept import is not drawn, and the load says so.
  expect(row.message).toContain('is not drawn');
  expect(await drawnImportMeshes(page)).toEqual([]);
  expect(errors).toEqual([]);
});
