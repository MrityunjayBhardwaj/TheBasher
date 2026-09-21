// #1052 — a glTF node with two primitives imports native as ONE mesh with a material slot per
// primitive, and is still drawn that way after Apply, save, reload, and under an Array modifier.
//
// ── WHY THE DRAWN SIDE, AND WHICH PART OF IT ──────────────────────────────────────────
//
// The unit tier pins each piece: the reader writes `material_index` [0, 1], the data node mints it
// into the attribute set, the registry lays out groups from it, Apply carries it. None of them can
// say that the live mesh ends up with a material ARRAY over a matching group layout. When the two
// disagree, `resolveMeshMaterial` falls back to the first material alone, so a broken carry draws a
// wholly red quad with nothing thrown. So this reads, per import, the drawn mesh's material list and
// its geometry's groups together: two materials, red then blue, over one group per slot.
//
// The six clone-road specs that use these fixtures import through `__basher_importGltf`, which never
// tries the native road, so they keep covering the clone road. This file imports through the shared
// chain (`__basher_ingestGltfFolder`), the road a drop or the picker takes.
//
// REF: src/core/import/nativeGltfImport.ts (`readGltfMesh`, `primitiveSlots`),
//      src/nodes/PolyMeshData.ts, src/nodes/meshAttributes.ts (`storedMeshAttributes`),
//      src/app/resolveMeshMaterial.ts, tests/e2e/_importedMesh.ts; issue #1052.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { importedMeshes } from './_importedMesh';

interface BasherWindow {
  __basher_dag?: { getState: () => { state: { outputs: { scene?: { node: string } } } } };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_opfs?: {
    read: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
  };
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

async function ingest(page: Page, file: string, folder: string): Promise<void> {
  await page.evaluate(
    async ({ file, folder }) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await w.__basher_ingestGltfFolder!([{ relativePath: file, bytes }], folder);
    },
    { file, folder },
  );
}

/** What one import root draws: every mesh's materials, groups and vertex count. */
async function drawn(page: Page, rootId: string) {
  return page.evaluate((id) => {
    type Mat = {
      color?: { getHexString: () => string };
      roughnessMap?: { image?: { width?: number } | null } | null;
    };
    type O3 = {
      isMesh?: boolean;
      material?: Mat | Mat[];
      geometry?: {
        groups: { start: number; count: number; materialIndex?: number }[];
        getAttribute: (n: string) => { count: number } | undefined;
      };
      traverse: (f: (o: O3) => void) => void;
    };
    const w = window as unknown as {
      __basher_three: { getState: () => { scene: { getObjectByName: (n: string) => O3 } } };
    };
    const meshes: {
      colors: string[];
      roughnessMapOk: boolean[];
      groups: number[];
      vertices: number;
    }[] = [];
    w.__basher_three
      .getState()
      .scene.getObjectByName(id)
      ?.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        meshes.push({
          colors: mats.map((m) => (m?.color ? `#${m.color.getHexString()}` : '')),
          roughnessMapOk: mats.map((m) => (m?.roughnessMap?.image?.width ?? 0) > 0),
          groups: (o.geometry?.groups ?? []).map((g) => g.materialIndex ?? -1),
          vertices: o.geometry?.getAttribute('position')?.count ?? 0,
        });
      });
    return meshes;
  }, rootId);
}

/** The two imports, each one native Object over one mesh, told apart by their folder's file. */
async function subjects(page: Page) {
  const rows = await importedMeshes(page);
  return rows.map((r) => ({
    road: r.road,
    rootId: r.rootId,
    objectId: r.objectId,
    slots: r.slots.length,
  }));
}

/** Both imports drawn with a red slot and a blue slot, over groups that alternate by slot. */
async function expectTwoSlotsDrawn(page: Page, step: string, groups: number[]): Promise<void> {
  await expect
    .poll(async () => {
      const rows = await subjects(page);
      return Promise.all(
        rows.map(async (r) => {
          const meshes = await drawn(page, r.rootId);
          return {
            road: r.road,
            slots: r.slots,
            meshes: meshes.map((m) => ({ colors: m.colors, groups: m.groups })),
          };
        }),
      );
    }, step)
    .toEqual(
      Array(2).fill({
        road: 'native',
        slots: 2,
        meshes: [{ colors: ['#ff0000', '#0000ff'], groups }],
      }),
    );
}

