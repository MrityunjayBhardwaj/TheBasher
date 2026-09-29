// #1312 — a file that failed to read draws again once it is written back, and new work of the same
// content draws its own, without a reload.
//
// The three suspense loaders cache a failed read so a missing file does not suspend forever, and
// draw a stand-in (#1048 #1308 #1309). Their stores are content-addressed, so a restored file lands
// on the SAME path: the same HDRI imported again, an identical mesh baked, the same image imported.
// Measured before the fix: the cached failure answered for it until a reload — the studio light
// stayed magenta, a brand-new bake drew empty, a brand-new import drew the one-texel stand-in, and
// the banner kept naming a file that was there. Each case below breaks a file, reloads, restores it
// through the product's own door, and then observes WITHOUT reloading or nudging anything.
//
// REF: src/core/storage/writeNotice.ts; src/app/asset/readFailures.ts; issue #1312.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitLightDataId, splitLightOps } from './_splitLight';
import { splitSphereOps } from './_splitSphere';
import { drawnImportMeshes } from './_importedMesh';

interface Obj {
  type: string;
  material?: { map?: { name?: string } | null };
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          {
            type: string;
            params: Record<string, unknown>;
            inputs?: Record<string, { node: string }>;
          }
        >;
        outputs: { scene?: { node: string } };
      };
      dispatch: (op: unknown) => unknown;
      dispatchAtomic: (ops: unknown[]) => unknown;
    };
  };
  __basher_three: { getState: () => { scene: { traverse: (cb: (o: Obj) => void) => void } } };
  __basher_mesh_world_bounds?: (nodeId: string) => [number, number, number] | null;
  __basher_importEnvHdri: (bytes: Uint8Array, filename: string) => Promise<string>;
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_opfs: {
    read: (p: string) => Promise<Uint8Array>;
    exists: (p: string) => Promise<boolean>;
    delete: (p: string) => Promise<void>;
  };
}

async function freshEditor(page: Page, errors: string[]): Promise<void> {
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
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return w.__basher_mesh_world_bounds?.('n_box') != null && !!w.__basher_opfs;
    },
    null,
    { timeout: 20_000 },
  );
}

const bannerRows = (page: Page) => page.locator('[data-testid^="asset-error-row-"]');

/** The project-store image keys a saved project names. */
function projectImageKeys(page: Page, projectId: string): Promise<string[]> {
  return page.evaluate(async (pid) => {
    const w = window as unknown as BasherWindow;
    const path = `projects/${pid}/project.json`;
    if (!(await w.__basher_opfs.exists(path))) return [];
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (o.store === 'project' && typeof o.hash === 'string') keys.add(o.hash);
      Object.values(o).forEach(walk);
    };
    walk(JSON.parse(new TextDecoder().decode(await w.__basher_opfs.read(path))));
    return [...keys];
  }, projectId);
}

