// #217 — imported glTF materials are fully tweakable in the inspector like a
// native base object: the Render Options (double-sided / alpha cutout) and the
// Texture Placement (UV tiling) controls drive the drawn material live.
//
// THE PROOF (falsifiable, boundary-pair): import a glTF → select its Object →
// toggle a render option / edit a UV field IN THE INSPECTOR → assert BOTH the
// DAG material (side A) AND the drawn three.js material (side B) change.
//
// #1053 — the imports arrive native and the clone road is retired, so both sides
// are the native import's: the material on its `PolyMeshData`, and the mesh its
// Object draws.

import { test, expect } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';

const FRONT_SIDE = 0;
const DOUBLE_SIDE = 2; // THREE.FrontSide / THREE.DoubleSide

interface BasherWindow {
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function importNative(page: import('@playwright/test').Page, file: string, folder: string) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(
    async ({ file, folder }) => {
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await (window as unknown as BasherWindow).__basher_ingestGltfFolder(
        [{ relativePath: file, bytes }],
        folder,
      );
    },
    { file, folder },
  );
  await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');
}

/** The imported mesh's material: `id` is the DATA half's, which every inspector control is keyed on. */
async function materialChild(page: import('@playwright/test').Page) {
  const c = await firstMaterialMesh(page);
  if (!c) return null;
  const m0 = c.slots[0] as Record<string, unknown>;
  return {
    id: c.dataId,
    objectId: c.objectId,
    geometry: m0.geometry,
    uvTransform: m0.uvTransform,
    name: m0.name,
  };
}

const firstMesh = async (page: import('@playwright/test').Page) =>
  (await drawnImportMeshes(page))[0] ?? null;

async function selectAndOpen(
  page: import('@playwright/test').Page,
  child: { id: string; objectId: string },
) {
  await page.evaluate((nid) => {
    (window as unknown as BasherWindow).__basher_selection.getState().select(nid);
  }, child.objectId);
  await openInspectorSection(page, 'material');
  await expect(page.getByTestId(`inspector-doublesided-${child.id}`)).toBeVisible();
}

test.describe('#217 — glTF material render-options + UV inspector controls', () => {
  test('toggling double-sided in the inspector flips the rendered side', async ({ page }) => {
    await importNative(page, 'cube-draco.glb', 'ro-ds');
    await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
    const child = await materialChild(page);
    await selectAndOpen(page, child!);

    // Pre-edit the mesh is front-only.
    await expect.poll(async () => (await firstMesh(page))?.side).toBe(FRONT_SIDE);

    await page.getByTestId(`inspector-doublesided-${child!.id}`).check();

    // Side A — DAG material flag set; Side B — the mesh draws double-sided.
    await expect
      .poll(async () => {
        const g = (await materialChild(page))?.geometry as { doubleSided?: boolean } | undefined;
        return g?.doubleSided;
      })
      .toBe(true);
    await expect.poll(async () => (await firstMesh(page))?.side).toBe(DOUBLE_SIDE);
  });

  test('setting alpha cutout in the inspector drives the rendered alphaTest', async ({ page }) => {
    await importNative(page, 'cube-draco.glb', 'ro-ac');
    await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
    const child = await materialChild(page);
    await selectAndOpen(page, child!);

    await expect.poll(async () => (await firstMesh(page))?.alphaTest).toBe(0); // off by default

    const input = page.getByTestId(`inspector-alphacutoff-${child!.id}`);
    await input.fill('0.5');
    await input.blur();

    await expect
      .poll(async () => {
        const g = (await materialChild(page))?.geometry as { alphaCutoff?: number } | undefined;
        return g?.alphaCutoff;
      })
      .toBe(0.5);
    await expect.poll(async () => (await firstMesh(page))?.alphaTest).toBe(0.5);
  });

  // #220 — the imported material name is a label (not appearance), so the proof is
  // the DAG side (side A) + the read-side: the field resyncs to the committed name.
  test('renaming a material in the inspector updates the DAG name', async ({ page }) => {
    await importNative(page, 'cube-draco.glb', 'ro-name');
    await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
    const child = await materialChild(page);
    await selectAndOpen(page, child!);

    const input = page.getByTestId(`inspector-material-name-${child!.id}`);
    await expect(input).toBeVisible();
    await input.fill('brushed steel');
    await input.blur();

    // Side A — the DAG material carries the new name.
    await expect.poll(async () => (await materialChild(page))?.name).toBe('brushed steel');
    // Read-side — the input reflects the committed name (resync from the DAG).
    await expect(input).toHaveValue('brushed steel');
  });

  test('editing UV tiling in the inspector re-tiles the rendered map', async ({ page }) => {
    // uv-transform-quad is textured (its UV matrix readable) and captures uvTransform.
    await importNative(page, 'uv-transform-quad.gltf', 'ro-uv');
    await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
    const child = await materialChild(page);
    await selectAndOpen(page, child!);

    const tilingX = page.getByTestId(`inspector-uvtransform-tilingX-${child!.id}`);
    await expect(tilingX).toBeVisible();
    await tilingX.fill('4');
    await tilingX.blur();

    await expect
      .poll(async () => {
        const uv = (await materialChild(page))?.uvTransform as
          | { tiling: [number, number] }
          | undefined;
        return uv?.tiling?.[0];
      })
      .toBe(4);
    // The drawn UV matrix's x scale (column-major entry 0; the file's placement has no rotation).
    await expect.poll(async () => (await firstMesh(page))?.mapUvMatrix?.[0]).toBeCloseTo(4, 9);
  });
});
