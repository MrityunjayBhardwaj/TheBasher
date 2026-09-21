// p1166 — a node moved by an NLA strip is READ where it is DRAWN.
//
// The renderer folds a node's bare channels, its placed Strips and its drivers
// (SceneFromDAG `useLayeredChannels`); the world read the gizmo stands on folded the bare channels
// alone, so a node moved only by a strip drew in one place while the gizmo sat on its static pose.
//
// Both sides are read off the running app: the drawn mesh's world position, and the gizmo proxy's.
// Each time step moves the mesh, so a gizmo that does not follow cannot pass by standing still.
//
// REF: src/app/resolveWorldTransform.ts (`drawnChannels`), src/app/layeredChannels.ts; issue #1166.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface W {
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_gizmo?: () => { position: number[] } | null;
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
  __basher_opfs?: { exists: (path: string) => Promise<boolean> };
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

async function dispatch(page: Page, ops: unknown[]) {
  await page.evaluate((ops) => {
    const d = (
      window as unknown as { __basher_dag: { getState: () => { dispatch: (op: unknown) => void } } }
    ).__basher_dag.getState();
    for (const op of ops) d.dispatch(op);
  }, ops);
}
/** An Action keying `target`'s position linearly `from` → `to` over 2 s, placed by a Strip. */
const stripped = (target: string, from: number[], to: number[]) => [
  {
    type: 'addNode',
    nodeId: `act_${target}`,
    nodeType: 'Action',
    params: {
      name: `act_${target}`,
      channels: [
        {
          valueType: 'vec3',
          paramPath: 'position',
          keyframes: [
            { time: 0, value: from },
            { time: 2, value: to },
          ],
        },
      ],
    },
  },
  {
    type: 'addNode',
    nodeId: `strip_${target}`,
    nodeType: 'Strip',
    params: { name: `strip_${target}`, action: `act_${target}`, target },
  },
  {
    type: 'addNode',
    nodeId: `trk_${target}`,
    nodeType: 'Track',
    params: { name: `trk_${target}`, strips: [`strip_${target}`], order: 0 },
  },
];

async function importNestedCube(page: Page) {
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
      (await fetch('/assets/nested-cube.gltf').then((r) => r.arrayBuffer())) as ArrayBuffer,
    );
    await w.__basher_ingestGltfFolder!([{ relativePath: 'nested-cube.gltf', bytes }], 'p1166');
  });
  await expect.poll(async () => (await imported(page)).objectId).not.toBeNull();
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
  return imported(page);
}

/** Step through time and demand the gizmo sit on the drawn mesh at each step. */
async function gizmoFollowsDraw(page: Page, groupId: string, drawn: Record<number, number[]>) {
  const checked: number[] = [];
  for (const [t, want] of Object.entries(drawn)) {
    await page.evaluate(
      (s) => (window as unknown as W).__basher_time!.getState().setTime(s),
      Number(t),
    );
    // The drawn mesh first: the claim is read == drawn, so the draw must be where the test says.
    await expect
      .poll(async () => (await drawnMeshWorld(page, groupId))?.map((v) => +v.toFixed(4)))
      .toEqual(want);
    await expect
      .poll(async () =>
        (await page.evaluate(() => (window as unknown as W).__basher_gizmo?.()?.position))?.map(
          (v) => +v.toFixed(4),
        ),
      )
      .toEqual(want);
    checked.push(Number(t));
  }
  expect(checked).toHaveLength(Object.keys(drawn).length);
}

test('#1166 — a two-object selection centres the gizmo on where the strip draws the box', async ({
  page,
}) => {
  // A single selection reads its own transform through the evaluated read, which already folds
  // strips, so a top-level box alone was never wrong. A selection of several seeds every member
  // from the world read — the box moved by a strip, and the light standing at (5, 5, 3).
  test.slow();
  await importNestedCube(page); // a fresh editor; the default box and light are the subjects
  await dispatch(page, stripped('n_box', [0, 0, 0], [4, 2, 0]));
  await page.evaluate(() =>
    (
      window as unknown as {
        __basher_selection: { getState: () => { selectMany: (ids: string[]) => void } };
      }
    ).__basher_selection
      .getState()
      .selectMany(['n_box', 'n_light']),
  );
  const checked: number[] = [];
  for (const [t, box] of [
    [1, [2, 1, 0]],
    [0, [0, 0, 0]],
    [2, [4, 2, 0]],
  ] as const) {
    await page.evaluate((s) => (window as unknown as W).__basher_time!.getState().setTime(s), t);
    await expect
      .poll(async () => (await drawnMeshWorld(page, 'n_box'))?.map((v) => +v.toFixed(4)))
      .toEqual([...box]);
    const mid = box.map((v, i) => +((v + [5, 5, 3][i]) / 2).toFixed(4));
    await expect
      .poll(async () =>
        (await page.evaluate(() => (window as unknown as W).__basher_gizmo?.()?.position))?.map(
          (v) => +v.toFixed(4),
        ),
      )
      .toEqual(mid);
    checked.push(t);
  }
  expect(checked).toHaveLength(3);
});

test('#1166 — the gizmo follows a nested object whose nested parent a strip moves', async ({
  page,
}) => {
  test.slow();
  const shape = await importNestedCube(page);
  await dispatch(page, stripped(shape.parentId!, [0, 3, 0], [0, 5, 0]));
  await page.evaluate(
    (id) => (window as unknown as W).__basher_selection!.getState().select(id),
    shape.objectId!,
  );
  await gizmoFollowsDraw(page, shape.importGroupId!, {
    1: [1, 4, 0],
    0: [1, 3, 0],
    2: [1, 5, 0],
  });
});
