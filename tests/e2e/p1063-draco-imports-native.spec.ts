// #1063 — a Draco-compressed file arrives as native geometry through the product's import door,
// and draws what the clone road draws from the same file.
//
// The native reader decodes each compressed primitive into ordinary accessors before it reads one,
// as Blender's importer does (`gltfDraco.ts`), using three's DRACOLoader worker at the self-hosted
// `/draco/` path (`dracoDecoder.ts`) — the decoder the clone road already reads this file with. So
// the clone road's draw of the same file is the reference: same size, same material. And since a
// native import holds its mesh in the project, deleting the source file and reloading changes
// nothing.
//
// REF: src/core/import/gltfDraco.ts; src/app/asset/dracoDecoder.ts; issue #1063.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { ingestOnCloneRoad } from './_cloneRoadImport';
import { drawnImportMeshes, importedMeshes } from './_importedMesh';

interface BasherWindow {
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_opfs?: { exists: (p: string) => Promise<boolean>; delete: (p: string) => Promise<void> };
  __basher_mesh_world_bounds?: (nodeId: string) => [number, number, number] | null;
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return (
        !!w.__basher_ingestGltfFolder &&
        !!w.__basher_opfs &&
        w.__basher_mesh_world_bounds?.('n_box') != null
      );
    },
    null,
    { timeout: 20_000 },
  );
}

/** What each road's import draws: size and material, rounded past Draco's quantization. */
async function drawn(page: Page, rootId: string) {
  const [mesh] = await drawnImportMeshes(page, rootId);
  if (!mesh) return null;
  return {
    size: mesh.worldBounds.map((v) => Number(v.toFixed(3))),
    color: mesh.color,
    metalness: mesh.metalness,
    roughness: mesh.roughness,
  };
}

test('#1063 — a Draco file imports native and draws what the clone road draws', async ({
  page,
}) => {
  test.slow(); // two imports, a save and a reload, each observed
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /DRACO|Draco|GLTFLoader/.test(m.text())) errors.push(m.text());
  });
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

  // The product door: the same one the drop zone and the file picker call.
  const entry = await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    return (window as unknown as BasherWindow).__basher_ingestGltfFolder!(
      [{ relativePath: 'cube-draco.glb', bytes }],
      'p1063',
    );
  });
  await expect
    .poll(async () => (await importedMeshes(page)).map((m) => m.road))
    .toEqual(['native']);
  const nativeRoot = (await importedMeshes(page))[0].rootId;
  await expect.poll(() => drawn(page, nativeRoot)).not.toBeNull();
  const native = await drawn(page, nativeRoot);

  // The reference: the clone road's draw of the same bytes.
  await ingestOnCloneRoad(page, 'cube-draco.glb', 'p1063-clone');
  await expect
    .poll(async () => (await importedMeshes(page)).map((m) => m.road).sort())
    .toEqual(['clone', 'native']);
  const cloneRoot = (await importedMeshes(page)).find((m) => m.road === 'clone')!.rootId;
  // Same material; the size differs only in what each road measures. The decoded vertices sit at
  // ±0.5 on both roads (the unit decode reads exactly 0.5), and the native mesh's box is its
  // vertices. GLTFLoader sizes the clone's primitive from the accessor's DECLARED min/max
  // (`computeBounds`, GLTFLoader.js), which this file's encoder wrote as ±0.50049.
  expect(native!.size).toEqual([1, 1, 1]);
  await expect
    .poll(() => drawn(page, cloneRoot))
    .toEqual({ ...native, size: [1.001, 1.001, 1.001] });

  // The mesh is the project's own: delete the source file, save, reload — it still draws the same.
  await page.evaluate((p) => (window as unknown as BasherWindow).__basher_opfs!.delete(p), entry);
  expect(
    await page.evaluate((p) => (window as unknown as BasherWindow).__basher_opfs!.exists(p), entry),
  ).toBe(false);
  await page.evaluate(async () => (await import('/src/app/boot.ts')).saveCurrent());
  await page.reload();
  await waitForEditor(page);
  await expect.poll(() => drawn(page, nativeRoot), { timeout: 15_000 }).toEqual(native);
  expect(errors).toEqual([]);
});
