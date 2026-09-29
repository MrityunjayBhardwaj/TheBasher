// A file the native reader cannot hold is refused, whole and by name (#1053). There is no second
// road to fall back to: until #1053 a file carrying a feature the native material does not hold
// took the clone road and warned to the console. Now it writes nothing, and the refusal banner says
// what the reader could not hold and which issue brings it across.
//
// THE PROOF: importing sheen-quad.gltf (KHR_materials_sheen, #1123) through the product door adds
// no node, shows the refusal naming the extension and its issue, and throws nothing on the page.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_dag: { getState: () => { state: { nodes: Record<string, unknown> } } };
}

test('a file with a feature the native reader cannot hold is refused by name, and writes nothing', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<BasherWindow>;
    return typeof w.__basher_ingestGltfFolder === 'function' && Boolean(w.__basher_dag);
  });
  const nodeCount = () =>
    page.evaluate(
      () =>
        Object.keys((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).length,
    );
  const before = await nodeCount();
  const path = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/sheen-quad.gltf').then((r) => r.arrayBuffer()),
    );
    return w.__basher_ingestGltfFolder([{ relativePath: 'sheen-quad.gltf', bytes }], 'sheen');
  });

  const notice = await page.evaluate(async (p) => {
    const m = await import('/src/app/stores/assetErrorStore.ts');
    return m.useAssetErrorStore.getState().errors[p] ?? '';
  }, path);
  expect(notice).toMatch(/^import refused: .*KHR_materials_sheen.*\(#1123\)$/);
  await expect(page.getByText(/import refused: .*KHR_materials_sheen/)).toBeVisible();
  expect(await nodeCount()).toBe(before);
  expect(pageErrors).toEqual([]);
});
