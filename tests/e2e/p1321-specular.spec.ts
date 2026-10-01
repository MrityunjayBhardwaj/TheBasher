// #1321 — a glTF specular weight and colour import native, draw as three draws them, survive a
// save and a bake, and the inspector sets one on a material that has none.
//
// Before this `KHR_materials_specular` was refused. The file here: specularFactor 0.4 and
// specularColorFactor [1, 0.5, 0.25] (linear), which is #ffbc89 in sRGB. Both fields are optional
// on the material's existing specular lobe; absent is OpenPBR's default (1, white), which is also
// three's, and the inspector case checks an edit adds the one field it names.
//
// Read on the drawn three material. The numbers are this file's arithmetic; until #1053 the bake
// case also read three's own loader (the clone drew through it) and it agreed. The bake case now bakes
// the file's material on a box.
//
// REF: src/nodes/types.ts (`specular`); src/core/import/gltfJsonMaterialToOpenpbr.ts;
//      src/app/materialRegistry.ts (`build`); src/viewport/SceneFromDAG.tsx (`CapturedBakedMeshR`);
//      issue #1321.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { openInspectorSection } from './_inspectorSections';
import { applyBox, boxWithImportedMaterial } from './_bakeOnBox';

const BOX = 'n_p1321_box';

interface DrawnMaterial {
  specularIntensity: number | null;
  specularColor: string | null;
}

interface Win {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
        >;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_mesh_material: (nodeId: string) => DrawnMaterial | null;
  __basher_three: unknown;
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<Win>;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_mesh_material && w.__basher_three);
  });
}

async function ingest(page: Page, file: string, folder: string): Promise<void> {
  await page.evaluate(
    async ({ file, folder }) => {
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await (window as unknown as Win).__basher_ingestGltfFolder(
        [{ relativePath: file, bytes }],
        folder,
      );
    },
    { file, folder },
  );
}

/** The imported Object and the stored mesh it draws. */
async function imported(page: Page): Promise<{ objectId: string; dataId: string }> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).filter(
            (n) => n.type === 'PolyMeshData',
          ).length,
      ),
    )
    .toBe(1);
  return page.evaluate(() => {
    const nodes = (window as unknown as Win).__basher_dag.getState().state.nodes;
    const dataId = Object.entries(nodes).find(([, n]) => n.type === 'PolyMeshData')![0];
    const objectId = Object.entries(nodes).find(
      ([, n]) => n.type === 'Object' && (n.inputs.data as { node?: string })?.node === dataId,
    )![0];
    return { objectId, dataId };
  });
}

const stored = (page: Page, dataId: string) =>
  page.evaluate(
    (id) =>
      (
        (window as unknown as Win).__basher_dag.getState().state.nodes[id].params.material as {
          specular?: unknown;
        }
      ).specular ?? null,
    dataId,
  );

const drawn = (page: Page, objectId: string) =>
  page.evaluate((id) => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    return m && { specularIntensity: m.specularIntensity, specularColor: m.specularColor };
  }, objectId);

async function saveAndReload(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = '/src/app/boot.ts';
    const boot = (await import(/* @vite-ignore */ url)) as { saveCurrent: () => Promise<void> };
    await boot.saveCurrent();
  });
  await page.reload();
  await ready(page);
}

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
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

const IMPORTED = { specularIntensity: 0.4, specularColor: '#ffbc89' };

test('#1321 — a specular material imports native, draws its weight and colour, and survives a save', async ({
  page,
}) => {
  await ingest(page, 'specular-quad.gltf', 'p1321');
  const { objectId, dataId } = await imported(page);
  expect(await stored(page, dataId)).toEqual({
    roughness: 0.8,
    ior: 1.5,
    weight: 0.4,
    color: '#ffbc89',
  });
  await expect.poll(() => drawn(page, objectId)).toEqual(IMPORTED);
  await saveAndReload(page);
  const after = await imported(page);
  await expect.poll(() => drawn(page, after.objectId)).toEqual(IMPORTED);
  expect(errors).toEqual([]);
});

test('#1321 — the inspector sets a specular weight the material does not have yet', async ({
  page,
}) => {
  await ingest(page, 'normal-map-quad.gltf', 'p1321-edit');
  const { objectId, dataId } = await imported(page);
  // The control: no weight or colour stored, and three's defaults drawn.
  expect(await stored(page, dataId)).toEqual({ roughness: 0.6, ior: 1.5 });
  await expect
    .poll(() => drawn(page, objectId))
    .toEqual({ specularIntensity: 1, specularColor: '#ffffff' });

  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    objectId,
  );
  await openInspectorSection(page, 'material');
  const weight = page.locator('[data-testid^="inspector-input-"][data-testid$=".specular.weight"]');
  await expect(weight).toHaveCount(1);
  await expect(weight).toHaveValue('1');
  await weight.fill('0.25');
  await weight.press('Enter');
  await expect.poll(() => stored(page, dataId)).toEqual({ roughness: 0.6, ior: 1.5, weight: 0.25 });
  await expect
    .poll(() => drawn(page, objectId))
    .toEqual({ specularIntensity: 0.25, specularColor: '#ffffff' });
  expect(errors).toEqual([]);
});

// The baked mesh's own builder: the file's material on a box, baked by Apply, keeps the specular weight and colour and
// draws them as the file says (#1053: through a primitive bake, the one live producer of a textured
// `BakedData`; see `_bakeOnBox`).
test('#1321 — a bake keeps the specular colour, as the file says', async ({ page }) => {
  await boxWithImportedMaterial(page, 'specular-quad.gltf', 'p1321-bake', BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(IMPORTED);
  await applyBox(page, BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(IMPORTED);
  expect(errors).toEqual([]);
});
