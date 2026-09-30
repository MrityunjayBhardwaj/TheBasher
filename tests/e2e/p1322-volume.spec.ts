// #1322 — a glTF volume imports native, draws its thickness and absorption as three draws them,
// survives a save and a bake, and the inspector sets an absorption depth on a material that has none.
//
// Before this `KHR_materials_volume` was refused. The file here: transmission 1, thicknessFactor 0.2,
// attenuationDistance 0.5, attenuationColor [0.2, 0.6, 1] (linear) = #7ccbff in sRGB. They land as
// OpenPBR's transmission depth and colour (same Beer's-law meaning) and `geometry.thickness`.
//
// Read on the drawn three material. The numbers are this file's arithmetic; until #1053 the bake
// case also read three's own loader (the clone drew through it) and it agreed. The bake case now bakes
// the file's material on a box.
//
// REF: src/nodes/types.ts (`transmission`, `geometry.thickness`);
//      src/core/import/gltfJsonMaterialToOpenpbr.ts; src/app/material/openpbrToThree.ts;
//      src/viewport/SceneFromDAG.tsx (`CapturedBakedMeshR`); issue #1322.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { openInspectorSection } from './_inspectorSections';
import { applyBox, boxWithImportedMaterial } from './_bakeOnBox';

const BOX = 'n_p1322_box';

interface DrawnMaterial {
  thickness: number | null;
  attenuationDistance: number | null;
  attenuationColor: string | null;
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
          transmission?: unknown;
        }
      ).transmission ?? null,
    dataId,
  );

const drawn = (page: Page, objectId: string) =>
  page.evaluate((id) => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    return (
      m && {
        thickness: m.thickness,
        attenuationDistance: m.attenuationDistance,
        attenuationColor: m.attenuationColor,
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

const IMPORTED = { thickness: 0.2, attenuationDistance: 0.5, attenuationColor: '#7ccbff' };

test('#1322 — a volume imports native, draws its thickness and absorption, and survives a save', async ({
  page,
}) => {
  await ingest(page, 'volume-quad.gltf', 'p1322');
  const { objectId, dataId } = await imported(page);
  expect(await stored(page, dataId)).toEqual({ weight: 1, color: '#7ccbff', depth: 0.5 });
  await expect.poll(() => drawn(page, objectId)).toEqual(IMPORTED);
  await saveAndReload(page);
  const after = await imported(page);
  await expect.poll(() => drawn(page, after.objectId)).toEqual(IMPORTED);

  // The thickness is a Render Options field (a glTF geometry hint, beside alpha cutout).
  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    after.objectId,
  );
  await openInspectorSection(page, 'material');
  const thickness = page.locator('[data-testid^="inspector-thickness-"]');
  await expect(thickness).toHaveValue('0.2');
  await thickness.fill('0.35');
  await expect.poll(async () => (await drawn(page, after.objectId))?.thickness).toBe(0.35);
  expect(errors).toEqual([]);
});

test('#1322 — the inspector sets an absorption depth the material does not have yet', async ({
  page,
}) => {
  await ingest(page, 'normal-map-quad.gltf', 'p1322-edit');
  const { objectId, dataId } = await imported(page);
  // The control: an opaque material, nothing stored, no absorption drawn.
  expect(await stored(page, dataId)).toEqual({ weight: 0 });
  await expect.poll(async () => (await drawn(page, objectId))?.attenuationDistance).toBeNull();

  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    objectId,
  );
  await openInspectorSection(page, 'material');
  const depth = page.locator(
    '[data-testid^="inspector-input-"][data-testid$=".transmission.depth"]',
  );
  await expect(depth).toHaveCount(1);
  await expect(depth).toHaveValue('0');
  await depth.fill('0.75');
  await depth.press('Enter');
  await expect.poll(() => stored(page, dataId)).toEqual({ weight: 0, depth: 0.75 });
  // A depth with no colour absorbs toward white: three draws it, at the distance given.
  await expect.poll(async () => (await drawn(page, objectId))?.attenuationDistance).toBe(0.75);
  expect(errors).toEqual([]);
});

// The baked mesh's own builder: the file's material on a box, baked by Apply, keeps the volume and
// draws them as the file says (#1053: through a primitive bake, the one live producer of a textured
// `BakedData`; see `_bakeOnBox`).
test('#1322 — a bake keeps the volume, as the file says', async ({ page }) => {
  await boxWithImportedMaterial(page, 'volume-quad.gltf', 'p1322-bake', BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(IMPORTED);
  await applyBox(page, BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(IMPORTED);
  expect(errors).toEqual([]);
});
