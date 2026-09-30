// #1331 — a glTF material's volume thickness texture comes across a native import, draws, survives a
// save and a bake.
//
// Before this, the native reader refused a file with a texture inside `KHR_materials_volume`
// ("a texture the native material does not hold"; #1322 held the volume's factors only). The
// fixture is glass (transmission 1) with a volume thickness of 0.5 and a thickness texture 8 px
// wide, so the drawn map is identified by its image. three scales `thickness` by the map's G.
//
// Read on the drawn three material, never on the DAG. The bake case bakes the file's
// material on a box and expects the same reading (#1053) (`GLTFLoader.js:1136`).
//
// REF: src/nodes/types.ts (`MATERIAL_MAP_SLOT_TABLE`, the thickness row);
//      src/core/import/gltfJsonMaterialToOpenpbr.ts (`IR_SLOT_SOURCES`); issue #1331.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { applyBox, boxWithImportedMaterial } from './_bakeOnBox';

const FIXTURE = 'thickness-quad.gltf';
const BOX = 'n_p1331_box';

interface Volume {
  thickness: number | null;
  thicknessMapWidth: number | null;
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
  __basher_mesh_material: (nodeId: string) => (Volume & Record<string, unknown>) | null;
  __basher_three: unknown;
}

/** What the file says, as three's loader draws it. */
const FROM_FILE: Volume = { thickness: 0.5, thicknessMapWidth: 8 };

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
  page.evaluate((id): Volume | null => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    return m && { thickness: m.thickness, thicknessMapWidth: m.thicknessMapWidth };
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

test('#1331 — a file’s thickness texture imports native, draws, and survives a save', async ({
  page,
}) => {
  await ingest(page, 'p1331-native');
  const { objectId } = await imported(page);
  await expect.poll(() => drawn(page, objectId)).toEqual(FROM_FILE);

  await saveAndReload(page);
  const after = await imported(page);
  await expect.poll(() => drawn(page, after.objectId)).toEqual(FROM_FILE);
  expect(errors).toEqual([]);
});

// The baked mesh's own builder: the file's material on a box, baked by Apply, keeps the thickness texture
// and draws as the file says (#1053: through a primitive bake, the one live producer of a textured
// `BakedData`; see `_bakeOnBox`).
test('#1331 — a bake keeps the thickness texture and draws it as the file says', async ({
  page,
}) => {
  await boxWithImportedMaterial(page, FIXTURE, 'p1331-bake', BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(FROM_FILE);
  await applyBox(page, BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(FROM_FILE);
  expect(errors).toEqual([]);
});
