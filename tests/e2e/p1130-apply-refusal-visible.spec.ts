// p1130 — a refused Apply says why, on screen, from both Apply surfaces (issue #1130).
//
// `dispatchApplyTransform` refuses with a sentence, and both buttons used to throw it away, so a
// refused click looked like a broken button. The subject here is a real refusal reached through
// the real product: `sheen-quad.gltf` carries a second UV set, which the baked store has no place
// to keep (#1119), so Apply on its imported child is refused by name. The control is
// `uv-transform-quad.gltf`, which bakes: no warning, and the graph changes.
//
// Every assertion reads what the director would see (the toast text) plus the graph, never the
// dispatch's return value.
//
// REF: src/app/animate/applyTransformAction.ts; src/app/MenuBar.tsx (Object ▸ Apply);
//      src/app/NPanel.tsx (`ApplyTransformControl`); issues #1130, #1119.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { importedChildren } from './_importedChild';

interface W {
  __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
  __basher_three: { getState: () => { scene: unknown } };
  __basher_importGltf: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_writeOpfsBytes: (ref: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_meshes?: () => unknown[];
}

/** Import `file` on the clone road, select its one child, and return the child's id. */
async function importAndSelect(page: Page, file: string): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_importGltf && w.__basher_three?.getState().scene);
  });
  const ref = `assets/${file}`;
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as W;
      const buf = await (await fetch(url)).arrayBuffer();
      await w.__basher_writeOpfsBytes(ref, new Uint8Array(buf));
      await w.__basher_importGltf(buf, ref);
    },
    { url: `/assets/${file}`, ref },
  );
  await page.waitForFunction(
    () => ((window as unknown as W).__basher_gltf_meshes?.() ?? []).length === 1,
  );
  const children = await importedChildren(page, ref);
  expect(children).toHaveLength(1);
  const id = children[0].objectId;
  await page.evaluate(async (id) => {
    const m = await import('/src/app/stores/selectionStore.ts');
    m.useSelectionStore.getState().select(id);
  }, id);
  return id;
}

const nodeTypes = (page: Page) =>
  page.evaluate(() =>
    Object.values((window as unknown as W).__basher_dag.getState().state.nodes)
      .map((n) => n.type)
      .sort(),
  );

test.describe('#1130 — a refused Apply is shown, not dropped', () => {
  test('the N panel Apply button shows the refusal and leaves the graph alone', async ({
    page,
  }) => {
    test.slow();
    await importAndSelect(page, 'sheen-quad.gltf');
    const before = await nodeTypes(page);
    await expect(page.getByTestId('npanel-apply-all')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('npanel-apply-all').click();

    const warning = page.getByTestId('toast-warn');
    await expect(warning).toBeVisible();
    // #1134 — the object as the outliner names it, never its node id.
    await expect(warning).toContainText('"SheenQuad" carries uv1');
    await expect(warning).not.toContainText('n_gltfChild');
    await expect(warning).toContainText('a baked mesh has no place to keep');
    expect(await nodeTypes(page)).toEqual(before);
  });

  test('Object ▸ Apply shows the same refusal', async ({ page }) => {
    test.slow();
    await importAndSelect(page, 'sheen-quad.gltf');
    const before = await nodeTypes(page);
    await page.getByTestId('menu-object-button').click();
    await page.getByTestId('menu-object-apply').hover();
    await expect(page.getByTestId('menu-object-apply-all')).toBeEnabled();
    await page.getByTestId('menu-object-apply-all').click();

    const warning = page.getByTestId('toast-warn');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('a baked mesh has no place to keep');
    expect(await nodeTypes(page)).toEqual(before);
  });

  test('control: an Apply that bakes shows no warning and changes the graph', async ({ page }) => {
    test.slow();
    await importAndSelect(page, 'uv-transform-quad.gltf');
    const before = await nodeTypes(page);
    await expect(page.getByTestId('npanel-apply-all')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('npanel-apply-all').click();

    await expect.poll(() => nodeTypes(page)).not.toEqual(before);
    expect(await nodeTypes(page)).toContain('BakedData');
    await expect(page.getByTestId('toast-warn')).toHaveCount(0);
    await expect(page.getByTestId('toast-error')).toHaveCount(0);
  });
});
