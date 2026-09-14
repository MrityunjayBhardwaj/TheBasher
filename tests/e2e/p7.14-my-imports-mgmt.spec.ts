// P7.14 Wave B — My-Imports management Lokayata gate (closes #112).
//
// Drives the REAL ︙ overflow menu (H58 — not a programmatic helper) to rename and delete a
// My-Imports entry, observing both the folder on disk and the scene that was imported from it.
//
// ── WHAT A MY-IMPORTS FOLDER MEANS NOW (#1074) ───────────────────────────────────────
//
// A file the native model holds arrives as native geometry (#1049, #1050): the mesh lives in the
// project and its images in the project's own image folder. After the import the scene no longer
// points at `user-imports/<name>/` at all — the Blender model. So for a native import:
//   · Rename moves the folder and the scene is untouched (nothing followed, nothing had to).
//   · Delete is not blocked, and the scene keeps drawing the import, across a reload.
// A file the native reader refuses still arrives through the file's copy, as a `GltfAsset`
// whose `assetRef` IS a reference; deleting its folder is blocked until break-refs. That path is
// kept on a still-refused fixture (a skinned .glb) and asserts its road, so it reds the day
// skinning goes native and the break-refs path loses its last fixture. BVH/FBX leave no ref.
//
// REF: PLAN 7.14 Wave B (B4); CONTEXT D-03/D-05/D-06; issues #112, #1074, #1054;
//      src/app/AssetLibrary.tsx (the ︙ menu + rename input + delete banner);
//      src/app/asset/importCommon.ts (rename/delete helpers);
//      tests/e2e/_importedMesh.ts (import roots + drawn reader, both roads).

import { test, expect } from './_fixtures';
import { drawnImportMeshes, importRoots } from './_importedMesh';

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
/** Still refused by the native reader (skinned), so it imports through the file's copy. */
const SKINNED_GLB = [{ urlPath: '/assets/skinned-bar.glb', relativePath: 'skinned-bar.glb' }];

async function ingestGltf(
  page: import('@playwright/test').Page,
  name: string,
  fixtures = FLAT_GLTF,
): Promise<void> {
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
    { fixtures, folderName: name },
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

/** Total DAG node count — used to prove what an operation added or removed. */
async function dagNodeCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () =>
      Object.keys((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).length,
  );
}

/** Count of nodes carrying an assetRef containing `sub` (GltfAsset + the
 *  GltfChild satellites) — the assetRef-tagged slice of the import footprint. */
async function importTaggedNodeCount(
  page: import('@playwright/test').Page,
  sub: string,
): Promise<number> {
  return page.evaluate((s) => {
    const nodes = (window as unknown as BasherWindow).__basher_dag.getState().state.nodes;
    return Object.values(nodes).filter((n) => {
      const ref = (n.params as { assetRef?: string } | undefined)?.assetRef;
      return typeof ref === 'string' && ref.includes(s);
    }).length;
  }, sub);
}

/** Whether any node's params mention `text` anywhere — "does the scene still point at this folder?" */
async function sceneMentions(page: import('@playwright/test').Page, text: string) {
  return page.evaluate(
    (t) =>
      JSON.stringify(
        (window as unknown as BasherWindow).__basher_dag.getState().state.nodes,
      ).includes(t),
    text,
  );
}

