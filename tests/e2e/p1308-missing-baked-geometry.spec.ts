// #1308 — a baked geometry file that cannot be read is drawn empty and named, and never takes the
// app down.
//
// Apply a transform (the product that writes `baked-geometry/<hash>-<n>.bin`), save, reload: it
// draws. That is the control. Then delete the file and reload. Before the fix the app went blank —
// no editor, no canvas, `A requested file or directory could not be found…` thrown into render by
// `resolveBakedGeometry`, with nothing above `BakedMeshR` to catch it — and the default box went
// with it. Now the editor comes up, everything else draws, the baked object is still in the scene,
// and the asset banner names the missing file once.
//
// REF: src/app/asset/bakedGeometryLoader.ts (`resolveBakedGeometry`, `missingGeometryFor`);
//      tests/e2e/p1048-textured-import-and-missing-image.spec.ts (the same shape for images);
//      issues #1308, #1048.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitSphereOps } from './_splitSphere';

interface BasherWindow {
  __basher_dag?: {
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
      };
      dispatch: (op: unknown) => unknown;
      dispatchAtomic: (ops: unknown[]) => unknown;
    };
  };
  __basher_mesh_world_bounds?: (nodeId: string) => [number, number, number] | null;
  __basher_opfs?: {
    exists: (path: string) => Promise<boolean>;
    delete: (path: string) => Promise<void>;
  };
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_bounds?.('n_box') != null,
    null,
    { timeout: 20_000 },
  );
}

/** The Object posing a `BakedData`, and the file its geometry lives in. */
function bakedObject(page: Page) {
  return page.evaluate(() => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    const entry = Object.entries(nodes).find(([, n]) => {
      const d = n.inputs?.data?.node;
      return n.type === 'Object' && !!d && nodes[d]?.type === 'BakedData';
    });
    if (!entry) return null;
    const geometry = nodes[entry[1].inputs!.data.node].params.geometry as {
      descriptor: { hash: string; vertexCount: number };
    };
    const { hash, vertexCount } = geometry.descriptor;
    return { id: entry[0], path: `baked-geometry/${hash}-${vertexCount}.bin` };
  });
}

function bounds(page: Page, id: string) {
  return page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id),
    id,
  );
}

test('#1308 — a missing baked geometry is drawn empty and named, not a blank app', async ({
  page,
}) => {
  test.slow(); // a bake, a save and two reloads, each observed
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

  await page.evaluate(
    (ops) => {
      const dag = (window as unknown as BasherWindow).__basher_dag!.getState();
      const sceneId = Object.entries(dag.state.nodes).find(([, n]) => n.type === 'Scene')![0];
      dag.dispatchAtomic([
        ...ops,
        {
          type: 'connect',
          from: { node: 'n_apply', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
      ]);
      dag.dispatch({ type: 'setParam', nodeId: 'n_apply', paramPath: 'scale', value: [2, 1, 1] });
    },
    splitSphereOps({ objectId: 'n_apply', radius: 0.5 }),
  );
  await expect.poll(() => bounds(page, 'n_apply')).not.toBeNull();
  const applied = await page.evaluate(async () => {
    const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
    return (await mod.dispatchApplyTransform('n_apply', 'all')) as { ok: boolean };
  });
  expect(applied.ok).toBe(true);
  const baked = (await bakedObject(page))!;
  expect(baked).not.toBeNull();

  // CONTROL: saved and reloaded with the file present, the baked mesh draws at its baked size.
  await page.evaluate(async () => (await import('/src/app/boot.ts')).saveCurrent());
  await page.reload();
  await waitForEditor(page);
  await expect.poll(() => bounds(page, baked.id), { timeout: 15_000 }).toEqual([2, 1, 1]);
  expect(
    await page.evaluate(
      (p) => (window as unknown as BasherWindow).__basher_opfs!.exists(p),
      baked.path,
    ),
  ).toBe(true);
  expect(errors, 'no page errors while the file is there').toEqual([]);

  // #1308: remove the file and reload. The editor comes up, the box still draws, the baked object
  // is still in the scene, and the banner names the file once.
  await page.evaluate(
    (p) => (window as unknown as BasherWindow).__basher_opfs!.delete(p),
    baked.path,
  );
  await page.reload();
  await waitForEditor(page);
  expect(await bounds(page, 'n_box')).toEqual([1, 1, 1]);
  expect((await bakedObject(page))?.id).toBe(baked.id);
  const rows = page.locator('[data-testid^="asset-error-row-baked-geometry/"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('drawn empty');
  expect(errors, 'a missing geometry is never thrown into render').toEqual([]);
});
