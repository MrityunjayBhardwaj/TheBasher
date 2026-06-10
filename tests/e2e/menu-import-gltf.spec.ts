// File ▸ Import glTF… — the Blender-style FILE picker that inserts glTF
// model(s) into the CURRENT scene (additive). Distinct from File ▸ Import
// Folder… (the webkitdirectory picker for multi-file glTF + textures).
//
// Falsifiable against the real DOM via the live GltfAsset node count: opening
// the menu item, choosing a real .glb through the OS file chooser, and watching
// a GltfAsset appear in the DAG. Unwiring the menu item (or breaking the
// multi-model loop) drops the count back → these fail.

import { expect, test } from './_fixtures';

interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
}

async function gltfAssetCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const nodes = w.__basher_dag?.getState().state.nodes ?? {};
    return Object.values(nodes).filter((n) => n.type === 'GltfAsset').length;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem('basher.chrome.v1');
  });
  await page.reload();
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
});

test('File ▸ Import glTF… inserts a .glb model into the current scene (additive)', async ({
  page,
}) => {
  expect(await gltfAssetCount(page)).toBe(0);

  await page.getByTestId('menu-file-button').click();
  await expect(page.getByTestId('menu-file-import-gltf')).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('menu-file-import-gltf').click(),
  ]);
  await chooser.setFiles('public/assets/skinned-bar.glb');

  // The model lands as a GltfAsset; no error banner.
  await expect.poll(() => gltfAssetCount(page), { timeout: 8_000 }).toBe(1);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});

test('selecting two .glb at once inserts two models (multi-model)', async ({ page }) => {
  expect(await gltfAssetCount(page)).toBe(0);

  await page.getByTestId('menu-file-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('menu-file-import-gltf').click(),
  ]);
  // Two distinct self-contained .glb → one model each (the loop). Breaking the
  // loop back to a single ingest leaves the count at 1 → this fails.
  await chooser.setFiles(['public/assets/skinned-bar.glb', 'public/assets/cube-draco.glb']);

  await expect.poll(() => gltfAssetCount(page), { timeout: 10_000 }).toBe(2);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});

test('the file picker is offered alongside the directory picker', async ({ page }) => {
  await page.getByTestId('menu-file-button').click();
  // Both affordances exist — the new file picker AND the folder picker.
  await expect(page.getByTestId('menu-file-import-gltf')).toBeVisible();
  await expect(page.getByTestId('menu-file-import')).toBeVisible();
});

test('picking a multi-file .gltf alone AUTO-ESCALATES to the folder picker', async ({ page }) => {
  expect(await gltfAssetCount(page)).toBe(0);

  // A flat multi-file .gltf references scene.bin + texture.png. Picking only the
  // .gltf via the FILE picker can't capture siblings (browser security), so the
  // import auto-escalates: it re-opens a SECOND chooser (the directory picker)
  // within the same user-activation window. Completing that with the whole
  // folder set imports the model — no dead-end, no cryptic "not found".
  await page.getByTestId('menu-file-button').click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('menu-file-import-gltf').click(),
  ]);

  // Arm the second-chooser waiter BEFORE feeding the lone .gltf so the
  // escalation's re-open isn't missed. Removing the escalation leaves only the
  // first chooser → this waiter times out → RED.
  const dirChooserPromise = page.waitForEvent('filechooser', { timeout: 8_000 });
  await fileChooser.setFiles('public/fixtures/multifile/flat/scene.gltf');
  const dirChooser = await dirChooserPromise;

  // The escalation opens a webkitdirectory input — setFiles takes the DIRECTORY
  // path; Playwright supplies its files with webkitRelativePath (flat/scene.*).
  await dirChooser.setFiles('public/fixtures/multifile/flat');

  // The escalated folder grant carries the siblings → the model lands, no banner.
  await expect.poll(() => gltfAssetCount(page), { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});

test('picking a multi-file .gltf TOGETHER with its siblings imports successfully', async ({
  page,
}) => {
  expect(await gltfAssetCount(page)).toBe(0);

  await page.getByTestId('menu-file-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('menu-file-import-gltf').click(),
  ]);
  await chooser.setFiles([
    'public/fixtures/multifile/flat/scene.gltf',
    'public/fixtures/multifile/flat/scene.bin',
    'public/fixtures/multifile/flat/texture.png',
  ]);

  await expect.poll(() => gltfAssetCount(page), { timeout: 10_000 }).toBe(1);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});
