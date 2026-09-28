// #1215 — a character's layer curve opens in the graph editor and a key dragged there lands in the
// layer: the drawn skin changes at that key's time and nowhere else, and one undo puts it back.
//
// Subject: skinned-bar.glb through the product's native reader, dispatched directly (as p1215-layer-key-edit), the two-joint swing bound
// onto it and baked at every pose (keys at 0 / 0.5 / 1 s). The baked layer's Bone0 position curve is
// opened in the graph editor and its 0.5 s key's Z dot dragged up: Bone0, and the whole bar with it,
// moves along Z at 0.5 s; at 0 s and 1 s the keys did not move.
import { test, expect } from './_fixtures';

interface Node {
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
      undo: () => unknown;
    };
  };
  __basher_time: {
    getState: () => { setTime: (s: number) => void; durationSeconds: number };
  };
  __basher_gltf_skin?: () => {
    count: number;
    rest: (i: number) => [number, number, number];
    vertex: (i: number) => [number, number, number];
  } | null;
}

const SWING = `HIERARCHY
ROOT Bone0
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Bone1
  {
    OFFSET 0 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 1 0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
0 0 0 0 0 0 45 0 0
0 0 0 0 0 0 90 0 0
`;

test('#1215 — dragging a baked key in the graph editor moves the skin at that time only; undo restores', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const { layer } = await page.evaluate(async (bvh) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const bvhChain = await import('/src/core/import/bvhImportChain.ts');
    const standing = await import('/src/core/import/skeletonObject.ts');
    const bind = await import('/src/app/asset/bindMotionToCharacter.ts');
    const bake = await import('/src/app/animate/bakePose.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = () => w.__basher_dag.getState();
    const scene = dag().state.outputs.scene!.node;
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1215c/skinned-bar.glb',
      sceneNodeId: scene,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag().dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const motion = bvhChain.buildBvhImportOps({
      text: bvh,
      name: 'swing',
      ids: { skeleton: 'swing_skel', layer: 'swing_motion' },
    });
    dag().dispatchAtomic(motion.ops, 'user', 'import bvh');
    const stand = standing.buildSkeletonObjectOps({
      skeletonId: 'swing_skel',
      bones: dag().state.nodes.swing_skel.params.bones as never,
      sceneNodeId: scene,
      normalise: false,
      name: 'swing',
      pose: { node: 'swing_motion', socket: 'out' },
      nameFollowsClip: false,
    });
    dag().dispatchAtomic(stand.ops, 'user', 'stand the motion');
    selection.useSelectionStore.getState().select(null);
    const bound = bind.bindMotionToCharacter(
      { motionId: 'swing_motion', skeletonId: 'swing_skel' },
      'imported',
    );
    if (!bound.ok) throw new Error(JSON.stringify(bound));
    const nodes = dag().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const id = (nodes[modifier].inputs.armature as { node: string }).node;
    const layerId = bake.freeBakedLayerId(dag().state as never, id);
    const baked = bake.bakePose(dag().state as never, {
      object: id,
      poses: { kind: 'every' },
      interpolation: 'linear',
      layerId,
    });
    if (!baked.ok) throw new Error(baked.reason);
    dag().dispatchAtomic([...baked.ops], 'user', 'bake');
    selection.useSelectionStore.getState().select(id);
    return { armature: id, layer: layerId };
  }, SWING);

  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      message: 'the bar is drawn skinned',
      timeout: 10_000,
    })
    .toBe(true);

  const drawnAt = async (seconds: number) => {
    await page.evaluate(
      (s) => (window as unknown as W).__basher_time.getState().setTime(s),
      seconds,
    );
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    return page.evaluate(() => {
      const s = (window as unknown as W).__basher_gltf_skin!()!;
      return Array.from({ length: s.count }, (_, i) => s.vertex(i));
    });
  };
  const maxDiff = (a: number[][], b: number[][]) =>
    Math.max(...a.map((v, i) => Math.max(...v.map((c, k) => Math.abs(c - b[i][k])))));
  const bone0Keys = () =>
    page.evaluate(
      (id) =>
        (
          (window as unknown as W).__basher_dag.getState().state.nodes[id].params.channels as {
            bone: string;
            component: string;
            keyframes: { time: number; value: number[] }[];
          }[]
        )
          .find((c) => c.bone === 'Bone0' && c.component === 'position')!
          .keyframes.map((k) => ({ t: Math.round(k.time * 1000) / 1000, z: k.value[2] })),
      layer,
    );

  const keysBefore = await bone0Keys();
  expect(keysBefore.map((k) => k.t)).toEqual([0, 0.5, 1]);
  const before = { 0: await drawnAt(0), 0.5: await drawnAt(0.5), 1: await drawnAt(1) };

  // The graph editor, on the baked layer's Bone0 position row.
  await page.evaluate(
    async ({ layerId }) => {
      const layers = await import('/src/timeline/layerChannelRows.ts');
      const viewport = await import('/src/app/stores/viewportStore.ts');
      const dock = await import('/src/app/stores/timelineDockStore.ts');
      const sel = await import('/src/timeline/timelineSelection.ts');
      viewport.useViewportStore.getState().setTimelineDrawerOpen(true);
      dock.useTimelineDockStore.getState().setActiveTab('curve');
      sel.useTimelineSelection
        .getState()
        .setActiveChannel(layers.layerRowId({ layerId, bone: 'Bone0', component: 'position' }));
    },
    { layerId: layer },
  );
  await expect(page.getByTestId('curve-track-1'), 'the layer row opens as a curve').toBeAttached();
  const dot = page.getByTestId('curve-key-1-2'); // the 0.5 s key, Z axis (drawn on top of X and Y, which share its value)
  await expect(dot).toBeVisible();
  const box = (await dot.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 40, { steps: 6 });
  await page.mouse.up();

  await expect
    .poll(async () => (await bone0Keys())[1].z, { message: 'the key rose in the layer' })
    .toBeGreaterThan(keysBefore[1].z + 0.05);
  const keys = await bone0Keys();
  expect(
    keys.map((k) => k.t),
    'a drag moves a key, never inserts one',
  ).toHaveLength(3);
  expect(Math.abs(keys[1].t - 0.5), 'a vertical drag keeps the time').toBeLessThan(0.02);

  // The skin: risen at 0.5 s; unchanged at 0 s and 1 s, whose keys did not move.
  expect(maxDiff(await drawnAt(0.5), before[0.5]), 'the skin moved at 0.5 s').toBeGreaterThan(0.05);
  expect(maxDiff(await drawnAt(0), before[0]), 'unchanged at 0 s').toBeLessThan(1e-4);
  expect(maxDiff(await drawnAt(1), before[1]), 'unchanged at 1 s').toBeLessThan(1e-4);

  // One undo: the key, and the skin at 0.5 s, are back.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect(await bone0Keys()).toEqual(keysBefore);
  expect(maxDiff(await drawnAt(0.5), before[0.5]), 'restored at 0.5 s').toBeLessThan(1e-4);
});
