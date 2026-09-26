// #1215 — a pose layer's curve mutes as an F-curve does, from the dopesheet's gutter M and the
// toolbar's Mute alike; it has no solo. Blender skips a muted F-curve when it evaluates
// (`anim_sys.cc:341`, `:768`), and an F-curve has no solo (the layer does).
//
// Subject: skinned-bar.glb through the product's native reader, dispatched directly, the two-joint swing bound and baked at every pose
// (Bone1 0° / 45° / 90° at 0 / 0.5 / 1 s), as p1215-layer-key-edit. Muting the baked Bone1 curve
// drops Bone1 to what arrives from below — the skeleton's rest, which is the swing's 0 s pose — so
// the skin at 0.5 s draws as it did at 0 s.
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

// The gutter glyph bands, as p263b-gutter-glyph derives them: M [58, 71), S [71, 84) CSS px.
const RULER_H = 17;
const ROW_H = 24;
const M_X = 64;
const S_X = 77;

test('#1215 — a layer row’s gutter M mutes its curve (the skin drops to what is below), S does nothing, the toolbar agrees', async ({
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
      assetRef: 'user-imports/p1215f/skinned-bar.glb',
      sceneNodeId: scene,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag().dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const motion = bvhChain.buildBvhImportOps({
      text: bvh,
      name: 'swing',
      ids: { skeleton: 'swing_skel', clip: 'swing_clip' },
    });
    dag().dispatchAtomic(motion.ops, 'user', 'import bvh');
    const stand = standing.buildSkeletonObjectOps({
      skeletonId: 'swing_skel',
      bones: dag().state.nodes.swing_skel.params.bones as never,
      sceneNodeId: scene,
      normalise: false,
      name: 'swing',
      clipId: 'swing_clip',
      nameFollowsClip: true,
    });
    dag().dispatchAtomic(stand.ops, 'user', 'stand the motion');
    selection.useSelectionStore.getState().select(null);
    const bound = bind.bindMotionToCharacter(
      { clipId: 'swing_clip', skeletonId: 'swing_skel' },
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
  const bone1Muted = () =>
    page.evaluate(
      (id) =>
        (
          (window as unknown as W).__basher_dag.getState().state.nodes[id].params.channels as {
            bone: string;
            component: string;
            mute?: boolean;
          }[]
        ).find((c) => c.bone === 'Bone1' && c.component === 'quaternion')!.mute === true,
      layer,
    );
  const nodesJson = () =>
    page.evaluate(() =>
      JSON.stringify((window as unknown as W).__basher_dag.getState().state.nodes),
    );

  expect(await bone1Muted()).toBe(false);
  const before = { 0: await drawnAt(0), 0.5: await drawnAt(0.5) };
  expect(maxDiff(before[0.5], before[0]), 'the swing bends the bar at 0.5 s').toBeGreaterThan(0.05);

  await page.getByTestId('floating-toolbar-timeline').click();
  const canvas = page.getByTestId('timeline-canvas').locator('canvas');
  await expect(canvas).toBeVisible();
  const { rowIndex, rowId } = await page.evaluate(
    async ({ id, layerId }) => {
      const tc = await import('/src/timeline/TimelineCanvas.tsx');
      const clips = await import('/src/timeline/clipChannelRows.ts');
      const layers = await import('/src/timeline/layerChannelRows.ts');
      const state = (window as unknown as W).__basher_dag.getState().state as never as {
        nodes: never;
      };
      const nodes = state.nodes;
      const rows = layers.appendComputedSourceRows({
        baseRows: layers.appendLayerRows({
          baseRows: clips.appendSelectionClipRows({
            baseRows: tc.collectChannelRows(nodes),
            nodes,
            selectedNodeId: id,
          }),
          nodes,
          selectedNodeId: id,
        }),
        state: state as never,
        selectedNodeId: id,
      });
      const want = layers.layerRowId({ layerId, bone: 'Bone1', component: 'quaternion' });
      return { rowIndex: rows.findIndex((r) => r.channelId === want), rowId: want };
    },
    { id: armature, layerId: layer },
  );
  expect(rowIndex, 'the baked Bone1 curve has a row').toBeGreaterThanOrEqual(0);
  const box = (await canvas.boundingBox())!;
  const rowY = box.y + RULER_H + rowIndex * ROW_H + ROW_H / 2;

  // S first: a layer curve has no solo — the click changes nothing.
  const untouched = await nodesJson();
  await page.mouse.click(box.x + S_X, rowY);
  expect(await nodesJson(), 'S on a layer row flips nothing').toBe(untouched);

  // M: the curve is muted in its layer, and the skin at 0.5 s draws as at 0 s.
  await page.mouse.click(box.x + M_X, rowY);
  await expect.poll(bone1Muted, { message: 'the curve is muted' }).toBe(true);
  expect(maxDiff(await drawnAt(0.5), before[0]), 'muted: Bone1 at rest at 0.5 s').toBeLessThan(
    1e-4,
  );

  // The toolbar reads the same flag on the active row; its Solo is unavailable there.
  await page.evaluate(async (row) => {
    const sel = await import('/src/timeline/timelineSelection.ts');
    sel.useTimelineSelection.getState().setActiveChannel(row);
  }, rowId);
  const mute = page.getByTestId('timeline-toolbar-mute');
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('timeline-toolbar-solo')).toBeDisabled();
  await mute.click();
  await expect.poll(bone1Muted, { message: 'the toolbar unmutes it' }).toBe(false);
  expect(maxDiff(await drawnAt(0.5), before[0.5]), 'unmuted: the bend is back').toBeLessThan(1e-4);

  // Undo the unmute: muted again, as the gutter left it.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect(await bone1Muted()).toBe(true);
});
