// #1215 — a character's computed motion shows in the dopesheet read-only until it is baked: a bound
// retarget draws a row per bone × position / quaternion / scale with a key at each pose, a drag on one
// of those keys edits nothing, and the graph editor names the bake as the way to edit. After "bake
// motion to keys" in the inspector the read-only rows are gone and the baked layer's editable rows
// stand in their place, key for key.
//
// Subject: skinned-bar.glb through the test door (as p1215-layer-key-edit), the two-joint swing (3
// poses, 0.5 s apart) bound onto it and NOT baked.
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

test('#1215 — a bound retarget shows read-only in the dopesheet until baked; the bake stands editable rows in its place', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const { armature } = await page.evaluate(async (bvh) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const bvhChain = await import('/src/core/import/bvhImportChain.ts');
    const standing = await import('/src/core/import/skeletonObject.ts');
    const bind = await import('/src/app/asset/bindMotionToCharacter.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = () => w.__basher_dag.getState();
    const scene = dag().state.outputs.scene!.node;
    const result = await native.__buildSkinnedNativeGltfImportOpsForTests({
      buffer,
      assetRef: 'user-imports/p1215d/skinned-bar.glb',
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
    selection.useSelectionStore.getState().select(id);
    return { armature: id };
  }, SWING);

  // The rows the dopesheet should draw, from its own builders; the computed ones by their id form.
  const rowIds = () =>
    page.evaluate(async (id) => {
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
            baseRows: clips.appendAnimationClipRows({
              baseRows: tc.collectChannelRows(nodes),
              nodes,
            }),
            nodes,
            selectedNodeId: id,
          }),
          nodes,
          selectedNodeId: id,
        }),
        state: state as never,
        selectedNodeId: id,
      });
      return rows.map((r) => ({
        id: r.channelId,
        computed: layers.isComputedRowId(r.channelId),
        readOnly: r.readOnly === true,
        mute: r.mute === true,
        times: r.keyframes.map((k) => Math.round(k.time * 1000) / 1000),
        name: r.name,
      }));
    }, armature);

  await page.getByTestId('floating-toolbar-timeline').click();
  const host = page.getByTestId('timeline-canvas');
  const canvas = host.locator('canvas');
  await expect(canvas).toBeVisible();

  const rows = await rowIds();
  const computed = rows.filter((r) => r.computed);
  expect(computed.map((r) => r.name.split(' — ')[1])).toEqual([
    'Bone0 position',
    'Bone0 quaternion',
    'Bone0 scale',
    'Bone1 position',
    'Bone1 quaternion',
    'Bone1 scale',
  ]);
  for (const r of computed) {
    expect(r.readOnly, r.name).toBe(true);
    expect(r.times).toEqual([0, 0.5, 1]);
  }
  // Drawn: the canvas holds every row, computed ones included, and paints their keys.
  await expect(host).toHaveAttribute('data-channel-count', String(rows.length));
  const drawnKeys = Number(await host.getAttribute('data-rendered-keyframes'));
  expect(drawnKeys, "the computed rows' keys are painted").toBeGreaterThanOrEqual(
    computed.length * 3,
  );

  // A drag on a computed key edits nothing: no op lands.
  const before = await page.evaluate(() =>
    JSON.stringify((window as unknown as W).__basher_dag.getState().state.nodes),
  );
  const rowIndex = rows.findIndex((r) => r.name.endsWith('Bone1 quaternion') && r.computed);
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
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as unknown as W).__basher_dag.getState().state.nodes),
    ),
    'a read-only key cannot be dragged',
  ).toBe(before);

  // The graph editor on that row names the bake.
  await page.evaluate(async (rowId) => {
    const dock = await import('/src/app/stores/timelineDockStore.ts');
    const sel = await import('/src/timeline/timelineSelection.ts');
    dock.useTimelineDockStore.getState().setActiveTab('curve');
    sel.useTimelineSelection.getState().setActiveChannel(rowId);
  }, computed[4].id);
  await expect(page.getByTestId('curve-editor')).toContainText('bake motion to keys');
  await page.evaluate(async () => {
    const dock = await import('/src/app/stores/timelineDockStore.ts');
    dock.useTimelineDockStore.getState().setActiveTab('dopesheet');
  });

  // Bake from the inspector: the computed rows go, the baked layer's editable rows take their place.
  await page.getByTestId('inspector-bake-pose-button').click();
  await expect(page.getByTestId('inspector-bake-pose-done')).toBeVisible();
  const after = await rowIds();
  expect(
    after.filter((r) => r.computed),
    'baked: nothing computed left to show',
  ).toEqual([]);
  // The baked layer: the live one (the file's own base is muted by the bind, and stays so).
  const editable = after.filter((r) => r.id.startsWith('layer:') && !r.readOnly && !r.mute);
  for (const r of computed) {
    const what = r.name.split(' — ')[1];
    const match = editable.find((e) => e.name.endsWith(what));
    expect(match, `an editable row for ${what}`).toBeDefined();
    expect(match!.times).toEqual(r.times);
  }
  await expect(host).toHaveAttribute('data-channel-count', String(after.length));
});
