// #1063 — a Draco-compressed file arrives as native geometry through the product's import door,
// and draws what the file says.
//
// The native reader decodes each compressed primitive into ordinary accessors before it reads one,
// as Blender's importer does (`gltfDraco.ts`), using three's DRACOLoader worker at the self-hosted
// `/draco/` path (`dracoDecoder.ts`). The reference is the file itself: a unit cube, and its one
// material. (Before #1053 the clone road's draw of the same bytes was the reference; it drew the
// same material, and the clone renderer is gone.) And since a native import holds its mesh in the
// project, deleting the source file and reloading changes nothing.
//
// REF: src/core/import/gltfDraco.ts; src/app/asset/dracoDecoder.ts; issue #1063.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
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

test('#1063 — a Draco file imports native and draws what the file says', async ({ page }) => {
  test.slow(); // an import, a save and a reload, each observed
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

  // The reference: the file. `cube-draco.glb`'s one material is baseColorFactor
  // [0.1022, 0.8714, 0.1946] (linear; #5af07a once three encodes it as sRGB for the hex), metallic 0,
  // roughness 0.5; its decoded vertices sit at ±0.5.
  expect(native).toEqual({ size: [1, 1, 1], color: '#5af07a', metalness: 0, roughness: 0.5 });

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
