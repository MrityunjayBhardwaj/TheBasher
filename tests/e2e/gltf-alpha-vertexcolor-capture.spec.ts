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
//   · the vertex-colour quad is still refused (the stored mesh does not hold COLOR_0,
//     #1062) and imports through the file's copy. Its road assertion is deliberate: when
//     #1062 lands, this reds, and the test should then move to the native road.

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
    | { geometry?: { alphaCutoff?: number; vertexColors?: boolean; doubleSided?: boolean } }
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

  test('COLOR_0 → clone renders vertex colors; IR captures the flag', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
    );
    await ingest(page, 'vertex-color-quad.gltf', 'vcolor');

    // Still the clone road until the stored mesh holds COLOR_0 (#1062) — see the header.
    await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('clone');

    // side B — the clone renders vertex colours (GLTFLoader set
    // material.vertexColors=true from the COLOR_0 attribute).
    await expect.poll(async () => (await firstDrawn(page))?.vertexColors).toBe(true);

    // side A — the importer captured the vertexColors flag into the IR.
    await expect.poll(async () => (await capturedGeometry(page))?.vertexColors).toBe(true);
  });
});
