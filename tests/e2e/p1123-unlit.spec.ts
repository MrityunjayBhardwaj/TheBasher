// #1123 — an unlit glTF material imports native and draws unlit; the inspector turns it on and off.
//
// `KHR_materials_unlit` was refused by the native reader. three's loader draws it as a
// `MeshBasicMaterial` from the base colour and base map, and Blender's importer replaces the whole
// surface with an Emission of the base colour, so the native material carries `unlit: true` and the
// registry builds a basic material for it.
//
// Read on the drawn three material (`__basher_mesh_material`): its type, and that its base map
// decoded. Turning unlit OFF has to remove the key, because lit is the absent field and the schema
// holds only `true`; the DAG read below checks the key is gone, not `false`.
//
// REF: src/nodes/types.ts (`unlit`); src/app/materialRegistry.ts (`build`, the basic branch);
//      src/app/NPanel.tsx (`MaterialRenderOptions`); issue #1123.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { openInspectorSection } from './_inspectorSections';

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
  __basher_mesh_material: (
    nodeId: string,
  ) => { type: string | null; hasMap: boolean; mapImageOk: boolean } | null;
  __basher_three: unknown;
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<Win>;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_mesh_material && w.__basher_three);
  });
}

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

/** Whether the stored material has the key at all, and its value. */
const storedUnlit = (page: Page, dataId: string) =>
  page.evaluate((id) => {
    const m = (window as unknown as Win).__basher_dag.getState().state.nodes[id].params
      .material as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(m, 'unlit') ? m.unlit : 'absent';
  }, dataId);

const drawn = (page: Page, objectId: string) =>
  page.evaluate((id) => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    return m && { type: m.type, map: m.hasMap && m.mapImageOk };
  }, objectId);

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

test('#1123 — an unlit material imports, draws unlit, toggles, and survives a save', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await fetch('/assets/unlit-quad.gltf').then((r) => r.arrayBuffer()),
    );
    await (window as unknown as Win).__basher_ingestGltfFolder(
      [{ relativePath: 'unlit-quad.gltf', bytes }],
      'p1123-unlit',
    );
  });
  const { objectId, dataId } = await imported(page);
  expect(await storedUnlit(page, dataId)).toBe(true);
  const unlit = { type: 'MeshBasicMaterial', map: true };
  const lit = { type: 'MeshPhysicalMaterial', map: true };
  await expect.poll(() => drawn(page, objectId)).toEqual(unlit);

  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    objectId,
  );
  await openInspectorSection(page, 'material');
  const toggle = page.locator('[data-testid^="inspector-unlit-"]');
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toBeChecked();

  await toggle.uncheck();
  await expect.poll(() => storedUnlit(page, dataId)).toBe('absent');
  await expect.poll(() => drawn(page, objectId)).toEqual(lit);

  await toggle.check();
  await expect.poll(() => storedUnlit(page, dataId)).toBe(true);
  await expect.poll(() => drawn(page, objectId)).toEqual(unlit);

  await page.evaluate(async () => {
    const url = '/src/app/boot.ts';
    const boot = (await import(/* @vite-ignore */ url)) as { saveCurrent: () => Promise<void> };
    await boot.saveCurrent();
  });
  await page.reload();
  await ready(page);
  const after = await imported(page);
  expect(await storedUnlit(page, after.dataId)).toBe(true);
  await expect.poll(() => drawn(page, after.objectId)).toEqual(unlit);
  expect(errors).toEqual([]);
});
