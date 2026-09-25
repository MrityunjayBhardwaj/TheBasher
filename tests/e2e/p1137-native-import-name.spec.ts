// p1137 — a native import lists under the file's own node name (issue #1137).
//
// Before the fix the native importer wrote an `Object` + `PolyMeshData` pair and named neither, so the
// outliner fell back to the generated id (`n_nativeObject_…`) while the clone road showed the file's
// node name. Read here off the rendered outliner row. Apply's refusals quote the same function
// (#1134), so they follow without a separate read.
//
// REF: src/core/import/nativeGltfImport.ts (`objectNameOf`); src/app/sceneTreeWalk.ts
//      (`nodeDisplayName`); src/app/SceneTree.tsx; issues #1137, #1134.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { importRoots, importedMeshes } from './_importedMesh';

interface W {
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
    folderName: string,
  ) => Promise<string>;
}

async function drop(page: Page, file: string, folder: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_ingestGltfFolder));
  await page.evaluate(
    async ({ file, folder }) => {
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await (window as unknown as W).__basher_ingestGltfFolder!(
        [{ relativePath: file, bytes }],
        folder,
      );
    },
    { file, folder },
  );
}

test('#1137 — the outliner lists a native import by the file node’s name, not its id', async ({
  page,
}) => {
  await drop(page, 'uv-transform-quad.gltf', 'p1137');
  await expect.poll(async () => (await importRoots(page)).map((r) => r.road)).toEqual(['native']);
  const mesh = (await importedMeshes(page))[0];

  const row = page.getByTestId(`scene-tree-row-${mesh.objectId}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText('UvTransformQuad');
  await expect(row).not.toContainText('n_nativeObject');
});
