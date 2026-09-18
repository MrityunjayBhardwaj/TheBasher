// p1158 — a keyed Group keeps the stored mesh under it, and the editor stays up.
//
// An overlay on a Group clones the Group's value, and that value carries its children's. The clone
// was JSON, which destroys a stored mesh's typed arrays; on a cold geometry cache the first draw then
// threw `meshSplitLayout: points holds undefined numbers` and unmounted the editor. A session that
// drew the mesh before keying the parent never saw it (the geometry was cached by key); OPENING A
// SAVED PROJECT is the everyday cold start, so that is the path this spec takes.
//
// REF: src/nodes/overlayChannels.ts (`cloneForOverlay`), src/app/overlayTransients.ts; #1158, #1099.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
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
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<Uint8Array>;
  };
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_three?.getState().scene &&
        w.__basher_ingestGltfFolder,
      );
    },
    { timeout: 20_000 },
  );
}

/** The import's shape, read through the graph's own edges rather than re-derived from a hash. */
async function imported(page: Page) {
  return page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag!.getState().state.nodes;
    const all = Object.values(nodes);
    const childrenOf = (id: string) => {
      const kids = all.find((n) => n.id === id)?.inputs.children;
      return Array.isArray(kids) ? kids.map((k) => k.node) : [];
    };
    const data = all.filter((n) => n.type === 'PolyMeshData');
    const object = all.find(
      (n) =>
        n.type === 'Object' &&
        !Array.isArray(n.inputs.data) &&
        data.some((d) => d.id === (n.inputs.data as { node: string } | undefined)?.node),
    );
    // The child's parent is whoever holds it as a child; the import Group is that node's parent.
    const parent = object ? all.find((n) => childrenOf(n.id).includes(object.id)) : undefined;
    const importGroup = parent ? all.find((n) => childrenOf(n.id).includes(parent.id)) : undefined;
    return {
      objectId: object?.id ?? null,
      parentId: parent?.id ?? null,
      parentType: parent?.type ?? null,
      parentParams: (parent?.params ?? {}) as { position?: number[] },
      importGroupId: importGroup?.id ?? null,
      gltfNodes: all.filter((n) => n.type === 'GltfData' || n.type === 'GltfAsset').length,
    };
  });
}

/**
 * Where three actually draws the one mesh under `groupId`, in world space.
 *
 * Found by walking the import Group rather than by node id: only a TOP-LEVEL scene child carries
 * its node id on the drawn object (`SceneFromDAG.tsx:2038`), so a nested object has no name to look
 * up. That is #1075, and it is why a click inside an import selects the whole import — a gap this
 * change neither creates nor closes.
 */
async function drawnMeshWorld(page: Page, groupId: string): Promise<number[] | null> {
  return page.evaluate((id) => {
    type O3 = {
      isMesh?: boolean;
      name?: string;
      matrixWorld: { elements: number[] };
      traverse: (f: (o: O3) => void) => void;
    };
    const scene = (window as unknown as W).__basher_three!.getState().scene as unknown as {
      getObjectByName: (n: string) => O3 | undefined;
      updateMatrixWorld: (force?: boolean) => void;
    };
    scene.updateMatrixWorld(true);
    const group = scene.getObjectByName(id);
    if (!group) return null;
    let found: number[] | null = null;
    group.traverse((o) => {
      if (!o.isMesh || found) return;
      const e = o.matrixWorld.elements;
      found = [e[12], e[13], e[14]];
    });
    return found;
  }, groupId);
}

test('#1158 — a keyed empty over an imported mesh survives save and reload, drawn and animated', async ({
  page,
}) => {
  test.slow(); // an ingest, a save, a reload, each observed
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
  await page.evaluate(async () => {
    const w = window as unknown as W;
    const bytes = new Uint8Array(
      await fetch('/assets/nested-cube.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder!([{ relativePath: 'nested-cube.gltf', bytes }], 'p1158');
  });
  await expect.poll(async () => (await imported(page)).objectId).not.toBeNull();
  const shape = await imported(page);
  // Key the empty: y 3 → 4 over two seconds.
  await page.evaluate((empty) => {
    const d = (
      window as unknown as { __basher_dag: { getState: () => { dispatch: (op: unknown) => void } } }
    ).__basher_dag.getState();
    d.dispatch({
      type: 'addNode',
      nodeId: `${empty}_position_channel`,
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target: empty,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 3, 0], easing: 'linear' },
          { time: 2, value: [0, 4, 0], easing: 'linear' },
        ],
      },
    });
  }, shape.parentId!);

  const projectId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  expect(projectId).not.toBeNull();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(
      () =>
        page.evaluate(async (path) => {
          const w = window as unknown as W;
          if (!(await w.__basher_opfs!.exists(path))) return false;
          return new TextDecoder()
            .decode(await w.__basher_opfs!.read(path))
            .includes('_position_channel');
        }, `projects/${projectId}/project.json`),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.reload();
  await waitForEditor(page);
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
  for (const [t, y] of [
    [1, 3.5],
    [0, 3],
    [2, 4],
  ] as const) {
    await page.evaluate((s) => (window as unknown as W).__basher_time!.getState().setTime(s), t);
    await expect
      .poll(async () =>
        (await drawnMeshWorld(page, shape.importGroupId!))?.map((v) => +v.toFixed(4)),
      )
      .toEqual([1, y, 0]);
  }
  expect(errors, 'no page error: the editor stayed up').toEqual([]);
});