test('#1312 — an HDRI imported again draws on the studio light that lost it', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  await freshEditor(page, errors);
  const importHdr = () =>
    page.evaluate(async () => {
      const bytes = new Uint8Array(
        await fetch('/fixtures/env/test.hdr').then((r) => r.arrayBuffer()),
      );
      return (window as unknown as BasherWindow).__basher_importEnvHdri(bytes, 'test.hdr');
    });
  const card = () =>
    page.evaluate(() => {
      let name: string | null = null;
      (window as unknown as BasherWindow).__basher_three.getState().scene.traverse((o) => {
        const map = o.type === 'Mesh' ? o.material?.map : null;
        if (map) name = map.name || '(decoded)';
      });
      return name;
    });

  const ref = await importHdr();
  await page.evaluate(
    ({ ops, dataId, ref }) => {
      const dag = (window as unknown as BasherWindow).__basher_dag.getState();
      const sceneId = dag.state.outputs.scene!.node;
      dag.dispatchAtomic([
        ...ops,
        { type: 'setParam', nodeId: dataId, paramPath: 'tex', value: ref },
        {
          type: 'connect',
          from: { node: 'p1312_light', socket: 'out' },
          to: { node: sceneId, socket: 'lights' },
        },
      ]);
    },
    {
      ops: splitLightOps({
        objectId: 'p1312_light',
        lightKind: 'Area',
        position: [3, 4, 3],
        shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
      }),
      dataId: splitLightDataId('p1312_light'),
      ref,
    },
  );
  await page.evaluate(async () => (await import('/src/app/boot.ts')).saveCurrent());
  await page.evaluate((p) => (window as unknown as BasherWindow).__basher_opfs.delete(p), ref);
  await page.reload();
  await waitForEditor(page);
  await expect.poll(card, { timeout: 15_000 }).toBe('missing-image');
  await expect(bannerRows(page)).toHaveCount(1);

  // Restore through the import door: the same bytes land on the same path.
  expect(await importHdr()).toBe(ref);
  await expect.poll(card, { timeout: 15_000 }).toBe('(decoded)');
  await expect(bannerRows(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('#1312 — an identical bake draws, and so does the object whose file it restored', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  await freshEditor(page, errors);
  const bake = async (id: string, x: number) => {
    await page.evaluate(
      ({ ops, id, x }) => {
        const dag = (window as unknown as BasherWindow).__basher_dag.getState();
        const sceneId = dag.state.outputs.scene!.node;
        dag.dispatchAtomic([
          ...ops,
          {
            type: 'connect',
            from: { node: id, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ]);
        dag.dispatch({ type: 'setParam', nodeId: id, paramPath: 'scale', value: [2, 1, 1] });
        dag.dispatch({ type: 'setParam', nodeId: id, paramPath: 'position', value: [x, 0, 0] });
      },
      { ops: splitSphereOps({ objectId: id, radius: 0.5 }), id, x },
    );
    await expect
      .poll(() =>
        page.evaluate(
          (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id),
          id,
        ),
      )
      .not.toBeNull();
    // Scale only: the position stays on the Object, so both bakes make the same vertices.
    const r = await page.evaluate(async (id) => {
      const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
      return (await mod.dispatchApplyTransform(id, 'scale')) as { ok: boolean };
    }, id);
    expect(r.ok).toBe(true);
  };
  const baked = () =>
    page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag.getState().state.nodes;
      return Object.entries(nodes)
        .filter(
          ([, n]) => n.type === 'Object' && nodes[n.inputs?.data?.node ?? '']?.type === 'BakedData',
        )
        .map(([id, n]) => {
          const d = (
            nodes[n.inputs!.data.node].params.geometry as {
              descriptor: { hash: string; vertexCount: number };
            }
          ).descriptor;
          return {
            id,
            file: `baked-geometry/${d.hash}-${d.vertexCount}.bin`,
            bounds: w.__basher_mesh_world_bounds!(id),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    });

  await bake('A', 0);
  const [a] = await baked();
  await page.evaluate(async () => (await import('/src/app/boot.ts')).saveCurrent());
  await page.evaluate((p) => (window as unknown as BasherWindow).__basher_opfs.delete(p), a.file);
  await page.reload();
  await waitForEditor(page);
  await expect.poll(async () => (await baked())[0].bounds, { timeout: 15_000 }).toEqual([0, 0, 0]);

  await bake('B', 3);
  await expect
    .poll(async () => (await baked()).map((o) => [o.id, o.file === a.file, o.bounds]), {
      timeout: 15_000,
    })
    .toEqual([
      ['A', true, [2, 1, 1]],
      ['B', true, [2, 1, 1]],
    ]);
  await expect(bannerRows(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('#1312 — the same image imported again draws on both imports', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  await freshEditor(page, errors);
  const FILE = 'albedo-textured-quad.gltf';
  const ingest = (folder: string) =>
    page.evaluate(
      async ({ file, folder }) => {
        const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
        await (window as unknown as BasherWindow).__basher_ingestGltfFolder!(
          [{ relativePath: file, bytes }],
          folder,
        );
      },
      { file: FILE, folder },
    );
  const widths = async () => (await drawnImportMeshes(page)).map((d) => d.mapWidth);

  await ingest('p1312-0');
  await expect.poll(widths, { timeout: 15_000 }).toEqual([64]);
  const pid = (await page.evaluate(() => localStorage.getItem('basher.lastProjectId')))!;
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => projectImageKeys(page, pid), { timeout: 15_000 }).toHaveLength(1);
  const keys = await projectImageKeys(page, pid);
  await page.evaluate(
    ({ pid, keys }) =>
      Promise.all(
        keys.map((k) =>
          (window as unknown as BasherWindow).__basher_opfs.delete(`projects/${pid}/images/${k}`),
        ),
      ),
    { pid, keys },
  );
  await page.reload();
  await waitForEditor(page);
  await expect.poll(widths, { timeout: 15_000 }).toEqual([1]);

  await ingest('p1312-1');
  await expect.poll(widths, { timeout: 15_000 }).toEqual([64, 64]);
  await expect(bannerRows(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
