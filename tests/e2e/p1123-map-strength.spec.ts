// #1123 — a normal map's scale and an occlusion map's strength come across a native import, draw,
// survive a save, and can be edited in the inspector.
//
// Before this, the native reader refused any file whose normal map had a scale or whose occlusion
// map had a strength other than 1, and nothing downstream could hold either number. The glTF
// values are carried the way the reference carries them: three's loader draws them as
// `normalScale` and `aoMapIntensity`, and Blender's importer as the Normal Map node's Strength and
// an "Occlusion Strength" mix.
//
// Read on the drawn three material (`__basher_mesh_material`), not on the DAG: a value stored and
// never applied would pass every DAG read. The normal vector's y is negative because a glTF map is
// an unflipped upload on a mesh without tangents (#1325); the strength scales both axes.
//
// The second case edits a map that has NO strength, which is every material saved before this: the
// bag is optional and absent, so the edit has to create it.
//
// REF: src/nodes/types.ts (`mapStrengths`); src/core/import/gltfJsonMaterialToOpenpbr.ts
//      (`captureMapStrengths`); src/app/materialRegistry.ts (`build`); src/app/NPanel.tsx (the
//      strength rows under the normal and occlusion maps); issue #1123.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { openInspectorSection } from './_inspectorSections';
import { applyBox, boxWithImportedMaterial } from './_bakeOnBox';

const BOX = 'n_p1123_strength_box';

interface DrawnMaterial {
  normalScale: [number, number] | null;
  aoMapIntensity: number | null;
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
          mapStrengths?: unknown;
        }
      ).mapStrengths ?? null,
    dataId,
  );

const drawn = (page: Page, objectId: string) =>
  page.evaluate((id) => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    return m && { normalScale: m.normalScale, aoMapIntensity: m.aoMapIntensity };
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

test('#1123 — a file’s normal scale and occlusion strength import, draw and survive a save', async ({
  page,
}) => {
  await ingest(page, 'normal-strength-quad.gltf', 'p1123-strength');
  const { objectId, dataId } = await imported(page);
  expect(await stored(page, dataId)).toEqual({ normal: 0.5, ao: 0.3 });
  const expected = { normalScale: [0.5, -0.5], aoMapIntensity: 0.3 };
  await expect.poll(() => drawn(page, objectId)).toEqual(expected);

  await saveAndReload(page);
  const after = await imported(page);
  expect(await stored(page, after.dataId)).toEqual({ normal: 0.5, ao: 0.3 });
  await expect.poll(() => drawn(page, after.objectId)).toEqual(expected);
  expect(errors).toEqual([]);
});

test('#1123 — the inspector edits a strength the material does not have yet', async ({ page }) => {
  await ingest(page, 'normal-map-quad.gltf', 'p1123-edit');
  const { objectId, dataId } = await imported(page);
  // The control: this file says nothing, so nothing is stored and the default draws.
  expect(await stored(page, dataId)).toBeNull();
  await expect
    .poll(() => drawn(page, objectId))
    .toEqual({ normalScale: [1, -1], aoMapIntensity: null });

  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    objectId,
  );
  await openInspectorSection(page, 'material');
  const input = page.locator(
    '[data-testid$=".mapStrengths.normal"][data-testid^="inspector-input-"]',
  );
  await expect(input).toHaveCount(1);
  await expect(input).toHaveValue('1');
  // The occlusion row belongs to an occlusion map, and this file has none.
  await expect(page.locator('[data-testid$=".mapStrengths.ao"]')).toHaveCount(0);

  await input.fill('0.25');
  await input.press('Enter');
  await expect.poll(() => stored(page, dataId)).toEqual({ normal: 0.25 });
  await expect
    .poll(() => drawn(page, objectId))
    .toEqual({ normalScale: [0.25, -0.25], aoMapIntensity: null });
  expect(errors).toEqual([]);
});

// The baked mesh's own builder: the file's material on a box, baked by Apply, keeps the normal and occlusion strengths and
// draws them as the file says (#1053: through a primitive bake, the one live producer of a textured
// `BakedData`; see `_bakeOnBox`).
test('#1123 — a bake keeps the strengths and draws them', async ({ page }) => {
  await boxWithImportedMaterial(page, 'normal-strength-quad.gltf', 'p1123-bake', BOX);
  const expected = { normalScale: [0.5, -0.5], aoMapIntensity: 0.3 };
  await expect.poll(() => drawn(page, BOX)).toEqual(expected);
  await applyBox(page, BOX);
  await expect.poll(() => drawn(page, BOX)).toEqual(expected);
  expect(errors).toEqual([]);
});
