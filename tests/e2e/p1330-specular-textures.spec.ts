// #1330 — a glTF material's specular textures come across a native import, draw, survive a save and
// a bake. The fixture gives no `specularFactor`, so the imported specular weight stays ABSENT —
// OpenPBR's default 1 (`open_pbr_surface.mtlx`), three's too (`MeshPhysicalMaterial.js:64`) — and
// the maps must still draw at that weight.
//
// Before this, the native reader refused a file with a texture inside `KHR_materials_specular` ("a
// texture the native material does not hold"; #1321 held the factors only). The specular colour
// texture is 8 px wide and the specular (weight) texture 16 px wide, so each drawn map is
// identified by its image. three's loader reads the weight as data (`GLTFLoader.js:1241`) and the
// colour as sRGB (`:1250`), as the extension says (`KHR_materials_specular.md`).
//
// Read on the drawn three material, never on the DAG. The bake case bakes the file's
// material on a box and expects the same reading (#1053).
//
// REF: src/nodes/types.ts (`MATERIAL_MAP_SLOT_TABLE`, the specularWeight / specularColor rows;
//      `LOBE_WEIGHT_WHEN_ABSENT`); src/core/import/gltfJsonMaterialToOpenpbr.ts (`IR_SLOT_SOURCES`);
//      issue #1330.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { applyBox, boxWithImportedMaterial } from './_bakeOnBox';

const FIXTURE = 'specular-texture-quad.gltf';
const BOX = 'n_p1330_box';

interface Specular {
  specularIntensity: number | null;
  specularColorMapWidth: number | null;
  specularColorMapTransfer: string | null;
  specularIntensityMapWidth: number | null;
  specularIntensityMapTransfer: string | null;
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
  __basher_mesh_material: (nodeId: string) => (Specular & Record<string, unknown>) | null;
  __basher_three: unknown;
}

/**
 * What the file says, as three's loader draws it. A map's colour space is read as the TRANSFER
 * three decodes it with, because that is what draws: three's loader leaves the weight map at
 * `NoColorSpace` ('', `GLTFLoader.js:1241` passes none), our table stamps 'srgb-linear', and three
 * decodes both as linear (`ColorManagement.js:124`) into the same texture format
 * (`WebGLTextures.js:204`). Only sRGB changes the draw.
 */
const FROM_FILE: Specular = {
  specularIntensity: 1,
  specularColorMapWidth: 8,
  specularColorMapTransfer: 'srgb',
  specularIntensityMapWidth: 16,
  specularIntensityMapTransfer: 'linear',
};

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<Win>;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_mesh_material && w.__basher_three);
  });
}

async function ingest(page: Page, folder: string): Promise<void> {
  await page.evaluate(
    async ({ file, folder }) => {
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await (window as unknown as Win).__basher_ingestGltfFolder(
        [{ relativePath: file, bytes }],
        folder,
      );
    },
    { file: FIXTURE, folder },
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

const drawn = (page: Page, objectId: string) =>
  page.evaluate((id): Specular | null => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    const transferOf = (cs: unknown) => (cs == null ? null : cs === 'srgb' ? 'srgb' : 'linear');
    return (
      m && {
        specularIntensity: m.specularIntensity,
        specularColorMapWidth: m.specularColorMapWidth,
        specularColorMapTransfer: transferOf(m.specularColorMapColorSpace),
        specularIntensityMapWidth: m.specularIntensityMapWidth,
        specularIntensityMapTransfer: transferOf(m.specularIntensityMapColorSpace),
      }
    );
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

test('#1330 — a file’s specular textures import native, draw at weight 1, and survive a save', async ({
  page,
}) => {
  await ingest(page, 'p1330-native');
  const { objectId } = await imported(page);
  await expect.poll(() => drawn(page, objectId)).toEqual(FROM_FILE);

  await saveAndReload(page);
  const after = await imported(page);
  await expect.poll(() => drawn(page, after.objectId)).toEqual(FROM_FILE);
  expect(errors).toEqual([]);
});

// The baked mesh's own builder: the file's material on a box, baked by Apply, keeps the specular textures
// and draws as the file says (#1053: through a primitive bake, the one live producer of a textured
// `BakedData`; see `_bakeOnBox`).
test('#1330 — a bake keeps the specular textures and draws them as the file says', async ({
  page,
}) => {
  await boxWithImportedMaterial(page, FIXTURE, 'p1330-bake', BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(FROM_FILE);
  await applyBox(page, BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(FROM_FILE);
  expect(errors).toEqual([]);
});
