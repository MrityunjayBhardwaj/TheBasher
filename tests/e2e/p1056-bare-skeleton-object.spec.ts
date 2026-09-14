// #1056 — a motion imported with no character stands in the scene as an Object of its own,
// and its bones are drawn, posed at the playhead.
//
// Every half is unit-tested — the ops, the socket, the collector, the scale — and none of that
// can say a director SEES the motion. Measured on `main` before this change, the same import on
// the same page drew nothing: the armature seam was never written at all. So the observation is
// the seam the helper publishes, fed by the real ingest road (the one drop, the picker and the
// library all funnel through).
//
// `soma-walk.bvh` rather than the two-frame `walk.bvh`: a real walk moves enough between two
// playhead times that "the pose follows the playhead" cannot pass on noise.

import { test, expect } from './_fixtures';

interface DagNode {
  type: string;
  params?: Record<string, unknown>;
  inputs: Record<string, unknown>;
}
interface Win {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, DagNode>; outputs: Record<string, { node: string }> };
      dispatch: (op: unknown) => unknown;
    };
  };
  __basher_time: { getState: () => { setTime: (seconds: number) => void } };
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
  __basher_armature?: {
    armatures: number;
    bones: number;
    matrices: number[][];
    skeletonObjects: { id: string; bones: number; clipCount: number; posed: boolean }[];
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Win;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_ingestBvhFile);
  });
});

/** Import the walk alone and return the skeleton Object's id once the helper draws it. */
async function importWalkAlone(page: import('@playwright/test').Page): Promise<string> {
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    w.__basher_time.getState().setTime(0);
    const bytes = new Uint8Array(
      await fetch('/fixtures/anim/soma-walk.bvh').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestBvhFile!(bytes, 'soma-walk');
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Win).__basher_armature?.skeletonObjects?.length ?? 0,
      ),
    )
    .toBe(1);
  return page.evaluate(() => (window as unknown as Win).__basher_armature!.skeletonObjects[0].id);
}

/** The skeleton Object's drawn bone matrices (it is the only rig in the default project). */
function boneMatrices(page: import('@playwright/test').Page): Promise<number[][]> {
  return page.evaluate(() => (window as unknown as Win).__basher_armature?.matrices ?? []);
}

test('#1056 — a BVH imported alone stands as an Object pointed at its skeleton, and draws its bones', async ({
  page,
}) => {
  // The before-state this issue measured: nothing drawn.
  expect(await page.evaluate(() => (window as unknown as Win).__basher_armature?.bones ?? 0)).toBe(
    0,
  );

  const objectId = await importWalkAlone(page);

  const graph = await page.evaluate((id) => {
    const { state } = (window as unknown as Win).__basher_dag.getState();
    const obj = state.nodes[id];
    const dataRef = obj?.inputs.data as { node?: string } | undefined;
    const scene = state.nodes[state.outputs.scene.node];
    const children = (scene?.inputs.children as { node: string }[] | undefined) ?? [];
    const types = Object.values(state.nodes).map((n) => n.type);
    return {
      objectType: obj?.type,
      dataType: dataRef?.node ? state.nodes[dataRef.node]?.type : undefined,
      inScene: children.some((c) => c.node === id),
      scale: obj?.params?.scale as number[] | undefined,
      gltfAssets: types.filter((t) => t === 'GltfAsset').length,
    };
  }, objectId);
  expect(graph.objectType).toBe('Object');
  expect(graph.dataType).toBe('Skeleton');
  expect(graph.inScene).toBe(true);
  // Motion, not a model — the p7.14 rule still holds with an Object added.
  expect(graph.gltfAssets).toBe(0);
  // The unit was unknown, so the rig was stood at human height rather than left at file scale.
  expect(graph.scale?.[0]).not.toBe(1);

  const [rig] = await page.evaluate(
    () => (window as unknown as Win).__basher_armature!.skeletonObjects,
  );
  expect(rig.bones).toBeGreaterThan(10);
  expect(rig.clipCount).toBe(1);
  expect(rig.posed).toBe(true);
});

test('#1056 — the skeleton Object is posed at the playhead', async ({ page }) => {
  await importWalkAlone(page);
  const atZero = await boneMatrices(page);
  expect(atZero.length).toBeGreaterThan(10);

  await page.evaluate(() => (window as unknown as Win).__basher_time.getState().setTime(0.5));
  await expect
    .poll(async () => {
      const now = await boneMatrices(page);
      let maxDelta = 0;
      for (let i = 0; i < Math.min(now.length, atZero.length); i++) {
        for (let k = 0; k < 16; k++)
          maxDelta = Math.max(maxDelta, Math.abs(now[i][k] - atZero[i][k]));
      }
      return maxDelta;
    })
    .toBeGreaterThan(1e-3);
});

test('#1056 — moving the Object moves its bones with it', async ({ page }) => {
  const objectId = await importWalkAlone(page);
  // The head of the last bone drawn — any bone works; translation is the matrix's 13th–15th.
  const before = (await boneMatrices(page)).at(-1)!;

  await page.evaluate((id) => {
    const w = window as unknown as Win;
    w.__basher_dag.getState().dispatch({
      type: 'setParam',
      nodeId: id,
      paramPath: 'position',
      value: [2, 0, 0],
    });
  }, objectId);

  await expect
    .poll(async () => ((await boneMatrices(page)).at(-1)?.[12] ?? 0) - before[12])
    .toBeCloseTo(2, 2);
  const after = (await boneMatrices(page)).at(-1)!;
  expect(after[13]).toBeCloseTo(before[13], 4);
  expect(after[14]).toBeCloseTo(before[14], 4);
});
