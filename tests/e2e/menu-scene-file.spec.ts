// Native `.basher` scene file — export (embed assets) → open (rehydrate + new
// project). The falsifiable round-trip for the self-contained scene format.
//
// The traps these tests are built to avoid (B20 inert-falsifier discipline):
//   - Round-tripping the SAME scene is INERT: before == after whether or not the
//     import actually hydrated. So each test DIVERGES the live scene first (adds
//     a glTF node + asset) — a working import then REPLACES the divergence with
//     the bundle's scene; a broken import (no hydrate) leaves the divergence in
//     place, and the id-set assertion goes red. Reverting importSceneBundle's
//     `hydrate` call makes test 1 fail; reverting its asset write-loop makes
//     test 3 fail (confirmed red before commit).
//   - The asset test deletes the real OPFS bytes, then proves the OPEN path
//     wrote them BACK — the actual portability claim, not a proxy.
//
// Drives the DEV seams (__basher_export_scene_bundle / __basher_import_scene_bundle
// / __basher_opfs / __basher_ingestGltfFolder) so the round-trip is exercised
// without the OS file chooser. The bundle is JSON-serialized between export and
// import to mimic the real file write/read exactly.

import { expect, test } from './_fixtures';

interface Bundle {
  assets?: Record<string, string>;
}
interface SceneWindow {
  __basher_dag?: {
    getState: () => { state: { nodes: Record<string, { type: string }> } };
  };
  __basher_export_scene_bundle?: () => Promise<{ bundle: Bundle; missingAssets: string[] }>;
  __basher_import_scene_bundle?: (bundle: Bundle) => Promise<string>;
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folder: string,
  ) => Promise<string>;
  __basher_opfs?: {
    read: (p: string) => Promise<Uint8Array>;
    exists: (p: string) => Promise<boolean>;
    delete: (p: string) => Promise<void>;
  };
}

type EvalPage = import('@playwright/test').Page;

async function nodeIds(page: EvalPage): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as SceneWindow;
    return Object.keys(w.__basher_dag?.getState().state.nodes ?? {});
  });
}

/** Export the live scene to a JSON-round-tripped bundle (mimics file write/read). */
async function exportBundle(page: EvalPage): Promise<Bundle> {
  return page.evaluate(async () => {
    const w = window as unknown as SceneWindow;
    const { bundle } = await w.__basher_export_scene_bundle!();
    return JSON.parse(JSON.stringify(bundle)) as Bundle;
  });
}

/** Diverge the live scene: import a real .glb (adds a GltfAsset node + a
 *  user-imports OPFS asset). `folder` keeps successive imports from colliding. */
async function ingestGltf(page: EvalPage, folder: string): Promise<void> {
  await page.evaluate(async (name) => {
    const w = window as unknown as SceneWindow;
    const buf = new Uint8Array(await (await fetch('/assets/skinned-bar.glb')).arrayBuffer());
    await w.__basher_ingestGltfFolder!([{ relativePath: `${name}.glb`, bytes: buf }], name);
  }, folder);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem('basher.chrome.v1');
  });
  await page.reload();
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.waitForFunction(
    () => !!(window as unknown as SceneWindow).__basher_export_scene_bundle,
  );
});

test('round-trips the DAG: a divergent scene is replaced by the opened bundle, node id-set survives', async ({
  page,
}) => {
  const baseline = (await nodeIds(page)).sort();
  expect(baseline.length).toBeGreaterThan(0);

  // Capture a bundle of the baseline scene.
  const bundleA = await exportBundle(page);

  // Diverge the live scene — a working open must UNDO this.
  await ingestGltf(page, 'roundtrip');
  await expect
    .poll(async () => (await nodeIds(page)).length, { timeout: 10_000 })
    .toBeGreaterThan(baseline.length);

  // Open the baseline bundle → a NEW project hydrated from it. The glTF node is
  // gone; the exact baseline id-set returns. (Broken hydrate → the glTF node
  // survives → this fails.)
  await page.evaluate(
    (b) => (window as unknown as SceneWindow).__basher_import_scene_bundle!(b),
    bundleA,
  );
  await expect
    .poll(async () => (await nodeIds(page)).sort().join(','), { timeout: 10_000 })
    .toBe(baseline.join(','));
});

test('opening a scene is non-destructive: each open creates a distinct new project', async ({
  page,
}) => {
  const bundleA = await exportBundle(page);

  const id1 = await page.evaluate(
    (b) => (window as unknown as SceneWindow).__basher_import_scene_bundle!(b),
    bundleA,
  );
  const id2 = await page.evaluate(
    (b) => (window as unknown as SceneWindow).__basher_import_scene_bundle!(b),
    bundleA,
  );

  expect(id1).toMatch(/^proj_/);
  expect(id2).toMatch(/^proj_/);
  expect(id2).not.toBe(id1);
});

test('embeds a referenced OPFS asset and rehydrates it on open (portable file)', async ({
  page,
}) => {
  // Import a glTF so the scene references a user-imports asset.
  await ingestGltf(page, 'portable');
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const w = window as unknown as SceneWindow;
          const nodes = w.__basher_dag?.getState().state.nodes ?? {};
          return Object.values(nodes).filter((n) => n.type === 'GltfAsset').length;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  // Export → the bundle must EMBED the user-imports bytes (base64, non-empty).
  const assetPath = await page.evaluate(async () => {
    const w = window as unknown as SceneWindow;
    const { bundle } = await w.__basher_export_scene_bundle!();
    const keys = Object.keys(bundle.assets ?? {});
    const key = keys.find((k) => k.startsWith('user-imports/'));
    return key && (bundle.assets as Record<string, string>)[key].length > 0 ? key : null;
  });
  expect(assetPath).toBeTruthy();

  const bundle = await exportBundle(page);

  // Delete the asset from OPFS — confirm it's really gone.
  await page.evaluate(
    (p) => (window as unknown as SceneWindow).__basher_opfs!.delete(p),
    assetPath!,
  );
  expect(
    await page.evaluate(
      (p) => (window as unknown as SceneWindow).__basher_opfs!.exists(p),
      assetPath!,
    ),
  ).toBe(false);

  // Open the bundle → the embedded bytes are rehydrated back to OPFS. (Broken
  // rehydrate → exists stays false → this fails.)
  await page.evaluate(
    (b) => (window as unknown as SceneWindow).__basher_import_scene_bundle!(b),
    bundle,
  );
  await expect
    .poll(
      async () =>
        page.evaluate(
          (p) => (window as unknown as SceneWindow).__basher_opfs!.exists(p),
          assetPath!,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
});

test('File menu surfaces the affordances: Save downloads a .basher file, Open opens a chooser', async ({
  page,
}) => {
  // Both items are present in the File menu.
  await page.getByTestId('menu-file-button').click();
  await expect(page.getByTestId('menu-file-save-bundle')).toBeVisible();
  await expect(page.getByTestId('menu-file-open-scene')).toBeVisible();

  // Save → a download whose filename is the native .basher extension.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('menu-file-save-bundle').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.basher$/);

  // Open → the OS file chooser (the real picker, not a seam).
  await page.getByTestId('menu-file-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('menu-file-open-scene').click(),
  ]);
  expect(chooser).toBeTruthy();
});