/** The one import root, polled until its mesh draws with a decoded base map. */
async function drawnTexturedRoot(page: import('@playwright/test').Page, road: 'native' | 'clone') {
  await expect.poll(async () => (await importRoots(page)).map((r) => r.road)).toEqual([road]);
  const [{ rootId }] = await importRoots(page);
  await expect
    .poll(async () => (await drawnImportMeshes(page, rootId)).some((m) => m.hasMap && m.mapImageOk))
    .toBe(true);
  return rootId;
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

// ⚠️ THE TITLE IS A FROZEN BASELINE KEY (`accepted-failures.txt`). It still names the clone
// road's "assetRef follows"; the body asserts what rename means for a native import (#1074).
test('P7.14 (rename) — ︙ Rename moves OPFS folder AND the GltfAsset.assetRef follows', async ({
  page,
}) => {
  await ingestGltf(page, 'flat-asset');
  const rootId = await drawnTexturedRoot(page, 'native');
  const nodesBefore = await dagNodeCount(page);
  // The native import holds nothing that points at its folder.
  expect(await sceneMentions(page, 'flat-asset')).toBe(false);

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

  // My-Imports row now shows the new path. Rename is the heaviest mgmt op (copy-all →
  // verify-all → delete-old → bump → React re-enumerate), so poll generously.
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/renamed-asset/scene.gltf'),
  ).toBeVisible({ timeout: 15_000 });

  // OPFS moved.
  expect(await opfsDirExists(page, 'renamed-asset')).toBe(true);
  expect(await opfsDirExists(page, 'flat-asset')).toBe(false);

  // The scene is untouched: same root, same node count, no reference to either name, and it
  // still draws textured — nothing followed the folder because nothing pointed at it.
  expect((await importRoots(page)).map((r) => r.rootId)).toEqual([rootId]);
  expect(await dagNodeCount(page)).toBe(nodesBefore);
  expect(await sceneMentions(page, 'renamed-asset')).toBe(false);
  expect(await sceneMentions(page, 'flat-asset')).toBe(false);
  expect((await drawnImportMeshes(page, rootId)).some((m) => m.hasMap && m.mapImageOk)).toBe(true);
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

test('P7.14 (delete native import) — ︙ Delete is immediate and the scene keeps drawing it across a reload', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await ingestGltf(page, 'native-asset');
  const rootId = await drawnTexturedRoot(page, 'native');
  const nodesAfterImport = await dagNodeCount(page);

  await page.getByTestId('top-toolbar-assets').click();
  await page.getByTestId('library-popover-menu-btn-native-asset').click();
  await page.getByTestId('library-popover-menu-delete-native-asset').click();

  // Not blocked: no banner, the row and the folder go.
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/native-asset/scene.gltf'),
  ).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId('library-popover-delete-banner')).toHaveCount(0);
  await expect.poll(async () => await opfsDirExists(page, 'native-asset')).toBe(false);

  // The scene lost nothing: same nodes, still drawn textured…
  expect(await dagNodeCount(page)).toBe(nodesAfterImport);
  expect((await drawnImportMeshes(page, rootId)).some((m) => m.hasMap && m.mapImageOk)).toBe(true);

  // …and after a reload, with the file's bytes gone, it still draws its texture — the mesh and
  // its image live in the project, not in the deleted folder.
  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await importRoots(page)).map((r) => r.rootId)).toEqual([rootId]);
  await expect
    .poll(async () => (await drawnImportMeshes(page, rootId)).some((m) => m.hasMap && m.mapImageOk))
    .toBe(true);
});

test('P7.14 (delete referenced) — ︙ Delete of a referenced glTF blocks with a banner, then break-refs', async ({
  page,
}) => {
  const baselineNodes = await dagNodeCount(page);
  await ingestGltf(page, 'used-asset', SKINNED_GLB);
  // Still the clone road (skinned) — see the header. When skinning goes native this reds, and
  // the break-refs path has no fixture left to run on.
  await expect.poll(async () => (await importRoots(page)).map((r) => r.road)).toEqual(['clone']);
  // The import created a GltfAsset referencing the asset.
  await expect
    .poll(async () => await gltfAssetRefs(page))
    .toContain('user-imports/used-asset/skinned-bar.glb');
  // The import added a whole footprint (GltfAsset + wrapper Group + child satellites), so the
  // graph grew past baseline.
  expect(await dagNodeCount(page)).toBeGreaterThan(baselineNodes);

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
    .not.toContain('user-imports/used-asset/skinned-bar.glb');
  // #127: the WHOLE import footprint is gone — no orphan wrapper Group, no child satellites,
  // no clip ghosts. Node count returns to baseline and zero nodes still carry the deleted
  // asset's ref.
  await expect.poll(async () => await dagNodeCount(page)).toBe(baselineNodes);
  expect(await importTaggedNodeCount(page, 'user-imports/used-asset/')).toBe(0);
});
