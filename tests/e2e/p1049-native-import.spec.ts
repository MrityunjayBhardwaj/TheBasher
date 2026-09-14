// #1049 — a file the native model can hold arrives, through the product's own ingest road, as
// native geometry: a Group over an ordinary `Object` + `PolyMeshData`, with nothing that reads the
// file. It draws the way the default project's box draws, and deleting the source file and
// reloading changes nothing, because the mesh lives in the project.
//
// The control is the box every default project carries (`n_box`): both draws are read off the
// live three.js scene in the same frame, so a road that mounts nothing reads 0 beside the box's 24.
//
// REF: src/app/asset/importGltf.ts (`buildGltfImportOpsFromOpfs`, where the road is chosen),
//      src/core/import/nativeGltfImport.ts, src/nodes/PolyMeshData.ts; issues #1049, #1054.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            id: string;
            type: string;
            params: Record<string, unknown>;
            inputs: Record<string, { node: string } | { node: string }[]>;
          }
        >;
        outputs: { scene?: unknown };
      };
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_opfs?: {
    read: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
    delete: (path: string) => Promise<void>;
  };
}

async function openFresh(page: Page): Promise<void> {
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
  await waitForEditor(page);
}

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
    { timeout: 20_000 },
  );
}

/** Ingest `cube.gltf` exactly as a dropped folder is ingested; returns the entry's OPFS path. */
async function importCube(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(await fetch('/assets/cube.gltf').then((r) => r.arrayBuffer()));
    return w.__basher_ingestGltfFolder!([{ relativePath: 'cube.gltf', bytes }], 'native-cube');
  });
}

/** The import's ids, read off the graph through its edges (never re-derived from a hash). */
async function nativeImport(page: Page) {
  return page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    const all = Object.values(nodes);
    const data = all.filter((n) => n.type === 'PolyMeshData');
    const object = all.find(
      (n) =>
        n.type === 'Object' &&
        !Array.isArray(n.inputs.data) &&
        data.some((d) => d.id === (n.inputs.data as { node: string } | undefined)?.node),
    );
    const group = object
      ? all.find(
          (n) =>
            n.type === 'Group' &&
            Array.isArray(n.inputs.children) &&
            n.inputs.children.some((c) => c.node === object.id),
        )
      : undefined;
    return {
      dataIds: data.map((d) => d.id),
      objectId: object?.id ?? null,
      groupId: group?.id ?? null,
      types: all.map((n) => n.type),
    };
  });
}

/** Vertex counts of what is drawn under `groupId` and under the default box, in one frame. */
async function drawn(page: Page, groupId: string): Promise<{ import: number[]; box: number[] }> {
  return page.evaluate((gid) => {
    const out = { import: [] as number[], box: [] as number[] };
    type Node3 = {
      isMesh?: boolean;
      visible?: boolean;
      name?: string;
      parent?: Node3 | null;
      geometry?: { attributes?: { position?: { count: number } } };
      traverse: (f: (o: Node3) => void) => void;
    };
    const scene = (window as unknown as BasherWindow).__basher_three!.getState().scene as Node3;
    scene.traverse((o) => {
      const count = o.geometry?.attributes?.position?.count;
      if (!o.isMesh || count === undefined) return;
      const chain: string[] = [];
      for (let p: Node3 | null | undefined = o; p; p = p.parent) {
        if (p.visible === false) return;
        if (p.name) chain.push(p.name);
      }
      if (chain.includes(gid)) out.import.push(count);
      else if (chain.includes('n_box')) out.box.push(count);
    });
    return out;
  }, groupId);
}

test.describe('a glTF the native model can hold imports as native geometry (#1049)', () => {
  test('arrives as Object + PolyMeshData under a Group, nothing reads the file, and it draws like the box', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openFresh(page);
    const before = await nativeImport(page);

    await importCube(page);
    await expect
      .poll(async () => (await nativeImport(page)).dataIds.length)
      .toBe(before.dataIds.length + 1);
    const after = await nativeImport(page);
    expect(after.groupId).not.toBeNull();
    // Nothing on the clone road was written for this import.
    const count = (types: string[], t: string) => types.filter((x) => x === t).length;
    expect(count(after.types, 'GltfAsset')).toBe(count(before.types, 'GltfAsset'));
    expect(count(after.types, 'GltfData')).toBe(count(before.types, 'GltfData'));

    // The box control first, so a scene that draws nothing at all cannot pass as a match.
    await expect.poll(async () => (await drawn(page, after.groupId!)).box).toEqual([24]);
    await expect.poll(async () => (await drawn(page, after.groupId!)).import).toEqual([24]);
    await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('deleting the source file and reloading changes nothing', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openFresh(page);
    const entryPath = await importCube(page);
    await expect.poll(async () => (await nativeImport(page)).groupId).not.toBeNull();
    const imported = await nativeImport(page);

    // Save explicitly and wait until the project file on disk holds the mesh data node.
    const projectId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
    expect(projectId, 'the editor has a current project to save into').not.toBeNull();
    await page.keyboard.press('ControlOrMeta+s');
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ path, id }) => {
              const w = window as unknown as BasherWindow;
              if (!(await w.__basher_opfs!.exists(path))) return false;
              return new TextDecoder().decode(await w.__basher_opfs!.read(path)).includes(id);
            },
            { path: `projects/${projectId}/project.json`, id: imported.dataIds[0] },
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    // The source goes away entirely.
    await page.evaluate(
      (p) => (window as unknown as BasherWindow).__basher_opfs!.delete(p),
      entryPath,
    );
    expect(
      await page.evaluate(
        (p) => (window as unknown as BasherWindow).__basher_opfs!.exists(p),
        entryPath,
      ),
    ).toBe(false);

    await page.reload();
    await waitForEditor(page);
    const reloaded = await nativeImport(page);
    expect(reloaded.groupId).toBe(imported.groupId);
    expect(reloaded.dataIds).toEqual(imported.dataIds);
    await expect.poll(async () => (await drawn(page, imported.groupId!)).box).toEqual([24]);
    await expect.poll(async () => (await drawn(page, imported.groupId!)).import).toEqual([24]);
    await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
