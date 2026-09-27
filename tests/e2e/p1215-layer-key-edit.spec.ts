// #1215 — a character's keys are edited where they live: bake a bound motion to keys, then drag one
// key along its row in the dopesheet, and the drawn skin changes at that time and nowhere else. One
// undo puts the key, the bone and the skin back.
//
// Subject: skinned-bar.glb through the product's native reader (`buildNativeGltfImportOps`), dispatched directly; the product road itself is p1205's,
// the two-joint swing bound onto it and baked at every pose: Bone1 keyed 0° / 45° / 90°
// at 0 / 0.5 / 1 s. Dragging the 0.5 s key to 0.75 s makes Bone1 at 0.5 s a third of the way to 45°
// (30°), so the bar bends less there; at 0 s and 1 s the keys did not move.
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

// The dopesheet's geometry, as p7.1-keyframe-retime.spec.ts derives it from `keyframeToRect`.
const LABEL_GUTTER = 84;
const DIAMOND = 10;
const INSET = 4;
const RULER_H = 17;
const ROW_H = 24;
function diamondCx(t: number, durationSeconds: number, canvasW: number): number {
  const trackWidth = Math.max(canvasW - LABEL_GUTTER, 0);
  const span = Math.max(durationSeconds, 0.0001);
  const inset = Math.max(INSET, DIAMOND / 2);
  const innerW = trackWidth - 2 * inset;
  const tt = Math.min(Math.max(t, 0), span);
  return innerW > 0
    ? LABEL_GUTTER + inset + (tt / span) * innerW
    : LABEL_GUTTER + (tt / span) * trackWidth;
}

test('#1215 — dragging a baked key in the dopesheet moves the skin at that time only; undo restores', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const { armature, layer } = await page.evaluate(async (bvh) => {
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
      assetRef: 'user-imports/p1215b/skinned-bar.glb',
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
  const bone1Keys = () =>
    page.evaluate(
      (id) =>
        (
          (window as unknown as W).__basher_dag.getState().state.nodes[id].params.channels as {
            bone: string;
            component: string;
            keyframes: { time: number }[];
          }[]
        )
          .find((c) => c.bone === 'Bone1' && c.component === 'quaternion')!
          .keyframes.map((k) => Math.round(k.time * 1000) / 1000),
      layer,
    );

  expect(await bone1Keys()).toEqual([0, 0.5, 1]);
  const before = { 0: await drawnAt(0), 0.5: await drawnAt(0.5), 1: await drawnAt(1) };

  // The dopesheet: the Bone1 quaternion row of the baked layer, found by the canvas's own builders.
  await page.getByTestId('floating-toolbar-timeline').click();
  const canvas = page.getByTestId('timeline-canvas').locator('canvas');
  await expect(canvas).toBeVisible();
  const rowIndex = await page.evaluate(
    async ({ id, layerId }) => {
      const tc = await import('/src/timeline/TimelineCanvas.tsx');
      const clips = await import('/src/timeline/clipChannelRows.ts');
      const layers = await import('/src/timeline/layerChannelRows.ts');
      const nodes = (window as unknown as W).__basher_dag.getState().state.nodes as never;
      const rows = layers.appendLayerRows({
        baseRows: clips.appendSelectionClipRows({
          baseRows: tc.collectChannelRows(nodes),
          nodes,
          selectedNodeId: id,
        }),
        nodes,
        selectedNodeId: id,
      });
      const want = layers.layerRowId({ layerId, bone: 'Bone1', component: 'quaternion' });
      return rows.findIndex((r) => r.channelId === want);
    },
    { id: armature, layerId: layer },
  );
  expect(rowIndex, 'the baked Bone1 curve has a row').toBeGreaterThanOrEqual(0);
  const box = (await canvas.boundingBox())!;
  const rowY = box.y + RULER_H + rowIndex * ROW_H + ROW_H / 2;
  expect(rowY, 'the row is on screen').toBeLessThan(box.y + box.height);
  const duration = await page.evaluate(
    () => (window as unknown as W).__basher_time.getState().durationSeconds,
  );
  const fromX = box.x + diamondCx(0.5, duration, box.width);
  const toX = box.x + diamondCx(0.75, duration, box.width);
  await page.mouse.move(fromX, rowY);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(fromX + (toX - fromX) * (i / 8), rowY);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();

  await expect.poll(bone1Keys, { message: 'the key moved in the layer' }).not.toContain(0.5);
  const keys = await bone1Keys();
  expect(keys).toHaveLength(3);
  expect(Math.abs(keys[1] - 0.75), `moved to ~0.75 (got ${keys[1]})`).toBeLessThan(0.02);

  // The skin: less bent at 0.5 s; unchanged at 0 s and 1 s, whose keys did not move.
  expect(maxDiff(await drawnAt(0.5), before[0.5]), 'the skin moved at 0.5 s').toBeGreaterThan(0.05);
  expect(maxDiff(await drawnAt(0), before[0]), 'unchanged at 0 s').toBeLessThan(1e-4);
  expect(maxDiff(await drawnAt(1), before[1]), 'unchanged at 1 s').toBeLessThan(1e-4);

  // One undo: the key, and the skin at 0.5 s, are back.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect(await bone1Keys()).toEqual([0, 0.5, 1]);
  expect(maxDiff(await drawnAt(0.5), before[0.5]), 'restored at 0.5 s').toBeLessThan(1e-4);
});