test('#1052 — two primitives import as one mesh with two slots, and stay so through Apply, save and reload', async ({
  page,
}) => {
  test.slow(); // two imports, two Applies, a save and a reload, each observed
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFresh(page);

  await ingest(page, 'two-material-quad.gltf', 'p1052-plain');
  await ingest(page, 'two-material-textured-quad.gltf', 'p1052-textured');
  await expectTwoSlotsDrawn(page, 'after import', [0, 1]);

  // The textured quad's blue material samples a roughness map, and only its slot draws one.
  const rows = await subjects(page);
  await expect
    .poll(async () => {
      const all = await Promise.all(rows.map((r) => drawn(page, r.rootId)));
      return all.map((meshes) => meshes[0]?.roughnessMapOk ?? null).sort();
    }, 'the roughness map, on the blue slot of the textured quad alone')
    .toEqual([
      [false, false],
      [false, true],
    ]);

  // A mirroring Apply rewrites the stored mesh — the carry of every face's slot is what is tested.
  for (const { objectId } of rows) {
    const result = await page.evaluate(async (id) => {
      type Dag = {
        getState: () => {
          state: {
            nodes: Record<
              string,
              { params: Record<string, unknown>; inputs: Record<string, unknown> }
            >;
          };
          dispatchAtomic: (ops: unknown[], s: string, l: string) => void;
        };
      };
      const dag = (window as unknown as { __basher_dag: Dag }).__basher_dag;
      const meshOf = () => {
        const { nodes } = dag.getState().state;
        const dataId = (nodes[id].inputs.data as { node: string }).node;
        return JSON.stringify(nodes[dataId].params.mesh);
      };
      const before = meshOf();
      dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: id, paramPath: 'scale', value: [-1.5, 1, 1] }],
          'e2e',
          '#1052 pose before Apply',
        );
      const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
      const applied = (await mod.dispatchApplyTransform(id, 'all')) as { ok: boolean };
      return { ok: applied.ok, meshRewritten: meshOf() !== before };
    }, objectId);
    expect(result, `Apply on ${objectId}`).toEqual({ ok: true, meshRewritten: true });
  }
  await expectTwoSlotsDrawn(page, 'after Apply', [0, 1]);

  const projectId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  expect(projectId, 'the editor has a current project to save into').not.toBeNull();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(
      () =>
        page.evaluate(async (path) => {
          const w = window as unknown as BasherWindow;
          if (!(await w.__basher_opfs!.exists(path))) return 0;
          const text = new TextDecoder().decode(await w.__basher_opfs!.read(path));
          return text.split('"material_index"').length - 1;
        }, `projects/${projectId}/project.json`),
      { timeout: 15_000 },
    )
    .toBe(2);

  await page.reload();
  await waitForEditor(page);
  await expectTwoSlotsDrawn(page, 'after reload', [0, 1]);

  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('#1052 — an Array modifier over the two-slot import draws both slots on every copy', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFresh(page);
  await ingest(page, 'two-material-quad.gltf', 'p1052m-plain');
  await ingest(page, 'two-material-textured-quad.gltf', 'p1052m-textured');
  await expectTwoSlotsDrawn(page, 'after import', [0, 1]);

  const rows = await subjects(page);
  const vertices = async () =>
    Promise.all(rows.map(async (r) => (await drawn(page, r.rootId))[0]?.vertices ?? 0));
  const before = await vertices();
  expect(before.every((v) => v > 0)).toBe(true);

  for (const [i, { objectId }] of rows.entries()) {
    await page.evaluate(
      ({ objectId, arr }) => {
        type Dag = {
          getState: () => {
            state: { nodes: Record<string, { inputs: Record<string, unknown> }> };
            dispatchAtomic: (ops: unknown[], s: string, l: string) => void;
          };
        };
        const dag = (window as unknown as { __basher_dag: Dag }).__basher_dag.getState();
        const mesh = (dag.state.nodes[objectId].inputs.data as { node: string }).node;
        dag.dispatchAtomic(
          [
            {
              type: 'disconnect',
              from: { node: mesh, socket: 'out' },
              to: { node: objectId, socket: 'data' },
            },
            { type: 'addNode', nodeId: arr, nodeType: 'ArrayModifier', params: { count: 2 } },
            {
              type: 'connect',
              from: { node: mesh, socket: 'out' },
              to: { node: arr, socket: 'target' },
            },
            {
              type: 'connect',
              from: { node: arr, socket: 'out' },
              to: { node: objectId, socket: 'data' },
            },
          ],
          'e2e',
          '#1052 splice Array',
        );
      },
      { objectId, arr: `p1052_arr_${i}` },
    );
  }

  // The vertex count doubling says the modifier ran; the groups say each copy kept its slots. The
  // import roots are addressed by the ids already held, because the structural root scan does not
  // see an import once a modifier sits between its Object and its mesh.
  await expect.poll(vertices, 'the Array ran').toEqual(before.map((v) => v * 2));
  await expect
    .poll(
      async () =>
        Promise.all(
          rows.map(async (r) =>
            (await drawn(page, r.rootId)).map((m) => ({ colors: m.colors, groups: m.groups })),
          ),
        ),
      'under the Array modifier',
    )
    .toEqual(Array(2).fill([{ colors: ['#ff0000', '#0000ff'], groups: [0, 1, 0, 1] }]));

  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
});
