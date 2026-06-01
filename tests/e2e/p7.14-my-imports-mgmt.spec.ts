// P7.14 Wave B — My-Imports management Lokayata gate (closes #112).
//
// Drives the REAL ︙ overflow menu (H58 — not a programmatic helper) to rename,
// delete, and break-refs-delete a My-Imports asset, observing BOTH sides of the
// rename invariant: OPFS folder moved AND the GltfAsset.assetRef followed.
//
// Key grounded fact (CONTEXT D-03): an imported glTF leaves a GltfAsset node
// whose assetRef IS a reference — so deleting it is ALWAYS blocked (the asset
// is in use) until break-refs. BVH/FBX leave no ref → their delete is always
// unreferenced/immediate. Both paths are exercised here.
//
// REF: PLAN 7.14 Wave B (B4); CONTEXT D-03/D-05/D-06; issue #112;
//      src/app/AssetsPopover.tsx (the ︙ menu + rename input + delete banner);
//      src/app/asset/importCommon.ts (rename/delete helpers).

import { test, expect } from './_fixtures';

interface DagNode {
  type: string;
  params?: Record<string, unknown>;
}
interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface BasherWindow {
  __basher_dag: { getState: () => { state: { nodes: Record<string, DagNode> } } };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<IngestFileShape>,
    folderName: string,
  ) => Promise<string>;
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
}

const FLAT_GLTF = [
  { urlPath: '/fixtures/multifile/flat/scene.gltf', relativePath: 'scene.gltf' },
  { urlPath: '/fixtures/multifile/flat/scene.bin', relativePath: 'scene.bin' },
  { urlPath: '/fixtures/multifile/flat/texture.png', relativePath: 'texture.png' },
];

async function ingestGltf(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.evaluate(
    async ({ fixtures, folderName }) => {
      const w = window as unknown as BasherWindow;
      const files: IngestFileShape[] = [];
      for (const f of fixtures) {
        const buf = await fetch(f.urlPath).then((r) => r.arrayBuffer());
        files.push({ relativePath: f.relativePath, bytes: new Uint8Array(buf) });
      }
      await w.__basher_ingestGltfFolder!(files, folderName);
    },
    { fixtures: FLAT_GLTF, folderName: name },
  );
}

async function opfsDirExists(
  page: import('@playwright/test').Page,
  name: string,
): Promise<boolean> {
  return page.evaluate(async (n) => {
    try {
      const root = await navigator.storage.getDirectory();
      const basher = await root.getDirectoryHandle('basher');
      const ui = await basher.getDirectoryHandle('user-imports');
      await ui.getDirectoryHandle(n);
      return true;
    } catch {
      return false;
    }
  }, name);
}

async function gltfAssetRefs(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return Object.values(w.__basher_dag.getState().state.nodes)
      .filter((n) => n.type === 'GltfAsset')
      .map((n) => (n.params as { assetRef?: string } | undefined)?.assetRef ?? '');
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_ingestGltfFolder && w.__basher_ingestBvhFile);
  });
});

test('P7.14 (rename) — ︙ Rename moves OPFS folder AND the GltfAsset.assetRef follows', async ({
  page,
}) => {
  await ingestGltf(page, 'flat-asset');

  await page.getByTestId('top-toolbar-assets').click();
  await expect(page.getByTestId('library-popover')).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/flat-asset/scene.gltf'),
  ).toBeVisible({ timeout: 5_000 });

  // Drive the real ︙ menu → Rename.
  await page.getByTestId('library-popover-menu-btn-flat-asset').click();
  await page.getByTestId('library-popover-menu-rename-flat-asset').click();
  const input = page.getByTestId('library-popover-rename-input-flat-asset');
  await input.fill('renamed-asset');
  await input.press('Enter');

  // My-Imports row now shows the new path. Rename is the heaviest mgmt op —
  // the new row appears only after the full async chain completes (copy-all →
  // verify-all → assetRef rewrite → viewport glTF reload → delete-old → bump →
  // React re-enumerate). That chain is CPU-bound (React + three.js reload), not
  // IO-bound (the fixture is ~3.5 KB), so on a slow CI runner it routinely
  // exceeds a 5 s window even though it completes correctly. Poll generously —
  // the sibling OPFS/assetRef assertions below already use expect.poll.
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/renamed-asset/scene.gltf'),
  ).toBeVisible({ timeout: 15_000 });

  // OPFS moved.
  expect(await opfsDirExists(page, 'renamed-asset')).toBe(true);
  expect(await opfsDirExists(page, 'flat-asset')).toBe(false);

  // assetRef followed (BOTH sides of the invariant — H40 boundary pair).
  await expect
    .poll(async () => await gltfAssetRefs(page))
    .toContain('user-imports/renamed-asset/scene.gltf');
});

test('P7.14 (delete unreferenced) — ︙ Delete of a BVH (no ref) removes it + clears OPFS', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const buf = await fetch('/fixtures/anim/walk.bvh').then((r) => r.arrayBuffer());
    await w.__basher_ingestBvhFile!(new Uint8Array(buf), 'walk');
  });

  await page.getByTestId('top-toolbar-assets').click();
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/walk/walk.bvh'),
  ).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('library-popover-menu-btn-walk').click();
  await page.getByTestId('library-popover-menu-delete-walk').click();

  // Row gone, no banner (unreferenced → immediate), OPFS cleared.
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/walk/walk.bvh'),
  ).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId('library-popover-delete-banner')).toHaveCount(0);
  await expect.poll(async () => await opfsDirExists(page, 'walk')).toBe(false);
});

test('P7.14 (delete referenced) — ︙ Delete of a referenced glTF blocks with a banner, then break-refs', async ({
  page,
}) => {
  await ingestGltf(page, 'used-asset');
  // The import created a GltfAsset referencing the asset.
  await expect
    .poll(async () => await gltfAssetRefs(page))
    .toContain('user-imports/used-asset/scene.gltf');

  await page.getByTestId('top-toolbar-assets').click();
  await page.getByTestId('library-popover-menu-btn-used-asset').click();
  await page.getByTestId('library-popover-menu-delete-used-asset').click();

  // Blocked: banner shown, asset NOT deleted.
  await expect(page.getByTestId('library-popover-delete-banner')).toBeVisible({ timeout: 5_000 });
  expect(await opfsDirExists(page, 'used-asset')).toBe(true);

  // Delete anyway → break refs.
  await page.getByTestId('library-popover-delete-anyway-used-asset').click();

  await expect.poll(async () => await opfsDirExists(page, 'used-asset')).toBe(false);
  await expect
    .poll(async () => await gltfAssetRefs(page))
    .not.toContain('user-imports/used-asset/scene.gltf');
});
