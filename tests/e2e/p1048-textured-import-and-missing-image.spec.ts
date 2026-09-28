// #1050 + #1048 — a textured import is native and owns its images; an image that goes missing is
// drawn magenta and named, and never takes the app down.
//
// The first half is #1050's done-criteria observed end to end, which no single spec did: three
// textured files import native and draw their maps (a UV transform and a second UV set included),
// and keep drawing them after the SOURCE files are deleted, after a reload, and in a duplicate —
// every fixture embeds its image as a data URI, so once the sources are gone only the project's
// own image folder (`projects/<id>/images/`) can supply the pixels.
//
// The second half is the control that makes the first mean something, and it is where #1048 was
// found on the native road: remove the project's image files and reload. Before the fix the app
// went blank (no scene, `A requested file or directory could not be found…` thrown into render by
// `resolveBakedTexture`). Now each map is a one-texel magenta stand-in — Blender draws an image it
// cannot find magenta and keeps the file open — the meshes stay drawn, and the asset banner names
// each missing image once.
//
// REF: src/app/asset/bakedTextureLoader.ts (`resolveBakedTexture`, `missingTextureFor`);
//      src/core/project/projectImages.ts; issues #1048, #1050.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, importedMeshes } from './_importedMesh';

interface Opfs {
  read: (path: string) => Promise<Uint8Array>;
  exists: (path: string) => Promise<boolean>;
  delete: (path: string) => Promise<void>;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_opfs?: Opfs;
}

const FILES = ['albedo-textured-quad.gltf', 'uv-transform-quad.gltf', 'two-uv-quad.gltf'];

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_three?.getState().scene &&
        w.__basher_ingestGltfFolder &&
        w.__basher_opfs,
      );
    },
    null,
    { timeout: 20_000 },
  );
}

/** Each import's road and what its base-colour map draws. */
async function drawn(page: Page) {
  const meshes = await importedMeshes(page);
  const draws = await drawnImportMeshes(page);
  return meshes.map((m) => {
    const d = draws.find((x) => x.rootId === m.rootId);
    return {
      road: m.road,
      mapImageOk: d?.mapImageOk ?? false,
      mapWidth: d?.mapWidth ?? null,
      mapChannel: d?.mapChannel ?? null,
      mapUvMatrix: d?.mapUvMatrix?.map((v) => Number(v.toFixed(3))) ?? null,
    };
  });
}

/** What every step before the control must show: three native imports, each map as imported. */
const AS_IMPORTED = [
  { mapWidth: 64, mapChannel: 0, mapUvMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  // KHR_texture_transform: scale (2, 3), offset (0.1, 0.2).
  { mapWidth: 64, mapChannel: 0, mapUvMatrix: [2, 0, 0, 0, 3, 0, 0.1, 0.2, 1] },
  // The base colour samples the second UV set.
  { mapWidth: 4, mapChannel: 1, mapUvMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
].map((m) => ({ road: 'native', mapImageOk: true, ...m }));

async function expectAsImported(page: Page, step: string): Promise<void> {
  await expect.poll(() => drawn(page), { message: step, timeout: 15_000 }).toEqual(AS_IMPORTED);
}

/** The project-store image refs a saved project names, and whether each file is there. */
function projectImages(page: Page, projectId: string) {
  return page.evaluate(async (pid) => {
    const opfs = (window as unknown as BasherWindow).__basher_opfs!;
    const path = `projects/${pid}/project.json`;
    if (!(await opfs.exists(path))) return [];
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (o.store === 'project' && typeof o.hash === 'string') keys.add(o.hash);
      Object.values(o).forEach(walk);
    };
    walk(JSON.parse(new TextDecoder().decode(await opfs.read(path))));
    const out: { key: string; exists: boolean }[] = [];
    for (const key of keys)
      out.push({ key, exists: await opfs.exists(`projects/${pid}/images/${key}`) });
    return out;
  }, projectId);
}

test('#1050 #1048 — textured imports own their images; a missing one draws magenta, not a blank app', async ({
  page,
}) => {
  test.slow(); // three imports, a save, two reloads, a duplicate and a third reload, each observed
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('basher', { recursive: true });
    } catch {
      /* not present */
    }
  });
  await page.reload();
  await waitForEditor(page);
  for (const [i, file] of FILES.entries()) {
    await page.evaluate(
      async ({ file, folder }) => {
        const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
        await (window as unknown as BasherWindow).__basher_ingestGltfFolder!(
          [{ relativePath: file, bytes }],
          folder,
        );
      },
      { file, folder: `p1048-${i}` },
    );
  }
  await expectAsImported(page, 'after import');

  // Save: the project names its images, and each file is in its own folder. Two quads share one
  // image, stored once by content.
  const projectId = (await page.evaluate(() => localStorage.getItem('basher.lastProjectId')))!;
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await projectImages(page, projectId)).length).toBe(2);
  expect((await projectImages(page, projectId)).every((r) => r.exists)).toBe(true);

  // Delete every source file — nothing outside the project may supply the pixels now.
  const deleted = await page.evaluate(async (files) => {
    const opfs = (window as unknown as BasherWindow).__basher_opfs!;
    const out: boolean[] = [];
    for (const [i, file] of files.entries()) {
      const path = `user-imports/p1048-${i}/${file}`;
      const had = await opfs.exists(path);
      await opfs.delete(path);
      out.push(had && !(await opfs.exists(path)));
    }
    return out;
  }, FILES);
  expect(deleted, 'each source existed and is gone').toEqual([true, true, true]);
  await page.reload();
  await waitForEditor(page);
  await expectAsImported(page, 'after deleting the sources and reloading');

  // A duplicate carries the images under its own id.
  const dupId = await page.evaluate(async () => {
    const boot = (await import('/src/app/boot.ts')) as {
      duplicateCurrentProject: (name?: string) => Promise<string>;
    };
    return boot.duplicateCurrentProject('p1048-dup');
  });
  expect(dupId).not.toBe(projectId);
  expect((await projectImages(page, dupId)).every((r) => r.exists)).toBe(true);
  await page.reload();
  await waitForEditor(page);
  expect(await page.evaluate(() => localStorage.getItem('basher.lastProjectId'))).toBe(dupId);
  await expectAsImported(page, 'in the duplicate, after reload');
  expect(errors, 'no page errors while the images are there').toEqual([]);

  // CONTROL, and #1048: remove the duplicate's image files and reload. The app comes up, every
  // mesh still draws, each map is the one-texel stand-in with its placement intact, and the banner
  // names each missing image once.
  await page.evaluate(
    async ({ pid, keys }) => {
      const opfs = (window as unknown as BasherWindow).__basher_opfs!;
      for (const key of keys) await opfs.delete(`projects/${pid}/images/${key}`);
    },
    { pid: dupId, keys: (await projectImages(page, dupId)).map((r) => r.key) },
  );
  await page.reload();
  await waitForEditor(page);
  await expect
    .poll(() => drawn(page), { timeout: 15_000 })
    .toEqual(AS_IMPORTED.map((m) => ({ ...m, mapWidth: 1 })));
  const rows = page.locator('[data-testid^="asset-error-row-images/"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('drawn magenta');
  expect(errors, 'a missing image is never thrown into render').toEqual([]);
});
