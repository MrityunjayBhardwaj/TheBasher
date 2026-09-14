// #221 — a glTF whose single mesh primitive has NO `material` while the file
// defines one orphaned textured material (the 3dripper export bug) is REPAIRED at
// ingest: the unbound primitive is bound to the orphan, so the model imports
// TEXTURED instead of rendering the default white material.
//
// THE PROOF (falsifiable, boundary-pair): import orphan-material-quad.gltf →
// assert BOTH side A (the captured material is M_Orphan, not "default") AND
// side B (the drawn mesh carries a base map + the material's doubleSided flag,
// read off the live three.js material). Without the rebind the primitive gets the
// default material → captured "default", no map, side=FrontSide.
//
// #1071 — the file arrives as native geometry, so both sides are read through the
// road-agnostic reader, and the road itself is asserted: a file that silently fell
// back to the clone road must not pass on the other road's readings.

import { test, expect } from './_fixtures';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';

const DOUBLE_SIDE = 2; // THREE.DoubleSide

interface BasherWindow {
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function ingest(page: import('@playwright/test').Page, file: string, folder: string) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(
    async ([f, name]) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${f}`).then((r) => r.arrayBuffer()));
      await w.__basher_ingestGltfFolder([{ relativePath: f, bytes }], name);
    },
    [file, folder] as const,
  );
}

/** The captured-material name of the first imported mesh that carries one. */
async function capturedMaterialName(page: import('@playwright/test').Page) {
  const mesh = await firstMaterialMesh(page);
  return (mesh?.slots[0] as { name?: string } | undefined)?.name ?? null;
}

const firstDrawn = async (page: import('@playwright/test').Page) =>
  (await drawnImportMeshes(page))[0] ?? null;

test.describe('#221 — orphan-material rebind on import', () => {
  test("an unbound primitive is bound to the file's one orphaned material", async ({ page }) => {
    await ingest(page, 'orphan-material-quad.gltf', 'orphan');

    await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');

    // Side A — the captured material is the file's M_Orphan (NOT the default
    // material the unbound primitive would otherwise have received).
    await expect.poll(async () => await capturedMaterialName(page)).toBe('M_Orphan');

    // Side B — the drawn mesh carries the material's base map + doubleSided flag,
    // i.e. the geometry now uses M_Orphan, not the flat default material.
    await expect.poll(async () => (await firstDrawn(page))?.hasMap).toBe(true);
    await expect.poll(async () => (await firstDrawn(page))?.side).toBe(DOUBLE_SIDE);
  });
});
