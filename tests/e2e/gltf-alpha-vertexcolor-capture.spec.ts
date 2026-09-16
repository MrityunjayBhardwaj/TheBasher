// glTF direct-import (texture-maps milestone, V53) — slices 2 & 3:
//   (2) alphaMode:'MASK' + alphaCutoff  → cutout
//   (3) vertex colors (COLOR_0)         → per-vertex tint
//
// Each test is a boundary pair: what the DRAWN three.js material carries (side B)
// against what the importer CAPTURED into the material, DAG-addressable (side A),
// on the same render — the capture must not change what renders.
//
// #1071 — the two fixtures now take different roads, and each test asserts its own:
//   · the cutout quad arrives as native geometry, so the cutout is drawn by the native
//     material built from the captured `alphaCutoff` / `doubleSided`;
//   · the vertex-colour quad arrives native too (#1062): its COLOR_0 is stored as the corner
//     layer `Color`, the captured material names that layer, and the draw resolves the name
//     against the mesh. Its road assertion stays, so a fall back to the file's copy reds.

import { test, expect } from './_fixtures';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';

interface BasherWindow {
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function ingest(page: import('@playwright/test').Page, file: string, folder: string) {
  await page.evaluate(
    async ({ file, folder }) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await w.__basher_ingestGltfFolder([{ relativePath: file, bytes }], folder);
    },
    { file, folder },
  );
}

const firstDrawn = async (page: import('@playwright/test').Page) =>
  (await drawnImportMeshes(page))[0] ?? null;

// `firstMaterialMesh` keeps the "skip bones and empties" half of the old predicate.
const capturedGeometry = async (page: import('@playwright/test').Page) => {
  const mesh = await firstMaterialMesh(page);
  const slot = mesh?.slots[0] as
    | { geometry?: { alphaCutoff?: number; colorLayer?: string; doubleSided?: boolean } }
    | undefined;
  return slot?.geometry ?? null;
};

test.describe('glTF alphaMode + vertex-color — drawn material + captured material agree', () => {
  test('alphaMode:MASK → drawn material carries alphaTest; captured alphaCutoff', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingest(page, 'cutout-alpha-quad.gltf', 'cutout');

    await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');

    // side B — the drawn material renders the cutout (alphaTest 0.5).
    await expect.poll(async () => (await firstDrawn(page))?.alphaTest).toBe(0.5);

    // side A — the importer captured alphaCutoff into the material (DAG-addressable).
    await expect.poll(async () => (await capturedGeometry(page))?.alphaCutoff).toBe(0.5);

    // doubleSided rides along (the cutout material is double-sided): drawn
    // side=DoubleSide (2) AND the captured flag.
    await expect.poll(async () => (await firstDrawn(page))?.side).toBe(2);
    await expect.poll(async () => (await capturedGeometry(page))?.doubleSided).toBe(true);
  });

  test('COLOR_0 → native draws the Color layer; the material names it', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingest(page, 'vertex-color-quad.gltf', 'vcolor');

    await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');

    // side B — the drawn material reads vertex colours, AND the drawn geometry carries the
    // buffer it reads: the flag over a geometry with no `color` buffer draws black.
    await expect.poll(async () => (await firstDrawn(page))?.vertexColors).toBe(true);
    await expect.poll(async () => (await firstDrawn(page))?.buffers).toContain('color');

    // side A — the importer captured the NAME of the colour layer into the material.
    await expect.poll(async () => (await capturedGeometry(page))?.colorLayer).toBe('Color');
  });
});
