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
// Deleting a folder a scene still points at is blocked until break-refs. No open project can hold
// such a pointer any more: no import makes one since #1053, and a project saved with one (a
// `GltfAsset` whose `assetRef` is the reference) is refused on load (#1424). So that path has no
// row here; `importCommon.test.ts` holds the helpers' own checks.
// BVH/FBX leave no ref.
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

/** Total DAG node count — used to prove what an operation added or removed. */
async function dagNodeCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () =>
      Object.keys((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).length,
  );
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

  // Not blocked: no banner, the row and the folder go. The row assertion takes the config's
  // expect budget (15 s on CI, whose OPFS deletes are slow; 5 s locally) — a 5 s override here
  // failed on a slow runner while the delete was still finishing.
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/native-asset/scene.gltf'),
  ).toHaveCount(0);
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
