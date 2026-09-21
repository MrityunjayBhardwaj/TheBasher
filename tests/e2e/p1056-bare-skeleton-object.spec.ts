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
  meta?: { hidden?: boolean };
}
interface Win {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, DagNode>; outputs: Record<string, { node: string }> };
      dispatch: (op: unknown) => unknown;
      undo: () => unknown;
    };
  };
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_gltf_skin?: () => unknown;
  __basher_time: { getState: () => { setTime: (seconds: number) => void } };
  __basher_selection: { getState: () => { selectedNodeId: string | null } };
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
    const bytes = new Uint8Array(await (await fetch('/fixtures/anim/soma-walk.bvh')).arrayBuffer());
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
  // #791 — BVH declares no unit, so the rig stands at the file's own size and nothing guesses
  // one from the content (Blender's BVH importer: Scale defaults to 1.0, no detection).
  expect(graph.scale).toEqual([1, 1, 1]);

  const [rig] = await page.evaluate(
    () => (window as unknown as Win).__basher_armature!.skeletonObjects,
  );
  expect(rig.bones).toBeGreaterThan(10);
  expect(rig.clipCount).toBe(1);
  expect(rig.posed).toBe(true);

  // …drawn at the file's size, read off the drawn bones rather than the scale param: SOMA is
  // authored in centimetres and its walk's frame 0 stands ~161 units tall. Bone heads, so the
  // top end site is not counted.
  const drawnHeight = async (): Promise<number> => {
    const heads = (await boneMatrices(page)).map((m) => m[13]);
    return Math.max(...heads) - Math.min(...heads);
  };
  const atFileScale = await drawnHeight();
  expect(atFileScale).toBeGreaterThan(100);
  expect(atFileScale).toBeLessThan(250);

  // #791 — the import selects the Object, so its Scale is in the inspector the moment it lands:
  // the drop road's equivalent of the reference's import-dialog field.
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Win).__basher_selection.getState().selectedNodeId),
    )
    .toBe(objectId);
  const scaleX = page.getByTestId(`inspector-vec-${objectId}-scale-x`);
  await expect(scaleX).toBeVisible();
  await expect(scaleX).toHaveValue('1');

  // …and that field is the fix: a centimetre file set to 0.01 stands at the size of a person.
  // The uniform-scale write goes through the graph so all three axes move together.
  await page.evaluate((id) => {
    (window as unknown as Win).__basher_dag
      .getState()
      .dispatch({ type: 'setParam', nodeId: id, paramPath: 'scale', value: [0.01, 0.01, 0.01] });
  }, objectId);
  await expect(scaleX).toHaveValue('0.01');
  await expect.poll(drawnHeight).toBeGreaterThan(1.4);
  expect(await drawnHeight()).toBeLessThan(2.1);
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

test('#1056 — a motion dropped onto a character still gets its Object, hidden by the bind, and one undo shows it', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.waitForFunction(
    () => {
      const w = window as unknown as Win;
      return Boolean(w.__basher_importGltf && w.__basher_writeOpfsBytes);
    },
    { timeout: 60_000 },
  );
  // The stand-in character — the bind needs something to choose.
  await page.evaluate(async () => {
    const w = window as unknown as Win;
    const ref = 'fixtures/rig/standin-character.glb';
    const buf = await (await fetch(`/${ref}`)).arrayBuffer();
    await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
    await w.__basher_importGltf!(buf, ref);
  });
  await page.waitForFunction(
    () => {
      const w = window as unknown as Win;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    { timeout: 120_000 },
  );

  const landed = await page.evaluate(async () => {
    const w = window as unknown as Win;
    const before = new Set(Object.keys(w.__basher_dag.getState().state.nodes));
    const bytes = new Uint8Array(await (await fetch('/fixtures/anim/soma-walk.bvh')).arrayBuffer());
    await w.__basher_ingestBvhFile!(bytes, 'soma-walk');
    const { nodes } = w.__basher_dag.getState().state;
    const added = Object.keys(nodes).filter((id) => !before.has(id));
    const objectId = added.find((id) => {
      const data = nodes[id].inputs.data as { node?: string } | undefined;
      return nodes[id].type === 'Object' && !!data?.node && nodes[data.node]?.type === 'Skeleton';
    });
    return {
      objectId,
      retargets: added.filter((id) => nodes[id].type === 'RetargetClip').length,
      hidden: objectId ? nodes[objectId].meta?.hidden === true : null,
    };
  });
  // The bind happened — otherwise a hidden-or-not reading below says nothing about binding.
  expect(landed.retargets).toBe(1);
  // The import did not ask whether a character was there: the Object exists regardless…
  expect(landed.objectId).toBeDefined();
  // …and the bind hid it, so no second rig stands beside the character.
  expect(landed.hidden).toBe(true);
  // -1 when the seam was never written: a missing band must not read as "nothing drawn".
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Win).__basher_armature?.skeletonObjects?.length ?? -1,
      ),
    )
    .toBe(0);

  // One undo takes the bind, and with it the hide.
  await page.evaluate(() => (window as unknown as Win).__basher_dag.getState().undo());
  const afterUndo = await page.evaluate((id) => {
    const { nodes } = (window as unknown as Win).__basher_dag.getState().state;
    return {
      retargets: Object.values(nodes).filter((n) => n.type === 'RetargetClip').length,
      exists: Boolean(nodes[id]),
      hidden: nodes[id]?.meta?.hidden === true,
    };
  }, landed.objectId!);
  expect(afterUndo).toEqual({ retargets: 0, exists: true, hidden: false });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Win).__basher_armature?.skeletonObjects?.length ?? -1,
      ),
    )
    .toBe(1);
});
